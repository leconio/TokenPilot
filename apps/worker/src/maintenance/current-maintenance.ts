import { AiuReservationStatus, type DatabaseClient } from "@tokenpilot/db";

import type {
  InboxPayloadCleanupOutcome,
  InboxPayloadCleanupService,
} from "../pipeline/payload-cleanup.js";
import type { WorkerPlatformMetrics } from "../platform-metrics.js";
import { SerialPoller } from "../serial-poller.js";
import { UserAiuReservationSweeper } from "./user-aiu-reservation-sweeper.js";

export interface CurrentMaintenanceLogger {
  info(event: string, attributes?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown, attributes?: Readonly<Record<string, unknown>>): void;
}

export interface CurrentMaintenanceSchedule {
  readonly inboxPayloadCleanupIntervalMs: number;
  readonly inboxPayloadCleanupBatchSize: number;
  readonly reservationSweepIntervalMs: number;
  readonly reservationSweepBatchSize: number;
}

export interface ReservationSweepOutcome {
  readonly swept: number;
  readonly activeReservations: number;
  readonly negativeBalanceUsers: number;
}

/** Runs current-schema maintenance and keeps its operational metrics authoritative. */
export class CurrentMaintenanceService {
  private readonly userReservations: UserAiuReservationSweeper;

  constructor(
    private readonly database: DatabaseClient,
    private readonly payloadCleanup: Pick<InboxPayloadCleanupService, "purgeBatch">,
    private readonly metrics: Pick<
      WorkerPlatformMetrics,
      "recordExpiredReservations" | "setQuotaState"
    >,
    private readonly logger: CurrentMaintenanceLogger,
  ) {
    this.userReservations = new UserAiuReservationSweeper(database);
  }

  async cleanupInboxPayloads(limit: number): Promise<InboxPayloadCleanupOutcome> {
    const outcome = await this.payloadCleanup.purgeBatch(limit);
    if (outcome.purgedPayloads > 0) {
      this.logger.info("pipeline.inbox_payload.cleanup.completed", {
        purged_payloads: outcome.purgedPayloads,
        purged_bytes: outcome.purgedBytes,
        completed_at: outcome.completedAt.toISOString(),
      });
    }
    return outcome;
  }

  async sweepExpiredReservations(limit: number): Promise<ReservationSweepOutcome> {
    const now = new Date();
    const swept = await this.userReservations.sweep(limit, now);
    if (swept > 0) this.metrics.recordExpiredReservations(swept);

    const [activeReservations, userQuotaRows] = await Promise.all([
      this.database.userAiuReservation.count({
        where: { status: AiuReservationStatus.RESERVED, expiresAt: { gt: now } },
      }),
      this.database.userAiuQuota.findMany({
        where: { enabled: true },
        select: { limitAiuMicros: true, consumedAiuMicros: true, reservedAiuMicros: true },
      }),
    ]);
    const negativeBalanceUsers = userQuotaRows.filter(
      (quota) => quota.limitAiuMicros - quota.consumedAiuMicros - quota.reservedAiuMicros < 0n,
    ).length;
    this.metrics.setQuotaState(activeReservations, negativeBalanceUsers);
    if (swept > 0) {
      this.logger.info("quota.reservation.sweep.completed", {
        expired_reservations: swept,
        active_reservations: activeReservations,
        negative_balance_users: negativeBalanceUsers,
      });
    }
    return { swept, activeReservations, negativeBalanceUsers };
  }
}

/** Builds non-overlapping repeated current-schema maintenance tasks. */
export function createCurrentMaintenancePollers(
  service: Pick<CurrentMaintenanceService, "cleanupInboxPayloads" | "sweepExpiredReservations">,
  quotaEnabled: boolean,
  schedule: CurrentMaintenanceSchedule,
  logger: CurrentMaintenanceLogger,
): readonly SerialPoller[] {
  const pollers = [
    new SerialPoller({
      name: "inbox-payload-cleanup",
      intervalMs: schedule.inboxPayloadCleanupIntervalMs,
      async run() {
        await service.cleanupInboxPayloads(schedule.inboxPayloadCleanupBatchSize);
      },
      onError(error) {
        logger.error("pipeline.inbox_payload.cleanup.failed", error);
      },
    }),
  ];
  if (quotaEnabled) {
    pollers.push(
      new SerialPoller({
        name: "quota-reservation-sweep",
        intervalMs: schedule.reservationSweepIntervalMs,
        async run() {
          await service.sweepExpiredReservations(schedule.reservationSweepBatchSize);
        },
        onError(error) {
          logger.error("quota.reservation.sweep.failed", error);
        },
      }),
    );
  }
  return pollers;
}
