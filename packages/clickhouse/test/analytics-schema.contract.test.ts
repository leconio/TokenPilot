import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverClickHouseMigrations, getClickHouseBaselineObjects } from "../src/index.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

const baselineFiles = [
  "0001_create_usage_events_raw.sql",
  "0002_create_usage_lines.sql",
  "0003_create_rating_events.sql",
  "0004_create_pipeline_watermarks.sql",
  "0005_create_reconciliation_markers.sql",
  "0006_create_usage_agg_1m.sql",
  "0007_create_usage_agg_hourly.sql",
  "0008_create_usage_agg_daily.sql",
  "0009_create_usage_events_raw_to_1m_mv.sql",
  "0010_create_usage_lines_to_1m_mv.sql",
  "0011_create_rating_events_to_1m_mv.sql",
  "0012_create_usage_agg_1m_to_hourly_mv.sql",
  "0013_create_usage_agg_1m_to_daily_mv.sql",
  "0014_create_current_usage_events_raw_view.sql",
  "0015_create_current_usage_lines_view.sql",
  "0016_create_current_rating_events_view.sql",
  "0017_create_current_pipeline_watermarks_view.sql",
  "0018_create_current_reconciliation_markers_view.sql",
  "0019_create_current_usage_agg_1m_view.sql",
  "0020_create_current_usage_agg_hourly_view.sql",
  "0021_create_current_usage_agg_daily_view.sql",
  "0022_create_application_user_profiles.sql",
  "0023_create_current_application_user_profiles_view.sql",
] as const;

const physicalTables = [
  "usage_events_raw",
  "usage_lines",
  "rating_events",
  "pipeline_watermarks",
  "reconciliation_markers",
  "usage_agg_1m",
  "usage_agg_hourly",
  "usage_agg_daily",
] as const;

async function baselineSql(index: number): Promise<string> {
  const fileName = baselineFiles[index];
  if (fileName === undefined) throw new Error(`Missing baseline file at index ${index}`);
  return readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8");
}

function executableStatements(sql: string): readonly string[] {
  return sql
    .replace(/^\s*--.*$/gmu, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalized(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

describe("ClickHouse current analytics baseline contract", () => {
  it("is one exact checksummed bundle of single CREATE statements", async () => {
    const sqlFiles = (await readdir(migrationsDirectory))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
    expect(sqlFiles).toEqual(baselineFiles);

    const discovered = await discoverClickHouseMigrations(migrationsDirectory);
    expect(discovered.map(({ version }) => version)).toEqual(
      Array.from({ length: baselineFiles.length }, (_, index) => index + 1),
    );
    expect(discovered.every(({ checksum }) => /^[a-f0-9]{64}$/u.test(checksum))).toBe(true);
    expect(getClickHouseBaselineObjects(discovered)).toHaveLength(baselineFiles.length);

    for (const [index, fileName] of baselineFiles.entries()) {
      const sql = await baselineSql(index);
      expect(sql.split("\n").length, fileName).toBeLessThanOrEqual(400);
      expect(sql, fileName).toMatch(
        new RegExp(
          `^-- Current empty-database baseline statement ${String(index + 1).padStart(4, "0")}\\.`,
        ),
      );
      expect(executableStatements(sql), fileName).toHaveLength(1);
      expect(executableStatements(sql)[0], fileName).toMatch(
        /^CREATE (?:TABLE|MATERIALIZED VIEW|VIEW)\b/u,
      );
      expect(sql, fileName).not.toContain("IF NOT EXISTS");
      expect(sql, fileName).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE|RENAME)\b/iu);
      expect(sql, fileName).not.toMatch(/\$\{|\{\{|\}\}/u);
    }
  });

  it("creates typed source tables, rating facts, and reconciliation evidence", async () => {
    const raw = normalized(await baselineSql(0));
    const lines = normalized(await baselineSql(1));
    const ratings = normalized(await baselineSql(2));
    const reconciliation = normalized(await baselineSql(4));

    for (const sql of [raw, lines, ratings, reconciliation]) {
      expect(sql).toContain("ENGINE = MergeTree");
      expect(sql).toContain("PARTITION BY toYYYYMM(event_date)");
      expect(sql).toContain("ORDER BY");
    }
    expect(raw).toContain("analytics_dimensions Map(String, String)");
    expect(raw).toContain("event_text_properties Map(String, String)");
    expect(raw).toContain("event_number_properties Map(String, Float64)");
    expect(raw).toContain("event_boolean_properties Map(String, UInt8)");
    expect(raw).toContain("event_datetime_properties Map(String, DateTime64(3, 'UTC'))");
    expect(raw).toContain("event_enum_properties Map(String, String)");
    expect(raw).toContain("event_text_list_properties Map(String, Array(String))");
    expect(raw).toContain("user_text_list_properties Map(String, Array(String))");
    expect(raw).toContain("user_id String");
    expect(raw).toContain("request_model LowCardinality(String)");
    expect(raw).not.toMatch(/logical_model|base_model_id|deployment_id|actual_model_raw/iu);
    expect(raw).toContain("payload_hash String");
    expect(raw).toContain("latency_ms Nullable(UInt64)");
    expect(raw).toContain("is_user_visible_operation UInt8");
    expect(raw).not.toMatch(/billing_context|context_signature|quota_dimensions/iu);
    expect(lines).toContain("quantity Decimal(38, 9)");
    expect(lines).toContain("unit_key String");
    expect(lines).toContain("confidence LowCardinality(String)");
    expect(ratings).toContain("amount_decimal Nullable(Decimal(38, 18))");
    expect(ratings).toContain("aiu_micros Nullable(Int64)");
    expect(ratings).toContain("rating_fingerprint FixedString(71)");
    expect(ratings).toContain("attempt_outcome LowCardinality(String)");
    expect(ratings).toContain("authority_outbox_id UInt64");
    expect(ratings).toContain("CHECK rating_kind IN ('provider_cost', 'aiu')");
    expect(ratings).toContain("CHECK rating_sign IN (-1, 1)");
    expect(ratings).toContain("CHECK attempt_outcome IN");
    expect(ratings).toContain(
      "'unpriced', 'invalid_usage', 'unrated', 'disabled', 'not_chargeable'",
    );
    expect(reconciliation).toContain("provider_cost_delta Decimal(38, 18)");
    expect(reconciliation).toContain("aiu_micros_delta Int64");
  });

  it("projects current application user profiles for ClickHouse-only segmentation", async () => {
    const profiles = normalized(await baselineSql(21));
    const currentProfiles = normalized(await baselineSql(22));
    expect(profiles).toContain("ENGINE = ReplacingMergeTree(profile_version)");
    expect(profiles).toContain("ORDER BY (application_id, user_id)");
    expect(profiles).toContain("tags Array(String)");
    expect(profiles).toContain("user_text_list_properties Map(String, Array(String))");
    expect(currentProfiles).toContain("CREATE VIEW current_application_user_profiles AS");
    expect(currentProfiles).toContain("argMax(profile.tags, profile.profile_version) AS tags");
    expect(currentProfiles).toContain("max(profile.profile_version) AS profile_version");
    expect(currentProfiles).toContain("FROM application_user_profiles AS profile");
    expect(currentProfiles).not.toContain("argMax(tags, profile_version)");
    expect(currentProfiles.replace(/^--.*$/gmu, "")).not.toMatch(/\bFINAL\b/u);
  });

  it("keeps PostgreSQL Registry and Outbox state as the idempotency boundary", async () => {
    const telemetry = await Promise.all([0, 1, 2].map((index) => baselineSql(index)));
    const readme = normalized(
      await readFile(new URL("../migrations/README.md", import.meta.url), "utf8"),
    );
    for (const sql of telemetry) {
      expect(sql).toContain("sink_delivery_id String");
      expect(sql).toContain("source_outbox_id String");
      expect(sql).toContain("ENGINE = MergeTree");
      expect(sql).not.toMatch(/(?:Replacing|Collapsing|VersionedCollapsing)MergeTree/u);
    }
    expect(readme).toContain("PostgreSQL Registry/Outbox state");
    expect(readme).toContain("idempotency boundary");
    expect(readme).toContain("not the source of truth for");
    expect(readme).toContain("removes the trusted-context signature");
  });

  it("defines deterministic additive projections and committed retention", async () => {
    const aggregates = await Promise.all([5, 6, 7].map((index) => baselineSql(index)));
    for (const sql of aggregates) {
      expect(sql).toContain("ENGINE = SummingMergeTree");
      expect(sql).toContain("PARTITION BY toYYYYMM(event_date)");
      expect(sql).toContain("usage_quantity Decimal(38, 9)");
      expect(sql).toContain("provisional_provider_cost Decimal(38, 18)");
      expect(sql).toContain("official_aiu_micros_delta Int64");
    }
    expect(await baselineSql(0)).toContain("toIntervalDay(90) DELETE");
    expect(await baselineSql(1)).toContain("toIntervalDay(180) DELETE");
    expect(aggregates[0]).toContain("toIntervalDay(90) DELETE");
    expect(aggregates[1]).toContain("toIntervalDay(730) DELETE");
    expect(aggregates[2]).toContain("toIntervalDay(1825) DELETE");

    const materializedViews = await Promise.all([8, 9, 10, 11, 12].map(baselineSql));
    for (const sql of materializedViews) {
      expect(sql).not.toMatch(/\b(?:now|rand|generateUUID|dictGet)\s*\(/iu);
      expect(sql).not.toMatch(/\bJOIN\b/iu);
      expect(sql).not.toMatch(/(?:raw_payload|JSONExtract)/iu);
    }
    expect(materializedViews[0]).toContain("FROM usage_events_raw");
    expect(materializedViews[1]).toContain("FROM usage_lines");
    expect(materializedViews[3]).toContain("TO usage_agg_hourly");
    expect(materializedViews[4]).toContain("TO usage_agg_daily");
    const ratingView = normalized(materializedViews[2] ?? "");
    expect(ratingView).toContain("attempt_outcome AS status");
    expect(ratingView.match(/\* rating_sign/gu)).toHaveLength(2);
    expect(ratingView.match(/\* toInt64\(rating_sign\)/gu)).toHaveLength(2);
    expect(ratingView).toContain("rating_stage IN ('official', 'correction', 'reversal')");
    expect(ratingView).toContain(
      "rating_kind = 'provider_cost' AND rating_stage IN ('unpriced', 'invalid_usage')",
    );
    expect(ratingView).toContain(
      "rating_kind = 'aiu' AND rating_stage IN ('unrated', 'invalid_usage')",
    );
  });

  it("uses fixed simple current views and contains no generation discovery", async () => {
    for (const [offset, physicalTable] of physicalTables.entries()) {
      const sql = normalized(await baselineSql(13 + offset));
      expect(sql).toContain(`CREATE VIEW current_${physicalTable} AS`);
      expect(sql).toContain(`SELECT * FROM ${physicalTable};`);
      expect(sql).not.toMatch(/\bmerge\s*\(/iu);
      expect(sql).not.toContain("analytics_read_targets");
      expect(sql).not.toMatch(/argMax|system\.tables|target_table/iu);
    }
    const allSql = await Promise.all(baselineFiles.map((_, index) => baselineSql(index)));
    expect(allSql.join("\n")).not.toContain("analytics_read_targets");
    expect(allSql.join("\n")).not.toMatch(/\bmerge\s*\(/iu);
  });

  it("documents fresh-only reset and watermark query contracts", async () => {
    const readme = normalized(
      await readFile(new URL("../migrations/README.md", import.meta.url), "utf8"),
    );
    expect(readme).toContain("one current empty-database baseline");
    expect(readme).toContain("not an upgrade chain");
    expect(readme).toContain("Delete and recreate the disposable ClickHouse database");
    expect(readme).toContain("complete installation whose history names and checksums");
    expect(readme).toContain("argMax(tuple(watermark_type, cursor, watermark_event_time");
    expect(readme).toContain("do not use `FINAL`");
    expect(readme).toContain("raw 90 days");
    expect(readme).toContain("daily 1825 days");
    expect(readme).toContain("system.tables.create_table_query");
    expect(readme).toContain("toIntervalDay(120) DELETE");
  });
});
