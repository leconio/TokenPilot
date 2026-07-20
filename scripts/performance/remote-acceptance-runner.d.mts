export type PerformanceStageStatus = "PASS" | "FAIL" | "BLOCKED";

export interface PerformanceStageEvidence {
  readonly name: string;
  readonly status: PerformanceStageStatus;
  readonly reason?: string;
  readonly error_type?: string;
}

export interface PerformanceStageDefinition {
  readonly name: string;
  readonly blockedBy?: readonly string[];
  readonly operation: (results: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown;
}

export function runPerformanceStage<T>(stage: string, operation: () => Promise<T> | T): Promise<T>;
export function performanceFailureDiagnostic(error: unknown): string;
export function collectPerformanceStages(
  definitions: readonly PerformanceStageDefinition[],
): Promise<{
  readonly results: Readonly<Record<string, unknown>>;
  readonly stages: readonly PerformanceStageEvidence[];
  readonly statuses: Readonly<Record<string, PerformanceStageStatus>>;
}>;
export function performanceModelFromSnapshot(snapshot: unknown): {
  readonly id: string;
  readonly connection_id: string;
  readonly connection_driver: string;
  readonly request_model: string;
  readonly provider: string | null;
};
export function runRemotePerformanceAcceptance(
  arguments_: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<unknown>;
export function runRemotePerformanceCli(arguments_?: readonly string[]): Promise<void>;
