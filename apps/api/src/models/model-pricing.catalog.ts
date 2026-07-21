import { Prisma } from "@tokenpilot/db";

import type { SaveModelAiu } from "./model-pricing.schemas.js";

export interface StandardRateDefinition {
  readonly field: Exclude<keyof SaveModelAiu, "custom_units">;
  readonly usageType: string;
  readonly unitSize: string;
}

export const aiuUsage: readonly StandardRateDefinition[] = [
  { field: "input_per_million", usageType: "uncached_input_token", unitSize: "1000000" },
  {
    field: "cache_read_per_million",
    usageType: "cache_read_input_token",
    unitSize: "1000000",
  },
  {
    field: "cache_write_per_million",
    usageType: "cache_write_input_token",
    unitSize: "1000000",
  },
  { field: "output_per_million", usageType: "output_token", unitSize: "1000000" },
  {
    field: "reasoning_per_million",
    usageType: "reasoning_output_token",
    unitSize: "1000000",
  },
  { field: "input_image", usageType: "input_image", unitSize: "1" },
  { field: "output_image", usageType: "output_image", unitSize: "1" },
  { field: "input_audio_second", usageType: "input_audio_second", unitSize: "1" },
  { field: "output_audio_second", usageType: "output_audio_second", unitSize: "1" },
  { field: "input_video_second", usageType: "input_video_second", unitSize: "1" },
  { field: "output_video_second", usageType: "output_video_second", unitSize: "1" },
  { field: "embedding_per_million", usageType: "embedding_token", unitSize: "1000000" },
  { field: "unknown_unit", usageType: "unknown", unitSize: "1" },
] as const;

export function trimmedDecimal(value: Prisma.Decimal): string {
  const text = value.toFixed();
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

export function aiuToMicros(value: string): bigint {
  return BigInt(new Prisma.Decimal(value).mul(1_000_000).toFixed(0));
}

export function microsToAiu(value: bigint): string {
  return trimmedDecimal(new Prisma.Decimal(value.toString()).div(1_000_000));
}

interface StoredRateItem {
  readonly usageType: string;
  readonly unitKey: string;
  readonly unitSize: Prisma.Decimal;
}

export function presentRates<T extends StoredRateItem>(
  definitions: readonly StandardRateDefinition[],
  items: readonly T[],
  value: (item: T) => string,
) {
  const standard = new Map(
    items.filter((item) => item.unitKey === "").map((item) => [item.usageType, value(item)]),
  );
  const customUnits = items
    .filter((item) => item.usageType === "custom_unit" && item.unitKey !== "")
    .sort((left, right) => left.unitKey.localeCompare(right.unitKey))
    .map((item) => ({
      unit_key: item.unitKey,
      unit_size: trimmedDecimal(item.unitSize),
      rate: value(item),
    }));
  return {
    ...Object.fromEntries(
      definitions.map((definition) => [
        definition.field,
        standard.get(definition.usageType) ?? null,
      ]),
    ),
    custom_units: customUnits,
  };
}
