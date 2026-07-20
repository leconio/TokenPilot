import { describe, expect, it, vi } from "vitest";

import { AiuLedgerEntryType, AiuReservationStatus, type DatabaseClient } from "@tokenpilot/db";

import { UserAiuReservationSweeper } from "../../src/maintenance/user-aiu-reservation-sweeper.js";

describe("UserAiuReservationSweeper", () => {
  it("expires a user reservation and releases its authoritative reserved balance", async () => {
    const now = new Date("2026-07-18T08:00:00.000Z");
    const reservation = {
      id: "00000000-0000-4000-8000-000000000701",
      applicationId: "00000000-0000-4000-8000-000000000702",
      userId: "00000000-0000-4000-8000-000000000703",
      quotaId: "00000000-0000-4000-8000-000000000704",
      status: AiuReservationStatus.RESERVED,
      lockVersion: 2,
      reservedAiuMicros: 250n,
      quota: {
        lockVersion: 5,
        reservedAiuMicros: 400n,
        consumedAiuMicros: 100n,
        limitAiuMicros: 1_000n,
      },
    };
    const transaction = {
      userAiuReservation: {
        findFirst: vi.fn().mockResolvedValue(reservation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      userAiuQuota: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      userAiuLedgerEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const database = {
      userAiuReservation: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: reservation.id, applicationId: reservation.applicationId }]),
      },
      $transaction: vi.fn().mockImplementation((action) => action(transaction)),
    } as unknown as DatabaseClient;

    await expect(new UserAiuReservationSweeper(database).sweep(100, now)).resolves.toBe(1);

    expect(transaction.userAiuReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AiuReservationStatus.EXPIRED,
          releasedAt: now,
        }),
      }),
    );
    expect(transaction.userAiuQuota.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { reservedAiuMicros: { decrement: 250n }, lockVersion: { increment: 1 } },
      }),
    );
    expect(transaction.userAiuLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryType: AiuLedgerEntryType.EXPIRE,
        reservedDeltaMicros: -250n,
        reservedAfterMicros: 150n,
        idempotencyKey: `user-reservation:${reservation.id}:expire`,
      }),
    });
  });
});
