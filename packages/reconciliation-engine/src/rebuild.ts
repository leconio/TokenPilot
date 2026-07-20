import type { FreshClickHouseRebuildPlan } from "./types.js";

const identifier = /^[a-z][a-z0-9_]{0,126}$/u;

export function planFreshClickHouseRebuild(input: {
  readonly rebuildId: string;
  readonly database: string;
}): FreshClickHouseRebuildPlan {
  if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(input.rebuildId)) throw new TypeError("rebuildId is invalid");
  if (!identifier.test(input.database)) {
    throw new TypeError("database is not a safe ClickHouse identifier");
  }
  return {
    rebuildId: input.rebuildId,
    database: input.database,
    steps: [
      "clear_isolated_database",
      "create_current_schema",
      "replay_postgresql_outbox",
      "verify_current_projection",
    ],
  };
}
