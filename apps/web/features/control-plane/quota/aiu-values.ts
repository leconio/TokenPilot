import type { AppLocale } from "@/i18n/translator";

const AIU_MICROS = 1_000_000n;

function integerMicros(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }
  return BigInt(value);
}

export function formatAiuMicros(
  value: string | null | undefined,
  locale: AppLocale = "zh-CN",
): string {
  const amount = integerMicros(value);
  if (amount === null) return "-";
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / AIU_MICROS;
  const fraction = (absolute % AIU_MICROS).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "−" : ""}${whole.toLocaleString(locale)}${fraction ? `.${fraction}` : ""} AIU`;
}

export function parseAiuUnits(value: string): string {
  const normalized = value.trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/u.exec(normalized);
  if (match === null) throw new TypeError("AIU 额度最多保留 6 位小数");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return (whole * AIU_MICROS + fraction).toString();
}

export function effectiveLimitAiuMicros(input: {
  readonly limitAiuMicros?: string | null;
  readonly adjustmentAiuMicros?: string | null;
}): string | null {
  const limit = integerMicros(input.limitAiuMicros);
  const adjustment = integerMicros(input.adjustmentAiuMicros ?? "0");
  return limit === null || adjustment === null ? null : (limit + adjustment).toString();
}

export function aiuUsagePercentage(input: {
  readonly limitAiuMicros?: string | null;
  readonly adjustmentAiuMicros?: string | null;
  readonly consumedAiuMicros?: string | null;
}): string {
  const totalValue = effectiveLimitAiuMicros(input);
  const consumed = integerMicros(input.consumedAiuMicros);
  if (totalValue === null || consumed === null) return "-";
  const total = BigInt(totalValue);
  if (total <= 0n) return consumed > 0n ? "超过额度" : "-";
  const tenths = (consumed * 1_000n) / total;
  return `${tenths / 10n}.${tenths % 10n}%`;
}
