export const EXPORTS_GENERATE_QUEUE = "exports.generate";
export const EXPORTS_GENERATE_JOB = "generate-export";

export const MAINTENANCE_QUEUE = "maintenance";
export const MAINTENANCE_JOB = "run-maintenance";

export const RECONCILIATION_QUEUE = "reconciliation.run";
export const RECONCILIATION_MANUAL_JOB = "run-reconciliation";
export const RECONCILIATION_HOURLY_JOB = "run-hourly-reconciliation";
export const RECONCILIATION_DAILY_JOB = "run-daily-reconciliation";
export const RECONCILIATION_REPLAY_JOB = "run-reconciliation-replay";
export const RECONCILIATION_REBUILD_JOB = "run-clickhouse-rebuild";

export type ReconciliationJobData =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "schedule"; readonly runType: "hourly" | "daily" }
  | { readonly kind: "replay"; readonly runId: string }
  | { readonly kind: "rebuild"; readonly runId: string };

export type OperationalJobKind =
  "exports.generate" | "connector.heartbeat.check" | "unpriced.alert" | "api_key.expiry";

export interface OperationalJobData {
  readonly backgroundJobId?: string;
  readonly applicationId?: string;
  readonly kind: OperationalJobKind;
  readonly idempotencyKey: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}
