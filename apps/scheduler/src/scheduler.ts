import { MAINTENANCE_JOB, type OperationalJobData } from "@tokenpilot/shared";

export interface SchedulerQueue {
  add(
    name: string,
    data: OperationalJobData,
    options: {
      readonly jobId: string;
      readonly attempts: number;
      readonly backoff: {
        readonly type: "exponential";
        readonly delay: number;
        readonly jitter: number;
      };
      readonly removeOnComplete: boolean;
      readonly removeOnFail: boolean;
    },
  ): Promise<unknown>;
}

const jobOptions = (jobId: string) => ({
  jobId,
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 1_000, jitter: 0.5 },
  removeOnComplete: false,
  removeOnFail: false,
});

function startOfUtcHour(value: Date): Date {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function startOfUtcDay(value: Date): Date {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export class ControlPlaneScheduler {
  constructor(private readonly maintenanceQueue: SchedulerQueue) {}

  async tick(now = new Date()): Promise<string[]> {
    const minute = now.toISOString().slice(0, 16);
    const currentHour = startOfUtcHour(now);
    const currentDay = startOfUtcDay(now);
    const identifiers: string[] = [];
    await this.enqueue(
      this.maintenanceQueue,
      MAINTENANCE_JOB,
      "connector.heartbeat.check",
      `maintenance:connector:${minute}`,
      {},
      identifiers,
    );
    if (now.getUTCMinutes() < 2) {
      await this.enqueue(
        this.maintenanceQueue,
        MAINTENANCE_JOB,
        "unpriced.alert",
        `maintenance:unpriced:${currentHour.toISOString()}`,
        {},
        identifiers,
      );
    }
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 2) {
      await this.enqueue(
        this.maintenanceQueue,
        MAINTENANCE_JOB,
        "api_key.expiry",
        `maintenance:api-key:${currentDay.toISOString()}`,
        {},
        identifiers,
      );
    }
    return identifiers;
  }

  private async enqueue(
    queue: SchedulerQueue,
    name: string,
    kind: OperationalJobData["kind"],
    idempotencyKey: string,
    parameters: Readonly<Record<string, unknown>>,
    identifiers: string[],
  ) {
    await queue.add(
      name,
      { kind, idempotencyKey, parameters },
      jobOptions(idempotencyKey.replaceAll(":", "-")),
    );
    identifiers.push(idempotencyKey);
  }
}
