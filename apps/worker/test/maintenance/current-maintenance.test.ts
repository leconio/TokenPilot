import { afterEach, describe, expect, it, vi } from "vitest";

import { AiuReservationStatus, type DatabaseClient } from "@tokenpilot/db";

import {
  CurrentMaintenanceService,
  createCurrentMaintenancePollers,
} from "../../src/maintenance/current-maintenance.js";

describe("current maintenance runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs guarded inbox cleanup and reports expired and active reservation state", async () => {
    const completedAt = new Date("2026-07-16T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(completedAt);
    const payloadCleanup = {
      purgeBatch: vi.fn().mockResolvedValue({
        purgedPayloads: 2,
        purgedBytes: 1_024,
        completedAt,
        eventIds: ["event-1", "event-2"],
      }),
    };
    const database = {
      userAiuReservation: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(4),
      },
      userAiuQuota: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { limitAiuMicros: 1n, consumedAiuMicros: 2n, reservedAiuMicros: 0n },
          ]),
      },
    } as unknown as DatabaseClient;
    const metrics = {
      recordExpiredReservations: vi.fn(),
      setQuotaState: vi.fn(),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const service = new CurrentMaintenanceService(database, payloadCleanup, metrics, logger);

    await expect(service.cleanupInboxPayloads(250)).resolves.toMatchObject({
      purgedPayloads: 2,
      purgedBytes: 1_024,
    });
    await expect(service.sweepExpiredReservations(75)).resolves.toEqual({
      swept: 0,
      activeReservations: 4,
      negativeBalanceUsers: 1,
    });

    expect(payloadCleanup.purgeBatch).toHaveBeenCalledWith(250);
    expect(database.userAiuReservation.count).toHaveBeenCalledWith({
      where: { status: AiuReservationStatus.RESERVED, expiresAt: { gt: completedAt } },
    });
    expect(metrics.recordExpiredReservations).not.toHaveBeenCalled();
    expect(metrics.setQuotaState).toHaveBeenCalledWith(4, 1);
    expect(logger.info).toHaveBeenCalledWith(
      "pipeline.inbox_payload.cleanup.completed",
      expect.objectContaining({ purged_payloads: 2 }),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "quota.reservation.sweep.completed",
      expect.anything(),
    );
  });

  it("schedules cleanup independently and adds the reservation sweep only for quota", async () => {
    vi.useFakeTimers();
    const service = {
      cleanupInboxPayloads: vi.fn().mockResolvedValue({}),
      sweepExpiredReservations: vi.fn().mockResolvedValue({}),
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const schedule = {
      inboxPayloadCleanupIntervalMs: 5_000,
      inboxPayloadCleanupBatchSize: 500,
      reservationSweepIntervalMs: 2_000,
      reservationSweepBatchSize: 100,
    };

    const withoutQuota = createCurrentMaintenancePollers(service, false, schedule, logger);
    expect(withoutQuota).toHaveLength(1);
    withoutQuota[0]!.start();
    await vi.runOnlyPendingTimersAsync();
    expect(service.cleanupInboxPayloads).toHaveBeenCalledWith(500);
    expect(service.sweepExpiredReservations).not.toHaveBeenCalled();
    await withoutQuota[0]!.close();

    service.cleanupInboxPayloads.mockClear();
    const withQuota = createCurrentMaintenancePollers(service, true, schedule, logger);
    expect(withQuota).toHaveLength(2);
    for (const poller of withQuota) poller.start();
    await vi.runOnlyPendingTimersAsync();
    expect(service.cleanupInboxPayloads).toHaveBeenCalledWith(500);
    expect(service.sweepExpiredReservations).toHaveBeenCalledWith(100);
    await Promise.all(withQuota.map((poller) => poller.close()));
  });
});
