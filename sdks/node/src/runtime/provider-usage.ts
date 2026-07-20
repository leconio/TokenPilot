import type { RuntimeCallConnection, UsageEvent } from "@tokenpilot/contracts";

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function decimal(value: number): string {
  return String(Math.max(0, Math.trunc(value)));
}

export function openAiUsage(value: unknown): UsageEvent["usage"] {
  const usage =
    typeof value === "object" && value !== null
      ? ((value as { usage?: unknown }).usage as Record<string, unknown> | undefined)
      : undefined;
  const details =
    typeof usage?.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    typeof usage?.completion_tokens_details === "object" && usage.completion_tokens_details !== null
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : {};
  const input = numberValue(usage?.prompt_tokens);
  const cached = Math.min(input, numberValue(details.cached_tokens));
  return {
    uncached_input_tokens: decimal(input - cached),
    cache_read_input_tokens: decimal(cached),
    output_tokens: decimal(numberValue(usage?.completion_tokens)),
    reasoning_output_tokens: decimal(numberValue(completionDetails.reasoning_tokens)),
    request_count: "1",
  };
}

export function anthropicUsage(value: unknown): UsageEvent["usage"] {
  const usage =
    typeof value === "object" && value !== null
      ? ((value as { usage?: unknown }).usage as Record<string, unknown> | undefined)
      : undefined;
  return {
    uncached_input_tokens: decimal(numberValue(usage?.input_tokens)),
    cache_read_input_tokens: decimal(numberValue(usage?.cache_read_input_tokens)),
    cache_write_input_tokens: decimal(numberValue(usage?.cache_creation_input_tokens)),
    output_tokens: decimal(numberValue(usage?.output_tokens)),
    request_count: "1",
  };
}

export function streamUsage(
  value: unknown,
  driver: RuntimeCallConnection["driver"],
): UsageEvent["usage"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (driver !== "anthropic") {
    return record.usage === undefined ? undefined : openAiUsage(record);
  }
  const message =
    typeof record.message === "object" && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const raw = message?.usage ?? record.usage;
  return raw === undefined ? undefined : anthropicUsage({ usage: raw });
}
