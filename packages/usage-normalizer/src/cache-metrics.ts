import { Decimal } from "decimal.js";

import type { ProviderPromptCacheMetrics } from "./types.js";

function decimal(value: string): Decimal {
  return new Decimal(value);
}

export function providerPromptCacheMetrics(
  uncachedInputTokens: string,
  readInputTokens: string,
  writeInputTokens: string,
): ProviderPromptCacheMetrics {
  const denominator = decimal(uncachedInputTokens).plus(readInputTokens).plus(writeInputTokens);
  return {
    hitRate: denominator.isZero()
      ? null
      : decimal(readInputTokens).dividedBy(denominator).toSignificantDigits(18).toString(),
    readInputTokens,
    writeInputTokens,
    uncachedInputTokens,
  };
}
