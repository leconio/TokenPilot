import { ConflictException } from "@nestjs/common";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { ReservationTransaction } from "./user-reservation-domain.js";

export async function runReservationTransaction<T>(
  database: DatabaseClient,
  action: (transaction: ReservationTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.$transaction(async (transaction) => action(transaction), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const retryable =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { readonly code?: unknown }).code === "P2034";
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw new ConflictException("User quota changed; retry the request");
}
