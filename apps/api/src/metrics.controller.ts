import { Controller, Get, Header, Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import {
  PublicationStatus,
  Prisma,
  registerDatabaseQueryObserver,
  type DatabaseClient,
  type DatabaseQueryObservation,
} from "@tokenpilot/db";
import {
  EXPORTS_GENERATE_QUEUE,
  MAINTENANCE_QUEUE,
  RECONCILIATION_QUEUE,
} from "@tokenpilot/shared";

import type { ApiConfiguration } from "./api-config.js";
import { createOpenMetricsRegistry } from "./metrics-registry.js";
import {
  CURRENT_PIPELINE_FAILURE_STAGES,
  readCurrentMetricState,
} from "./metrics/current-state.js";
import { calculateRuntimeConfigurationAcknowledgementMetrics } from "./metrics/runtime-configuration-acknowledgement.js";
import { ApiPlatformMetrics, type ApiQuotaDecision } from "./platform-metrics.js";
import { API_CONFIGURATION, CLICKHOUSE_CLIENT, DATABASE_CLIENT, REDIS_CLIENT } from "./tokens.js";

export { createOpenMetricsRegistry } from "./metrics-registry.js";

const queueNames = [EXPORTS_GENERATE_QUEUE, MAINTENANCE_QUEUE, RECONCILIATION_QUEUE] as const;

@Injectable()
export class ConnectorMetricsService {
  private readonly registry = createOpenMetricsRegistry();
  private readonly platformMetrics: ApiPlatformMetrics;
  private readonly ingestEvents = new Counter({
    name: "ai_control_usage_ingest_events_total",
    help: "Usage events handled by the ingestion API.",
    labelNames: ["status"] as const,
    registers: [this.registry],
  });
  private readonly ingestDuplicates = new Counter({
    name: "ai_control_usage_ingest_duplicates_total",
    help: "Usage events rejected as already stored.",
    registers: [this.registry],
  });
  private readonly processingFailures = new Gauge({
    name: "ai_control_usage_processing_failures_current",
    help: "Current persisted processing failures by stage.",
    labelNames: ["stage"] as const,
    registers: [this.registry],
  });
  private readonly unpriced = new Gauge({
    name: "ai_control_provider_cost_unpriced_current",
    help: "Current number of events whose official Provider Cost rating is unpriced.",
    registers: [this.registry],
  });
  private readonly queueDepth = new Gauge({
    name: "ai_control_queue_depth",
    help: "Outstanding work in canonical database handoffs and BullMQ operational queues.",
    labelNames: ["queue"] as const,
    registers: [this.registry],
  });
  private readonly queueFailed = new Gauge({
    name: "ai_control_queue_failed_jobs",
    help: "Failed work retained for inspection by canonical handoff or operational queue.",
    labelNames: ["queue"] as const,
    registers: [this.registry],
  });
  private readonly stale = new Gauge({
    name: "ai_control_connector_stale",
    help: "Whether a connector has stopped heartbeating within the configured interval.",
    labelNames: ["instance_id", "name"] as const,
    registers: [this.registry],
  });
  private readonly bufferDepth = new Gauge({
    name: "ai_control_connector_buffer_depth",
    help: "Number of usage events waiting in the connector durable buffer.",
    labelNames: ["instance_id", "name"] as const,
    registers: [this.registry],
  });
  private readonly backlogAlert = new Gauge({
    name: "ai_control_connector_backlog_alert",
    help: "Whether connector buffer depth exceeds the configured alert threshold.",
    labelNames: ["instance_id", "name"] as const,
    registers: [this.registry],
  });
  private readonly oldestAge = new Gauge({
    name: "ai_control_connector_oldest_event_age_seconds",
    help: "Age of the oldest buffered connector event in seconds.",
    labelNames: ["instance_id", "name"] as const,
    registers: [this.registry],
  });
  private readonly heartbeatAge = new Gauge({
    name: "ai_control_connector_last_heartbeat_age_seconds",
    help: "Seconds since the Control Plane received the last heartbeat.",
    labelNames: ["instance_id", "name"] as const,
    registers: [this.registry],
  });
  private readonly runtimeConfigurationConnectorAcknowledgementLag = new Gauge({
    name: "ai_control_runtime_configuration_connector_acknowledgement_lag_current",
    help: "Runtime Configuration versions by which a connector's latest applied acknowledgement trails its application's current published configuration.",
    labelNames: [
      "application_id",
      "application_slug",
      "connector_instance_id",
      "connector_name",
    ] as const,
    registers: [this.registry],
  });
  private readonly runtimeConfigurationAcknowledgementsAbsent = new Gauge({
    name: "ai_control_runtime_configuration_acknowledgements_absent_current",
    help: "Whether an application has a published Runtime Configuration but no connector acknowledgement.",
    labelNames: ["application_id", "application_slug"] as const,
    registers: [this.registry],
  });
  private readonly httpLatency = new Histogram({
    name: "ai_control_http_request_duration_seconds",
    help: "API request latency by method, route, and response status.",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly dbLatency = new Histogram({
    name: "ai_control_db_query_duration_seconds",
    help: "Prisma database operation latency by fixed component, model, operation class, and outcome.",
    labelNames: ["component", "model", "operation", "outcome"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly dbConnections = new Gauge({
    name: "ai_control_db_connections",
    help: "Current PostgreSQL client connections across the whole server.",
    registers: [this.registry],
  });
  private readonly dbMaxConnections = new Gauge({
    name: "ai_control_db_max_connections",
    help: "Server-wide PostgreSQL max_connections limit for client connections.",
    registers: [this.registry],
  });
  private readonly dailyProviderCost = new Gauge({
    name: "ai_control_daily_provider_cost",
    help: "Provider cost total for the current or previous instance-local calendar day.",
    labelNames: ["period"] as const,
    registers: [this.registry],
  });

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient,
    @Inject(API_CONFIGURATION) private readonly configuration: ApiConfiguration,
  ) {
    this.platformMetrics = new ApiPlatformMetrics(this.registry, database);
    registerDatabaseQueryObserver(database, (observation) => {
      this.observeDatabaseQuery(observation);
    });
  }

  recordIngestion(result: {
    accepted: number;
    duplicates: number;
    rejected: number;
    conflicts?: number;
    latencySeconds?: number;
  }): void {
    this.platformMetrics.recordIngestion({
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
      ...(result.conflicts === undefined ? {} : { payloadConflicts: result.conflicts }),
      ...(result.latencySeconds === undefined ? {} : { latencySeconds: result.latencySeconds }),
    });
    if (result.accepted > 0) this.ingestEvents.inc({ status: "accepted" }, result.accepted);
    if (result.duplicates > 0) {
      this.ingestEvents.inc({ status: "duplicate" }, result.duplicates);
      this.ingestDuplicates.inc(result.duplicates);
    }
    if ((result.conflicts ?? 0) > 0) {
      this.ingestEvents.inc({ status: "conflict" }, result.conflicts);
    }
    if (result.rejected > 0) this.ingestEvents.inc({ status: "rejected" }, result.rejected);
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpLatency.observe({ method, route, status: String(status) }, seconds);
  }

  recordQuota(decision: ApiQuotaDecision): void {
    this.platformMetrics.recordQuota(decision);
  }

  async render(): Promise<string> {
    const now = new Date();
    await this.platformMetrics.refresh(now);
    const [dayBoundaries] = await this.database.$queryRaw<
      Array<{ current_start: Date; previous_start: Date }>
    >(Prisma.sql`
      SELECT
        date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE ${this.configuration.timezone})
          AT TIME ZONE ${this.configuration.timezone} AS current_start,
        (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE ${this.configuration.timezone})
          - interval '1 day') AT TIME ZONE ${this.configuration.timezone} AS previous_start
    `);
    if (dayBoundaries === undefined) {
      throw new Error("PostgreSQL did not return instance day boundaries");
    }
    const today = dayBoundaries.current_start;
    const yesterday = dayBoundaries.previous_start;
    const [
      connectors,
      currentState,
      publishedRuntimeConfigurations,
      runtimeConfigurationAcknowledgements,
      connectionRows,
      queueStats,
    ] = await Promise.all([
      this.database.connectorInstance.findMany(),
      readCurrentMetricState(this.database, this.clickhouse, today, yesterday),
      this.database.runtimeConfigurationVersion.findMany({
        where: { status: PublicationStatus.PUBLISHED },
        orderBy: [{ applicationId: "asc" }, { version: "desc" }],
        select: {
          applicationId: true,
          version: true,
          application: { select: { slug: true } },
        },
      }),
      this.database.runtimeConfigurationAcknowledgement.findMany({
        where: {
          application: {
            runtimeConfigurations: { some: { status: PublicationStatus.PUBLISHED } },
          },
        },
        orderBy: [{ applicationId: "asc" }, { receivedAt: "desc" }, { id: "desc" }],
        select: {
          applicationId: true,
          connectorInstanceId: true,
          connectorName: true,
          configurationVersion: true,
          state: true,
        },
      }),
      this.database.$queryRaw<Array<{ used: number; maximum: number }>>(Prisma.sql`
        SELECT
          count(*) FILTER (WHERE backend_type = 'client backend')::int AS used,
          current_setting('max_connections')::int AS maximum
        FROM pg_stat_activity
      `),
      Promise.all(
        queueNames.map(async (queue) => {
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
      ),
    ]);
    this.processingFailures.reset();
    for (const stage of CURRENT_PIPELINE_FAILURE_STAGES) {
      this.processingFailures.set({ stage }, 0);
    }
    for (const failure of currentState.failures) {
      this.processingFailures.set({ stage: failure.stage.toLowerCase() }, failure.count);
    }
    this.processingFailures.set({ stage: "background_job" }, currentState.backgroundJobFailures);
    this.unpriced.set(currentState.unpricedEvents);
    this.queueDepth.reset();
    this.queueFailed.reset();
    for (const stat of [...queueStats, ...currentState.durableQueues]) {
      this.queueDepth.set({ queue: stat.queue }, stat.depth);
      this.queueFailed.set({ queue: stat.queue }, stat.failed);
    }
    this.stale.reset();
    this.bufferDepth.reset();
    this.backlogAlert.reset();
    this.oldestAge.reset();
    this.heartbeatAge.reset();
    for (const connector of connectors) {
      const labels = { instance_id: connector.instanceId, name: connector.name };
      const age = Math.max(0, (now.getTime() - connector.lastHeartbeatAt.getTime()) / 1000);
      this.stale.set(labels, age > this.configuration.connectorStaleAfterSeconds ? 1 : 0);
      this.bufferDepth.set(labels, connector.bufferDepth);
      this.backlogAlert.set(
        labels,
        connector.bufferDepth >= this.configuration.connectorBacklogAlertDepth ? 1 : 0,
      );
      this.oldestAge.set(labels, connector.oldestEventAgeSeconds?.toNumber() ?? 0);
      this.heartbeatAge.set(labels, age);
    }
    this.runtimeConfigurationConnectorAcknowledgementLag.reset();
    this.runtimeConfigurationAcknowledgementsAbsent.reset();
    const runtimeConfigurationMetrics = calculateRuntimeConfigurationAcknowledgementMetrics(
      publishedRuntimeConfigurations.map((configuration) => ({
        applicationId: configuration.applicationId,
        applicationSlug: configuration.application.slug,
        version: configuration.version,
      })),
      runtimeConfigurationAcknowledgements,
    );
    for (const application of runtimeConfigurationMetrics.applicationStates) {
      this.runtimeConfigurationAcknowledgementsAbsent.set(
        {
          application_id: application.applicationId,
          application_slug: application.applicationSlug,
        },
        application.acknowledgementsAbsent,
      );
    }
    for (const connector of runtimeConfigurationMetrics.connectorLags) {
      this.runtimeConfigurationConnectorAcknowledgementLag.set(
        {
          application_id: connector.applicationId,
          application_slug: connector.applicationSlug,
          connector_instance_id: connector.connectorInstanceId,
          connector_name: connector.connectorName,
        },
        connector.lag,
      );
    }
    this.dbConnections.set(connectionRows[0]?.used ?? 0);
    this.dbMaxConnections.set(connectionRows[0]?.maximum ?? 0);
    this.dailyProviderCost.set({ period: "current" }, currentState.currentProviderCost);
    this.dailyProviderCost.set({ period: "previous" }, currentState.previousProviderCost);
    return this.registry.metrics();
  }

  private observeDatabaseQuery(observation: DatabaseQueryObservation): void {
    this.dbLatency.observe(
      {
        component: "api",
        model: observation.model,
        operation: observation.operation,
        outcome: observation.outcome,
      },
      observation.durationSeconds,
    );
  }
}

@Controller()
export class MetricsController {
  constructor(private readonly metrics: ConnectorMetricsService) {}

  @Get("metrics")
  @Header("Content-Type", Registry.OPENMETRICS_CONTENT_TYPE)
  render() {
    return this.metrics.render();
  }
}
