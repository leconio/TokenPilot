import type { PipelineReplayIntent } from "./types.js";

export interface PersistedReplayIntent {
  readonly id: string;
  readonly replay_intent_json: unknown;
}

const RECONCILIATION_REPLAY_ACTIONS = {
  rerun_provider_cost: {
    providerCost: "rerate",
    aiu: "keep_unrated",
  },
  rerun_aiu_observe: {
    providerCost: "keep_existing",
    aiu: "backfill",
  },
} as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parsePipelineReplayIntent(row: PersistedReplayIntent): PipelineReplayIntent | null {
  if (row.replay_intent_json === null) return null;
  if (typeof row.replay_intent_json !== "object" || Array.isArray(row.replay_intent_json)) {
    throw new TypeError(`Inbox ${row.id} has an invalid replay intent`);
  }
  const value = row.replay_intent_json as Record<string, unknown>;
  if (
    !exactKeys(value, ["authority", "run_id", "replay_type"]) ||
    value.authority !== "reconciliation" ||
    typeof value.run_id !== "string" ||
    !UUID_PATTERN.test(value.run_id) ||
    typeof value.replay_type !== "string"
  ) {
    throw new TypeError(`Inbox ${row.id} has an invalid reconciliation replay intent`);
  }
  const action =
    RECONCILIATION_REPLAY_ACTIONS[value.replay_type as keyof typeof RECONCILIATION_REPLAY_ACTIONS];
  if (action === undefined) {
    throw new TypeError(`Inbox ${row.id} has an unsupported reconciliation replay intent`);
  }
  return {
    runId: value.run_id,
    authority: "reconciliation",
    ...action,
    quota: "keep_existing",
  };
}
