import { ConflictException } from "@nestjs/common";

import {
  AiuLedgerEntryType,
  AiuReservationStatus,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import { quotaPeriodWindow } from "../users/quota-period.js";
import type { UserReservationClaims } from "./user-reservation-token.js";
import type { UserReservationTokenCodec } from "./user-reservation-token.js";

export type ReservationRow = Prisma.UserAiuReservationGetPayload<{ include: { quota: true } }>;
export type ReservationTransaction = Pick<
  DatabaseClient,
  | "applicationUser"
  | "userAiuQuota"
  | "userAiuReservation"
  | "userAiuLedgerEntry"
  | "auditLog"
  | "aiuQuotaPolicy"
  | "applicationUserGroup"
>;

export function retryableReservationConflict(): Error {
  return Object.assign(new Error("User quota changed concurrently"), { code: "P2034" });
}

export function remainingAiu(quota: {
  limitAiuMicros: bigint;
  consumedAiuMicros: bigint;
  reservedAiuMicros: bigint;
}): bigint {
  const value = quota.limitAiuMicros - quota.consumedAiuMicros - quota.reservedAiuMicros;
  return value > 0n ? value : 0n;
}

export function reservationClaims(row: {
  id: string;
  applicationId: string;
  userId: string;
  quotaId: string;
  operationId: string;
  virtualModel: string;
  candidateModelIdsJson?: Prisma.JsonValue;
  candidateModelIds?: string[];
  reservedAiuMicros: bigint;
  expiresAt: Date;
}): Omit<UserReservationClaims, "version" | "key_version"> {
  const raw = row.candidateModelIds ?? row.candidateModelIdsJson;
  const candidates = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string").sort()
    : [];
  return {
    reservation_id: row.id,
    application_id: row.applicationId,
    user_id: row.userId,
    quota_id: row.quotaId,
    operation_id: row.operationId,
    virtual_model: row.virtualModel,
    candidate_model_ids: candidates,
    reserved_aiu_micros: row.reservedAiuMicros.toString(),
    expires_at: row.expiresAt.toISOString(),
  };
}

export function assertReservationTokenLineage(
  codec: UserReservationTokenCodec,
  row: ReservationRow,
  claims: UserReservationClaims,
  token: string,
): void {
  if (
    codec.hash(token) !== row.tokenHash ||
    JSON.stringify(claims) !==
      JSON.stringify({
        version: "user-aiu-reservation-1",
        key_version: claims.key_version,
        ...reservationClaims(row),
      })
  ) {
    throw new ConflictException("Reservation token lineage is invalid");
  }
}

export function reservationUserSummary(userId: string, quota: ReservationRow["quota"] | null) {
  return {
    id: userId,
    limit_aiu_micros: quota?.limitAiuMicros.toString() ?? null,
    used_aiu_micros: quota?.consumedAiuMicros.toString() ?? "0",
    reserved_aiu_micros: quota?.reservedAiuMicros.toString() ?? "0",
    remaining_aiu_micros: quota === null ? null : remainingAiu(quota).toString(),
  };
}

export function reservationDenied(
  userId: string,
  reason: string,
  quota: ReservationRow["quota"] | null,
) {
  return { allowed: false, reason, user: reservationUserSummary(userId, quota), reservation: null };
}

export function reservationTransitionResult(
  row: Pick<ReservationRow, "id" | "status" | "settledAiuMicros" | "userId">,
  quota: ReservationRow["quota"],
) {
  return {
    reservation_id: row.id,
    status: row.status.toLowerCase(),
    settled_aiu_micros: row.settledAiuMicros.toString(),
    user: reservationUserSummary(row.userId, quota),
  };
}

export async function rolloverReservationQuota(
  transaction: ReservationTransaction,
  quota: NonNullable<ReservationRow["quota"]>,
  userId: string,
  applicationId: string,
  timezone: string,
) {
  if (quota.periodEnd === null || quota.periodEnd > new Date()) return quota;
  const start = new Date();
  const window = quotaPeriodWindow(quota.periodType, timezone, start);
  if (window.end === null) throw new ConflictException("A lifetime quota cannot expire");
  const changed = await transaction.userAiuQuota.updateMany({
    where: { id: quota.id, applicationId, lockVersion: quota.lockVersion },
    data: {
      consumedAiuMicros: 0,
      reservedAiuMicros: 0,
      periodStart: window.start,
      periodEnd: window.end,
      lockVersion: { increment: 1 },
    },
  });
  if (changed.count !== 1) throw retryableReservationConflict();
  await transaction.userAiuReservation.updateMany({
    where: { applicationId, quotaId: quota.id, status: AiuReservationStatus.RESERVED },
    data: {
      status: AiuReservationStatus.EXPIRED,
      releasedAt: new Date(),
      lockVersion: { increment: 1 },
    },
  });
  await transaction.userAiuLedgerEntry.create({
    data: {
      applicationId,
      userId,
      quotaId: quota.id,
      entryType: AiuLedgerEntryType.EXPIRE,
      consumedDeltaMicros: -quota.consumedAiuMicros,
      reservedDeltaMicros: -quota.reservedAiuMicros,
      consumedAfterMicros: 0,
      reservedAfterMicros: 0,
      limitAfterMicros: quota.limitAiuMicros,
      idempotencyKey: `user-quota:${quota.id}:period:${quota.periodEnd.toISOString()}`,
      reason: "AIU quota period renewed",
    },
  });
  return {
    ...quota,
    consumedAiuMicros: 0n,
    reservedAiuMicros: 0n,
    lockVersion: quota.lockVersion + 1,
    periodStart: window.start,
    periodEnd: window.end,
  };
}
