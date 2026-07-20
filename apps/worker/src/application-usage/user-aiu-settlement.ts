import { AiuLedgerEntryType, AiuReservationStatus, type Prisma } from "@tokenpilot/db";

export interface UserAiuConsumption {
  readonly consumed: bigint;
  readonly decision: "allow" | "observe" | "warn";
}

export async function applyUserAiu(
  transaction: Prisma.TransactionClient,
  applicationId: string,
  userId: string,
  reservationId: string | null,
  eventId: string,
  actual: bigint | null,
): Promise<UserAiuConsumption | null> {
  if (reservationId !== null) {
    const reservation = await transaction.userAiuReservation.findFirst({
      where: { applicationId, id: reservationId, userId },
      include: { quota: true },
    });
    if (reservation === null) throw new TypeError("Usage event AIU reservation is invalid");
    if (reservation.status === AiuReservationStatus.SETTLED) {
      if (reservation.settledAiuMicros !== (actual ?? 0n)) {
        throw new TypeError("Usage event AIU reservation was settled with another amount");
      }
      return { consumed: reservation.settledAiuMicros, decision: "allow" };
    }
    if (reservation.status !== AiuReservationStatus.RESERVED) {
      throw new TypeError("Usage event AIU reservation is already closed");
    }
    const settled = actual ?? 0n;
    const reservationChanged = await transaction.userAiuReservation.updateMany({
      where: {
        applicationId,
        id: reservation.id,
        status: AiuReservationStatus.RESERVED,
        lockVersion: reservation.lockVersion,
      },
      data: {
        status: AiuReservationStatus.SETTLED,
        settledAiuMicros: settled,
        settledAt: new Date(),
        lockVersion: { increment: 1 },
      },
    });
    const quotaChanged = await transaction.userAiuQuota.updateMany({
      where: {
        applicationId,
        id: reservation.quotaId,
        lockVersion: reservation.quota.lockVersion,
      },
      data: {
        reservedAiuMicros: { decrement: reservation.reservedAiuMicros },
        consumedAiuMicros: { increment: settled },
        lockVersion: { increment: 1 },
      },
    });
    if (reservationChanged.count !== 1 || quotaChanged.count !== 1) {
      throw Object.assign(new Error("AIU reservation changed concurrently"), { code: "P2034" });
    }
    await transaction.userAiuLedgerEntry.create({
      data: {
        applicationId,
        userId,
        quotaId: reservation.quotaId,
        entryType: AiuLedgerEntryType.SETTLEMENT_DELTA,
        consumedDeltaMicros: settled,
        reservedDeltaMicros: -reservation.reservedAiuMicros,
        consumedAfterMicros: reservation.quota.consumedAiuMicros + settled,
        reservedAfterMicros: reservation.quota.reservedAiuMicros - reservation.reservedAiuMicros,
        limitAfterMicros: reservation.quota.limitAiuMicros,
        sourceEventId: eventId,
        sourceReservationId: reservation.id,
        idempotencyKey: `user-usage:${eventId}:settle`,
        reason: "Settled model usage with rated AIU",
      },
    });
    return { consumed: settled, decision: "allow" };
  }
  if (actual === null) return null;
  const quota = await transaction.userAiuQuota.findUnique({
    where: { applicationId_userId: { applicationId, userId } },
  });
  if (quota === null || !quota.enabled) return null;
  const idempotencyKey = `user-usage:${eventId}:consume`;
  const existing = await transaction.userAiuLedgerEntry.findUnique({
    where: { applicationId_idempotencyKey: { applicationId, idempotencyKey } },
  });
  if (existing !== null) {
    return {
      consumed: existing.consumedDeltaMicros,
      decision: quota.hardLimit
        ? "allow"
        : existing.consumedAfterMicros > quota.limitAiuMicros
          ? "warn"
          : "observe",
    };
  }
  const changed = await transaction.userAiuQuota.updateMany({
    where: { applicationId, id: quota.id, lockVersion: quota.lockVersion },
    data: { consumedAiuMicros: { increment: actual }, lockVersion: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw Object.assign(new Error("User AIU quota changed concurrently"), { code: "P2034" });
  }
  const consumedAfter = quota.consumedAiuMicros + actual;
  const warning = !quota.hardLimit && consumedAfter > quota.limitAiuMicros;
  await transaction.userAiuLedgerEntry.create({
    data: {
      applicationId,
      userId,
      quotaId: quota.id,
      entryType: AiuLedgerEntryType.CONSUME,
      consumedDeltaMicros: actual,
      consumedAfterMicros: consumedAfter,
      reservedAfterMicros: quota.reservedAiuMicros,
      limitAfterMicros: quota.limitAiuMicros,
      sourceEventId: eventId,
      idempotencyKey,
      reason: warning
        ? "Soft AIU limit exceeded; model call was allowed"
        : "Consumed rated model AIU",
    },
  });
  return { consumed: actual, decision: warning ? "warn" : "observe" };
}
