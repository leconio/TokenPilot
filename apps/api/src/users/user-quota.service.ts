import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  AiuLedgerEntryType,
  AiuQuotaPolicyScope,
  AiuReservationStatus,
  Prisma,
  QuotaPeriodType,
  type DatabaseClient,
} from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import { quotaPeriodWindow } from "./quota-period.js";
import { resetUserQuotaSchema, saveUserQuotaSchema } from "./user.schemas.js";
import { aiuToMicros, userQuotaPeriodTypes } from "./user-presentation.js";

@Injectable()
export class ApplicationUserQuotaService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  private async requireUser(id: string) {
    const row = await this.database.applicationUser.findFirst({
      where: { applicationId: this.applicationId(), id },
      include: { quota: true },
    });
    if (row === null) throw new NotFoundException("User not found");
    return row;
  }

  async save(id: string, input: unknown): Promise<void> {
    const parsed = saveUserQuotaSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid AIU quota");
    const user = await this.requireUser(id);
    const applicationId = this.applicationId();
    const type = userQuotaPeriodTypes[parsed.data.period];
    const application = await this.database.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { timezone: true },
    });
    const window = quotaPeriodWindow(
      type,
      application.timezone,
      new Date(),
      parsed.data.period === "fixed"
        ? { start: new Date(parsed.data.starts_at!), end: new Date(parsed.data.ends_at!) }
        : undefined,
    );
    const limit = aiuToMicros(parsed.data.limit);
    const quota = await this.database.$transaction(async (transaction) => {
      const policy = await transaction.aiuQuotaPolicy.upsert({
        where: { applicationId_userId: { applicationId, userId: user.id } },
        create: {
          applicationId,
          scope: AiuQuotaPolicyScope.USER,
          userId: user.id,
          periodType: type,
          startsAt: parsed.data.period === "fixed" ? window.start : null,
          endsAt: parsed.data.period === "fixed" ? window.end : null,
          limitAiuMicros: limit,
          hardLimit: parsed.data.hard_limit,
        },
        update: {
          periodType: type,
          startsAt: parsed.data.period === "fixed" ? window.start : null,
          endsAt: parsed.data.period === "fixed" ? window.end : null,
          limitAiuMicros: limit,
          hardLimit: parsed.data.hard_limit,
          enabled: true,
        },
      });
      const saved = await transaction.userAiuQuota.upsert({
        where: { applicationId_userId: { applicationId, userId: user.id } },
        create: {
          applicationId,
          userId: user.id,
          policyId: policy.id,
          periodType: type,
          periodStart: window.start,
          periodEnd: window.end,
          limitAiuMicros: limit,
          hardLimit: parsed.data.hard_limit,
        },
        update: {
          policyId: policy.id,
          periodType: type,
          periodStart: window.start,
          periodEnd: window.end,
          limitAiuMicros: limit,
          hardLimit: parsed.data.hard_limit,
          lockVersion: { increment: 1 },
        },
      });
      await transaction.userAiuLedgerEntry.create({
        data: {
          applicationId,
          userId: user.id,
          quotaId: saved.id,
          entryType: AiuLedgerEntryType.GRANT,
          consumedAfterMicros: saved.consumedAiuMicros,
          reservedAfterMicros: saved.reservedAiuMicros,
          limitAfterMicros: saved.limitAiuMicros,
          idempotencyKey: `quota-setting:${randomUUID()}`,
          reason: "AIU quota updated",
        },
      });
      return saved;
    });
    await this.audit.record({
      action: "user.quota.update",
      objectType: "application_user",
      objectId: user.id,
      after: { limit_aiu_micros: quota.limitAiuMicros.toString(), hard_limit: quota.hardLimit },
      reason: "Updated AIU quota",
    });
  }

  async reset(id: string, input: unknown): Promise<void> {
    const parsed = resetUserQuotaSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Reset requires a reason");
    const user = await this.requireUser(id);
    if (user.quota === null) throw new NotFoundException("User has no AIU quota");
    const applicationId = this.applicationId();
    const start = new Date();
    const application = await this.database.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { timezone: true },
    });
    const window = quotaPeriodWindow(
      user.quota.periodType,
      application.timezone,
      start,
      user.quota.periodType === QuotaPeriodType.FIXED_WINDOW && user.quota.periodEnd !== null
        ? { start: user.quota.periodStart, end: user.quota.periodEnd }
        : undefined,
    );
    await this.database.$transaction(
      async (transaction) => {
        await transaction.userAiuReservation.updateMany({
          where: { applicationId, userId: user.id, status: AiuReservationStatus.RESERVED },
          data: {
            status: AiuReservationStatus.RELEASED,
            releasedAt: start,
            lockVersion: { increment: 1 },
          },
        });
        const changed = await transaction.userAiuQuota.updateMany({
          where: { id: user.quota!.id, applicationId, lockVersion: user.quota!.lockVersion },
          data: {
            consumedAiuMicros: 0,
            reservedAiuMicros: 0,
            periodStart: window.start,
            periodEnd: window.end,
            lockVersion: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new ConflictException("Quota changed; retry the reset");
        await transaction.userAiuLedgerEntry.create({
          data: {
            applicationId,
            userId: user.id,
            quotaId: user.quota!.id,
            entryType: AiuLedgerEntryType.ADJUSTMENT,
            consumedDeltaMicros: -user.quota!.consumedAiuMicros,
            reservedDeltaMicros: -user.quota!.reservedAiuMicros,
            consumedAfterMicros: 0,
            reservedAfterMicros: 0,
            limitAfterMicros: user.quota!.limitAiuMicros,
            idempotencyKey: `quota-reset:${randomUUID()}`,
            reason: parsed.data.reason,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.audit.record({
      action: "user.quota.reset",
      objectType: "application_user",
      objectId: user.id,
      before: {
        used_aiu_micros: user.quota.consumedAiuMicros.toString(),
        reserved_aiu_micros: user.quota.reservedAiuMicros.toString(),
      },
      after: { used_aiu_micros: "0", reserved_aiu_micros: "0" },
      reason: parsed.data.reason,
    });
  }

  async ledger(id: string, limit = 100) {
    await this.requireUser(id);
    const rows = await this.database.userAiuLedgerEntry.findMany({
      where: { applicationId: this.applicationId(), userId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return {
      entries: rows.map((row) => ({
        id: row.id,
        type: row.entryType.toLowerCase(),
        used_change_aiu_micros: row.consumedDeltaMicros.toString(),
        reserved_change_aiu_micros: row.reservedDeltaMicros.toString(),
        used_after_aiu_micros: row.consumedAfterMicros.toString(),
        reserved_after_aiu_micros: row.reservedAfterMicros.toString(),
        limit_after_aiu_micros: row.limitAfterMicros.toString(),
        reason: row.reason,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }
}
