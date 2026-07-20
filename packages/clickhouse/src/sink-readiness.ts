import type { ClickHouseClient } from "@clickhouse/client";

import { ClickHouseSinkNotReadyError, sanitizeClickHouseError } from "./errors.js";
import { checkClickHouseHealth, type ClickHouseHealthResult } from "./health.js";
import { clickHouseErrorClass } from "./metrics/record.js";
import {
  verifyClickHouseMigrations,
  type ClickHouseMigration,
  type ClickHouseMigrationStatusReport,
} from "./migrations.js";

export type ClickHouseSinkReadiness =
  | {
      readonly ready: true;
      readonly health: Extract<ClickHouseHealthResult, { readonly ok: true }>;
      readonly migrations: ClickHouseMigrationStatusReport;
    }
  | {
      readonly ready: false;
      readonly reason: string;
      readonly errorClass: string;
    };

/** Non-throwing probe: callers outside the sink may report degradation without losing availability. */
export async function checkClickHouseSinkReadiness(
  client: ClickHouseClient,
  database: string,
  migrations: readonly ClickHouseMigration[],
): Promise<ClickHouseSinkReadiness> {
  const health = await checkClickHouseHealth(client);
  if (!health.ok) {
    return { ready: false, reason: health.error, errorClass: "ClickHouseHealthError" };
  }
  try {
    const status = await verifyClickHouseMigrations(client, database, migrations);
    return { ready: true, health, migrations: status };
  } catch (error) {
    return {
      ready: false,
      reason: sanitizeClickHouseError(error),
      errorClass: clickHouseErrorClass(error),
    };
  }
}

/** Sink startup uses this gate; API and model-request paths must use the non-throwing probe instead. */
export async function requireClickHouseSinkReadiness(
  client: ClickHouseClient,
  database: string,
  migrations: readonly ClickHouseMigration[],
): Promise<Extract<ClickHouseSinkReadiness, { readonly ready: true }>> {
  const readiness = await checkClickHouseSinkReadiness(client, database, migrations);
  if (!readiness.ready) {
    throw new ClickHouseSinkNotReadyError(`ClickHouse sink is not ready: ${readiness.reason}`);
  }
  return readiness;
}
