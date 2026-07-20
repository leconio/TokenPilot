export interface RemotePerformanceContext {
  readonly project: string;
  readonly runId: string;
  readonly sourceSha: string;
  readonly databaseUrl: string;
  readonly applicationSlug: string;
  readonly executionNonceSha256: string;
}

export function loadRemotePerformanceContext(
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): RemotePerformanceContext;
export function resolvePerformanceOutput(value?: string): string;
export function parseRemoteArguments(arguments_: readonly string[]): { readonly output: string };
