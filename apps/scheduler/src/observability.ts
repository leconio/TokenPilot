export interface SchedulerLog {
  readonly level: "info" | "error";
  readonly event: "scheduler.tick.completed" | "scheduler.tick.failed";
  readonly errorCode?: string | null;
  readonly durationMs: number;
  readonly jobs?: number;
}

export function serializeSchedulerLog(input: SchedulerLog, now = new Date()): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: input.level,
    component: "scheduler",
    event: input.event,
    request_id: null,
    event_id: null,
    job_id: null,
    trace_id: null,
    error_code: input.errorCode ?? null,
    duration_ms: input.durationMs,
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });
}

export function schedulerErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const normalized = candidate.replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  return normalized.length === 0 ? "UnknownError" : normalized;
}
