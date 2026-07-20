import { NormalizationError } from "./errors.js";
import type { NormalizedUsage, UsageAdapter } from "./types.js";

export function normalizeWithAdapters(
  input: unknown,
  adapters: readonly UsageAdapter[],
): NormalizedUsage {
  const adapter = adapters.find((candidate) => candidate.supports(input));
  if (adapter === undefined) {
    throw new NormalizationError(
      "NORMALIZER_UNSUPPORTED_EVENT",
      "No registered usage adapter supports this event.",
    );
  }
  return adapter.normalize(input);
}
