import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import type { UserGroupCandidate } from "./evaluator.js";

interface ProfileRow {
  readonly user_record_id?: unknown;
  readonly user_id?: unknown;
  readonly display_user?: unknown;
  readonly tags?: unknown;
  readonly status?: unknown;
  readonly last_seen_at?: unknown;
  readonly properties_json?: unknown;
}

interface MetricsRow {
  readonly user_id?: unknown;
  readonly calls?: unknown;
  readonly tokens?: unknown;
  readonly aiu_micros?: unknown;
  readonly cost?: unknown;
}

function integer(value: unknown): bigint {
  try {
    return BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return 0n;
  }
}

function decimal(value: unknown): Prisma.Decimal {
  try {
    return new Prisma.Decimal(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return new Prisma.Decimal(0);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tags(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function properties(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

/** Loads cohort identities and usage from ClickHouse; PostgreSQL is read only for quota authority. */
export class ClickHouseUserGroupCandidateLoader {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clickhouse: ClickHouseClient,
  ) {}

  async load(applicationId: string): Promise<readonly UserGroupCandidate[]> {
    const [profileResult, metricsResult] = await Promise.all([
      this.clickhouse.query({
        query: `
          SELECT
            user_record_id,
            user_id,
            display_user,
            tags,
            status,
            toString(last_seen_at) AS last_seen_at,
            properties_json
          FROM current_application_user_profiles
          WHERE application_id = {application_id:String}
          ORDER BY user_id
        `,
        query_params: { application_id: applicationId },
        format: "JSONEachRow",
      }),
      this.clickhouse.query({
        query: `
          SELECT
            user_id,
            toUInt64(sum(calls)) AS calls,
            toString(sum(tokens)) AS tokens,
            toString(sum(aiu_micros)) AS aiu_micros,
            toString(sum(cost)) AS cost
          FROM (
            SELECT user_id, count() AS calls, toDecimal128(0, 9) AS tokens,
              toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
            FROM current_usage_events_raw
            WHERE application_id = {application_id:String}
            GROUP BY user_id
            UNION ALL
            SELECT user_id, toUInt64(0) AS calls,
              sumIf(quantity, unit = 'token') AS tokens,
              toInt64(0) AS aiu_micros, toDecimal128(0, 18) AS cost
            FROM current_usage_lines
            WHERE application_id = {application_id:String}
            GROUP BY user_id
            UNION ALL
            SELECT user_id, toUInt64(0) AS calls, toDecimal128(0, 9) AS tokens,
              sumIf(rating_sign * assumeNotNull(aiu_micros), rating_kind = 'aiu' AND isNotNull(aiu_micros)) AS aiu_micros,
              sumIf(rating_sign * assumeNotNull(amount_decimal), rating_kind = 'provider_cost' AND isNotNull(amount_decimal)) AS cost
            FROM current_rating_events
            WHERE application_id = {application_id:String}
            GROUP BY user_id
          )
          GROUP BY user_id
        `,
        query_params: { application_id: applicationId },
        format: "JSONEachRow",
      }),
    ]);
    const profiles = await profileResult.json<ProfileRow>();
    if (profiles.length === 0) return [];
    const metricRows = await metricsResult.json<MetricsRow>();
    const metrics = new Map(
      metricRows.flatMap((row) => {
        const userId = text(row.user_id);
        return userId === null
          ? []
          : [
              [
                userId,
                {
                  calls: Number(integer(row.calls)),
                  tokens: decimal(row.tokens),
                  aiuMicros: integer(row.aiu_micros),
                  cost: decimal(row.cost),
                },
              ] as const,
            ];
      }),
    );
    const recordIds = profiles.flatMap((row) => {
      const id = text(row.user_record_id);
      return id === null ? [] : [id];
    });
    const quotas = await this.database.userAiuQuota.findMany({
      where: { applicationId, userId: { in: recordIds } },
      select: {
        userId: true,
        limitAiuMicros: true,
        consumedAiuMicros: true,
        reservedAiuMicros: true,
      },
    });
    const quotaByUser = new Map(quotas.map((quota) => [quota.userId, quota]));
    return profiles.flatMap((row) => {
      const id = text(row.user_record_id);
      const externalId = text(row.user_id);
      const lastSeen = text(row.last_seen_at);
      const status = text(row.status);
      if (id === null || externalId === null || lastSeen === null || status === null) return [];
      const lastSeenAt = new Date(lastSeen);
      if (!Number.isFinite(lastSeenAt.getTime())) return [];
      const quota = quotaByUser.get(id);
      return [
        {
          id,
          externalId,
          name: text(row.display_user) || null,
          tags: tags(row.tags),
          propertiesJson: properties(row.properties_json),
          status,
          lastSeenAt,
          quota:
            quota === undefined
              ? null
              : {
                  limitAiuMicros: quota.limitAiuMicros,
                  consumedAiuMicros: quota.consumedAiuMicros,
                  reservedAiuMicros: quota.reservedAiuMicros,
                },
          metrics: metrics.get(externalId) ?? {
            calls: 0,
            tokens: new Prisma.Decimal(0),
            aiuMicros: 0n,
            cost: new Prisma.Decimal(0),
          },
        },
      ];
    });
  }
}
