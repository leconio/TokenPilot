import type { NormalizedUsage } from "@tokenpilot/contracts";

export type { NormalizedUsage, UsageLine } from "@tokenpilot/contracts";

export interface ProviderPromptCacheMetrics {
  readonly hitRate: string | null;
  readonly readInputTokens: string;
  readonly writeInputTokens: string;
  readonly uncachedInputTokens: string;
}

export interface UsageAdapter {
  readonly adapterName: string;
  readonly adapterVersion: string;
  supports(input: unknown): boolean;
  normalize(input: unknown): NormalizedUsage;
}
