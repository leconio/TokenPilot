import {
  AiuLedgerEntryType,
  AiuReservationStatus,
  Prisma,
  type DatabaseClient,
} from "@tokenpilot/db";

function retryableConflict(): Error {
  return Object.assign(new Error("User AIU reservation changed concurrently"), { code: "P2034" });
}

export class UserAiuReservationSweeper {
  constructor(private readonly database: DatabaseClient) {}

  async sweep(limit: number, now: Date): Promise<number> {
    const rows = await this.database.userAiuReservation.findMany({
      where: { status: AiuReservationStatus.RESERVED, expiresAt: { lte: now } },
      select: { id: true, applicationId: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    let swept = 0;
    for (const row of rows) {
      if (await this.expire(row.applicationId, row.id, now)) swept += 1;
    }
    return swept;
  }

  private async expire(applicationId: string, id: string, now: Date): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const row = await transaction.userAiuReservation.findFirst({
              where: {
                id,
                applicationId,
                status: AiuReservationStatus.RESERVED,
                expiresAt: { lte: now },
              },
              include: { quota: true },
            });
            if (row === null) return false;
            const reservedAfter = row.quota.reservedAiuMicros - row.reservedAiuMicros;
            if (reservedAfter < 0n) {
              throw new TypeError("User AIU reserved balance is inconsistent");
            }
            const reservationChanged = await transaction.userAiuReservation.updateMany({
              where: {
                id: row.id,
                applicationId,
                status: AiuReservationStatus.RESERVED,
                lockVersion: row.lockVersion,
              },
              data: {
                status: AiuReservationStatus.EXPIRED,
                releasedAt: now,
                lockVersion: { increment: 1 },
              },
            });
            const quotaChanged = await transaction.userAiuQuota.updateMany({
              where: {
                id: row.quotaId,
                applicationId,
                lockVersion: row.quota.lockVersion,
              },
              data: {
                reservedAiuMicros: { decrement: row.reservedAiuMicros },
                lockVersion: { increment: 1 },
              },
            });
            if (reservationChanged.count !== 1 || quotaChanged.count !== 1) {
              throw retryableConflict();
            }
            await transaction.userAiuLedgerEntry.create({
              data: {
                applicationId,
                userId: row.userId,
                quotaId: row.quotaId,
                entryType: AiuLedgerEntryType.EXPIRE,
                reservedDeltaMicros: -row.reservedAiuMicros,
                consumedAfterMicros: row.quota.consumedAiuMicros,
                reservedAfterMicros: reservedAfter,
                limitAfterMicros: row.quota.limitAiuMicros,
                sourceReservationId: row.id,
                idempotencyKey: `user-reservation:${row.id}:expire`,
                reason: "AIU reservation expired before model usage was settled",
              },
            });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const retryable =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { readonly code?: unknown }).code === "P2034";
        if (!retryable || attempt === 2) throw error;
      }
    }
    return false;
  }
}
