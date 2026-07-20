import { createServer, type Server } from "node:http";

import { Counter, Gauge, Histogram, Registry } from "prom-client";

import type { DatabaseQueryObservation } from "@tokenpilot/db";
import {
  EXPORTS_GENERATE_QUEUE,
  MAINTENANCE_QUEUE,
  sanitizeOperationalAttributes,
} from "@tokenpilot/shared";

import { WorkerPlatformMetrics } from "./platform-metrics.js";
import type { WorkerReadinessResult } from "./readiness.js";

export const observedQueueNames = [EXPORTS_GENERATE_QUEUE, MAINTENANCE_QUEUE] as const;

export type ProcessingStage = "operational";
export type JobOutcome = "completed" | "failed";

export interface QueueMetricsRedis {
  llen(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
}

export interface OperationalLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly component: "api" | "worker" | "scheduler" | "connector";
  readonly event: string;
  readonly requestId?: string | null | undefined;
  readonly eventId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly traceId?: string | null | undefined;
  readonly operationId?: string | null | undefined;
  readonly attemptId?: string | null | undefined;
  readonly ratingId?: string | null | undefined;
  readonly transactionId?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly durationMs?: number | null | undefined;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export function serializeOperationalLog(input: OperationalLog, now = new Date()): string {
  return JSON.stringify({
    ...sanitizeOperationalAttributes(input.attributes),
    timestamp: now.toISOString(),
    level: input.level,
    component: input.component,
    event: input.event,
    request_id: input.requestId ?? null,
    event_id: input.eventId ?? null,
    job_id: input.jobId ?? null,
    trace_id: input.traceId ?? null,
    operation_id: input.operationId ?? null,
    attempt_id: input.attemptId ?? null,
    rating_id: input.ratingId ?? null,
    transaction_id: input.transactionId ?? null,
    error_code: input.errorCode ?? null,
    duration_ms: input.durationMs ?? null,
  });
}

export function operationalErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const normalized = candidate.replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  return normalized.length === 0 ? "UnknownError" : normalized;
}

export function jobDurationMs(processedOn: number | undefined, now = Date.now()): number | null {
  return processedOn === undefined ? null : Math.max(0, now - processedOn);
}

function createOpenMetricsRegistry(): Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE> {
  const registry = new Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  return registry;
}

export class WorkerObservability {
  readonly platform: WorkerPlatformMetrics;
  private readonly processingFailures: Counter<"stage">;
  private readonly queueDepth: Gauge<"queue">;
  private readonly queueFailedDepth: Gauge<"queue">;
  private readonly jobDuration: Histogram<"stage" | "outcome">;
  private readonly dbLatency: Histogram<"component" | "model" | "operation" | "outcome">;
  private readonly collectionFailures: Counter;

  constructor(
    private readonly redis: QueueMetricsRedis,
    private readonly registry = createOpenMetricsRegistry(),
  ) {
    this.registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    this.platform = new WorkerPlatformMetrics(registry);
    this.processingFailures = new Counter({
      name: "ai_control_usage_processing_failures_total",
      help: "Usage processing failures emitted by the Worker, partitioned by fixed stage.",
      labelNames: ["stage"] as const,
      registers: [registry],
    });
    this.queueDepth = new Gauge({
      name: "ai_control_queue_depth",
      help: "Waiting, active, delayed, prioritized, and paused BullMQ jobs.",
      labelNames: ["queue"] as const,
      registers: [registry],
    });
    this.queueFailedDepth = new Gauge({
      name: "ai_control_queue_failed_depth",
      help: "Terminal BullMQ jobs retained for DLQ inspection.",
      labelNames: ["queue"] as const,
      registers: [registry],
    });
    this.jobDuration = new Histogram({
      name: "ai_control_worker_job_duration_seconds",
      help: "Worker job runtime by fixed processing stage and outcome.",
      labelNames: ["stage", "outcome"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    });
    this.dbLatency = new Histogram({
      name: "ai_control_db_query_duration_seconds",
      help: "Prisma database operation latency by fixed component, model, operation class, and outcome.",
      labelNames: ["component", "model", "operation", "outcome"] as const,
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
    this.collectionFailures = new Counter({
      name: "ai_control_worker_metrics_collection_failures_total",
      help: "Worker metrics scrapes that could not refresh BullMQ queue gauges.",
      registers: [registry],
    });
  }

  recordFailure(stage: ProcessingStage): void {
    this.processingFailures.inc({ stage });
  }

  observeJob(stage: ProcessingStage, outcome: JobOutcome, durationMs: number | null): void {
    if (durationMs !== null) {
      this.jobDuration.observe({ stage, outcome }, durationMs / 1000);
    }
  }

  observeDatabaseQuery(observation: DatabaseQueryObservation): void {
    this.dbLatency.observe(
      {
        component: "worker",
        model: observation.model,
        operation: observation.operation,
        outcome: observation.outcome,
      },
      observation.durationSeconds,
    );
  }

  async render(): Promise<string> {
    try {
      await this.refreshQueueMetrics();
    } catch {
      // Keep process counters scrapeable during a Redis outage. Prometheus will
      // retain the previous queue gauge samples and expose this collection error.
      this.collectionFailures.inc();
    }
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  private async refreshQueueMetrics(): Promise<void> {
    const stats = await Promise.all(
      observedQueueNames.map(async (queue) => {
        const key = `bull:${queue}`;
        const [waiting, active, delayed, prioritized, paused, failed] = await Promise.all([
          this.redis.llen(`${key}:wait`),
          this.redis.llen(`${key}:active`),
          this.redis.zcard(`${key}:delayed`),
          this.redis.zcard(`${key}:prioritized`),
          this.redis.llen(`${key}:paused`),
          this.redis.zcard(`${key}:failed`),
        ]);
        return { queue, depth: waiting + active + delayed + prioritized + paused, failed };
      }),
    );
    this.queueDepth.reset();
    this.queueFailedDepth.reset();
    for (const stat of stats) {
      this.queueDepth.set({ queue: stat.queue }, stat.depth);
      this.queueFailedDepth.set({ queue: stat.queue }, stat.failed);
    }
  }
}

export async function startWorkerMetricsServer(
  metrics: WorkerObservability,
  options: {
    readonly host: string;
    readonly port: number;
    readonly readiness?: () => Promise<WorkerReadinessResult>;
  },
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found\n");
      return;
    }
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/health/ready") {
      if (options.readiness === undefined) {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ready: false }));
        return;
      }
      void options
        .readiness()
        .then((result) => {
          response.writeHead(result.ready ? 200 : 503, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify(result));
        })
        .catch(() => {
          response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ready: false }));
        });
      return;
    }
    if (request.url !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found\n");
      return;
    }
    void metrics
      .render()
      .then((body) => {
        response.writeHead(200, { "content-type": metrics.contentType() });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        response.end("Metrics temporarily unavailable\n");
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function closeMetricsServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
