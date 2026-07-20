import { randomUUID } from "node:crypto";

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  AiuLedgerEntryType,
  AiuReservationStatus,
  ApplicationUserStatus,
  materializeEffectiveAiuQuotaPolicy,
  QuotaPeriodType,
  type AiuQuotaPolicyDatabase,
  type DatabaseClient,
} from "@tokenpilot/db";

import type { ApiConfiguration } from "../api-config.js";
import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { API_CONFIGURATION, DATABASE_CLIENT } from "../tokens.js";
import {
  parseUserReservation,
  parseUserReservationRelease,
  parseUserReservationSettlement,
  type UserReservationRequest,
} from "./user-reservation.schemas.js";
import {
  assertReservationTokenLineage,
  remainingAiu,
  reservationClaims,
  reservationDenied,
  reservationTransitionResult,
  reservationUserSummary,
  retryableReservationConflict,
  rolloverReservationQuota,
  type ReservationRow,
} from "./user-reservation-domain.js";
import { runReservationTransaction } from "./user-reservation-transaction.js";
import { UserReservationTokenCodec } from "./user-reservation-token.js";
import { quotaPeriodWindow } from "../users/quota-period.js";

@Injectable()
export class RuntimeUserReservationService {
  private readonly tokens: UserReservationTokenCodec;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(API_CONFIGURATION) configuration: ApiConfiguration,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tokens = new UserReservationTokenCodec(configuration);
    this.ttlSeconds = configuration.aiuReservationTtlSeconds ?? 300;
  }

  private readonly ttlSeconds: number;

  async create(input: unknown) {
    const request = parseUserReservation(input);
    const applicationId = this.applicationId();
    const application = await this.database.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { timezone: true },
    });
    const candidates = await this.resolveCandidates(applicationId, request);
    const user = await this.database.applicationUser.upsert({
      where: { applicationId_externalId: { applicationId, externalId: request.user_id } },
      create: {
        applicationId,
        externalId: request.user_id,
        name: request.display_user ?? null,
        propertiesJson: request.user_properties ?? {},
      },
      update: {
        ...(request.display_user === undefined ? {} : { name: request.display_user }),
        ...(request.user_properties === undefined
          ? {}
          : { propertiesJson: request.user_properties }),
        lastSeenAt: new Date(),
      },
    });
    if (user.status === ApplicationUserStatus.BLOCKED) {
      return reservationDenied(user.id, "user_blocked", null);
    }

    return runReservationTransaction(this.database, async (transaction) => {
      await materializeEffectiveAiuQuotaPolicy(transaction as unknown as AiuQuotaPolicyDatabase, {
        applicationId,
        userId: user.id,
        reason: "Applied the effective AIU quota rule before model access",
        window: (policy) =>
          policy.periodType === QuotaPeriodType.FIXED_WINDOW
            ? { start: policy.startsAt!, end: policy.endsAt! }
            : quotaPeriodWindow(policy.periodType, application.timezone, new Date()),
      });
      const current = await transaction.applicationUser.findFirst({
        where: { applicationId, id: user.id },
        include: { quota: true },
      });
      if (current === null) throw new NotFoundException("Application user not found");
      if (current.status === ApplicationUserStatus.BLOCKED) {
        return reservationDenied(current.id, "user_blocked", current.quota);
      }
      if (current.quota === null || !current.quota.enabled || !current.quota.hardLimit) {
        return {
          allowed: true,
          reason: current.quota === null ? "quota_not_set" : "quota_observed_only",
          user: reservationUserSummary(current.id, current.quota),
          reservation: null,
        };
      }
      if (
        current.quota.periodType === QuotaPeriodType.FIXED_WINDOW &&
        current.quota.periodEnd !== null &&
        current.quota.periodEnd <= new Date()
      ) {
        return reservationDenied(current.id, "quota_period_ended", current.quota);
      }
      const quota = await rolloverReservationQuota(
        transaction,
        current.quota,
        current.id,
        applicationId,
        application.timezone,
      );
      const existing = await transaction.userAiuReservation.findFirst({
        where: { applicationId, userId: current.id, operationId: request.operation_id },
        include: { quota: true },
      });
      if (existing !== null) return this.existing(existing, request, candidates);

      const estimate = BigInt(request.estimated_aiu_micros);
      if (estimate > remainingAiu(quota)) {
        return reservationDenied(current.id, "quota_exhausted", quota);
      }
      const now = new Date();
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1_000);
      const claims = reservationClaims({
        id,
        applicationId,
        userId: current.id,
        quotaId: quota.id,
        operationId: request.operation_id,
        virtualModel: request.virtual_model,
        candidateModelIds: candidates,
        reservedAiuMicros: estimate,
        expiresAt,
      });
      const token = this.tokens.sign(claims);
      const changed = await transaction.userAiuQuota.updateMany({
        where: { id: quota.id, applicationId, lockVersion: quota.lockVersion },
        data: { reservedAiuMicros: { increment: estimate }, lockVersion: { increment: 1 } },
      });
      if (changed.count !== 1) throw retryableReservationConflict();
      const created = await transaction.userAiuReservation.create({
        data: {
          id,
          applicationId,
          userId: current.id,
          quotaId: quota.id,
          operationId: request.operation_id,
          virtualModel: request.virtual_model,
          candidateModelIdsJson: candidates,
          estimatedAiuMicros: estimate,
          reservedAiuMicros: estimate,
          tokenHash: this.tokens.hash(token),
          expiresAt,
        },
      });
      const projectedReserved = quota.reservedAiuMicros + estimate;
      await transaction.userAiuLedgerEntry.create({
        data: {
          applicationId,
          userId: current.id,
          quotaId: quota.id,
          entryType: AiuLedgerEntryType.RESERVE,
          reservedDeltaMicros: estimate,
          consumedAfterMicros: quota.consumedAiuMicros,
          reservedAfterMicros: projectedReserved,
          limitAfterMicros: quota.limitAiuMicros,
          sourceReservationId: created.id,
          idempotencyKey: `user-reservation:${created.id}:reserve`,
          reason: "AIU reserved before model call",
        },
      });
      await this.audit.record(
        {
          action: "runtime.user_aiu.reserve",
          objectType: "application_user",
          objectId: current.id,
          after: { operation_id: request.operation_id, reserved_aiu_micros: estimate.toString() },
          reason: "Reserved AIU before model call",
        },
        transaction,
      );
      return {
        allowed: true,
        reason: "reserved",
        user: reservationUserSummary(current.id, {
          ...quota,
          reservedAiuMicros: projectedReserved,
        }),
        reservation: {
          id: created.id,
          token,
          reserved_aiu_micros: estimate.toString(),
          expires_at: expiresAt.toISOString(),
        },
      };
    });
  }

  async settle(id: string, input: unknown) {
    const request = parseUserReservationSettlement(input);
    return this.transition(
      id,
      request.reservation_token,
      "settle",
      BigInt(request.settled_aiu_micros),
    );
  }

  async release(id: string, input: unknown) {
    const request = parseUserReservationRelease(input);
    return this.transition(id, request.reservation_token, "release", 0n, request.reason);
  }

  private async transition(
    id: string,
    token: string,
    action: "settle" | "release",
    actual: bigint,
    reason = "AIU reservation settled",
  ) {
    const applicationId = this.applicationId();
    const verified = this.tokens.verify(token);
    if (verified.reservation_id !== id || verified.application_id !== applicationId) {
      throw new ConflictException("Reservation token does not match this application or path");
    }
    return runReservationTransaction(this.database, async (transaction) => {
      const row = await transaction.userAiuReservation.findFirst({
        where: { id, applicationId },
        include: { quota: true },
      });
      if (row === null) throw new NotFoundException("AIU reservation not found");
      assertReservationTokenLineage(this.tokens, row, verified, token);
      if (row.status === AiuReservationStatus.SETTLED) {
        if (action !== "settle" || row.settledAiuMicros !== actual) {
          throw new ConflictException("AIU reservation is already settled");
        }
        return reservationTransitionResult(row, row.quota);
      }
      if (row.status !== AiuReservationStatus.RESERVED) {
        if (action === "release") return reservationTransitionResult(row, row.quota);
        throw new ConflictException("AIU reservation is already closed");
      }
      const changed = await transaction.userAiuReservation.updateMany({
        where: {
          id,
          applicationId,
          lockVersion: row.lockVersion,
          status: AiuReservationStatus.RESERVED,
        },
        data:
          action === "settle"
            ? {
                status: AiuReservationStatus.SETTLED,
                settledAiuMicros: actual,
                settledAt: new Date(),
                lockVersion: { increment: 1 },
              }
            : {
                status: AiuReservationStatus.RELEASED,
                releasedAt: new Date(),
                lockVersion: { increment: 1 },
              },
      });
      if (changed.count !== 1) throw retryableReservationConflict();
      const quotaChanged = await transaction.userAiuQuota.updateMany({
        where: { id: row.quotaId, applicationId, lockVersion: row.quota.lockVersion },
        data: {
          reservedAiuMicros: { decrement: row.reservedAiuMicros },
          ...(action === "settle" ? { consumedAiuMicros: { increment: actual } } : {}),
          lockVersion: { increment: 1 },
        },
      });
      if (quotaChanged.count !== 1) throw retryableReservationConflict();
      const consumedAfter = row.quota.consumedAiuMicros + (action === "settle" ? actual : 0n);
      const reservedAfter = row.quota.reservedAiuMicros - row.reservedAiuMicros;
      await transaction.userAiuLedgerEntry.create({
        data: {
          applicationId,
          userId: row.userId,
          quotaId: row.quotaId,
          entryType:
            action === "settle"
              ? AiuLedgerEntryType.SETTLEMENT_DELTA
              : AiuLedgerEntryType.RESERVATION_RELEASE,
          consumedDeltaMicros: action === "settle" ? actual : 0n,
          reservedDeltaMicros: -row.reservedAiuMicros,
          consumedAfterMicros: consumedAfter,
          reservedAfterMicros: reservedAfter,
          limitAfterMicros: row.quota.limitAiuMicros,
          sourceReservationId: row.id,
          idempotencyKey: `user-reservation:${row.id}:${action}`,
          reason,
        },
      });
      const updated = {
        ...row,
        status: action === "settle" ? AiuReservationStatus.SETTLED : AiuReservationStatus.RELEASED,
        settledAiuMicros: action === "settle" ? actual : row.settledAiuMicros,
      };
      return reservationTransitionResult(updated, {
        ...row.quota,
        consumedAiuMicros: consumedAfter,
        reservedAiuMicros: reservedAfter,
      });
    });
  }

  private applicationId(): string {
    const value = this.context.current().applicationId;
    if (value === undefined) throw new ForbiddenException("An application context is required");
    return value;
  }

  private async resolveCandidates(applicationId: string, request: UserReservationRequest) {
    const model = await this.database.virtualModel.findFirst({
      where: { applicationId, name: request.virtual_model, enabled: true },
      include: {
        targets: { where: { enabled: true, model: { enabled: true } }, select: { modelId: true } },
      },
    });
    if (model === null) throw new NotFoundException("Virtual model is not available");
    const available = new Set(model.targets.map((target) => target.modelId));
    const requested = request.candidate_model_ids ?? [...available];
    if (requested.length === 0 || requested.some((id) => !available.has(id))) {
      throw new ConflictException("Reservation candidates do not belong to the virtual model");
    }
    return [...new Set(requested)].sort();
  }

  private existing(row: ReservationRow, request: UserReservationRequest, candidates: string[]) {
    const stored = Array.isArray(row.candidateModelIdsJson)
      ? row.candidateModelIdsJson
          .filter((value): value is string => typeof value === "string")
          .sort()
      : [];
    if (
      row.virtualModel !== request.virtual_model ||
      row.estimatedAiuMicros.toString() !== request.estimated_aiu_micros ||
      JSON.stringify(stored) !== JSON.stringify(candidates)
    ) {
      throw new ConflictException("Operation ID was already used for another reservation");
    }
    if (row.status !== AiuReservationStatus.RESERVED) {
      return reservationDenied(row.userId, "operation_already_closed", row.quota);
    }
    const token = this.tokens.sign(reservationClaims(row));
    if (this.tokens.hash(token) !== row.tokenHash) {
      throw new ConflictException("Reservation token lineage conflict");
    }
    return {
      allowed: true,
      reason: "reserved",
      user: reservationUserSummary(row.userId, row.quota),
      reservation: {
        id: row.id,
        token,
        reserved_aiu_micros: row.reservedAiuMicros.toString(),
        expires_at: row.expiresAt.toISOString(),
      },
    };
  }
}
