import { z } from "zod";

const aiu = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,6})?$/u)
  .refine((value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    return micros <= 9_223_372_036_854_775_807n;
  }, "AIU rate is too large");
const unitSize = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,9})?$/u)
  .refine((value) => value !== "0" && !/^0\.0+$/u.test(value), "Unit size must be positive");
const unitKey = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);

const aiuFields = {
  input_per_million: aiu.nullable().optional(),
  cache_read_per_million: aiu.nullable().optional(),
  cache_write_per_million: aiu.nullable().optional(),
  output_per_million: aiu.nullable().optional(),
  reasoning_per_million: aiu.nullable().optional(),
  input_image: aiu.nullable().optional(),
  output_image: aiu.nullable().optional(),
  input_audio_second: aiu.nullable().optional(),
  output_audio_second: aiu.nullable().optional(),
  input_video_second: aiu.nullable().optional(),
  output_video_second: aiu.nullable().optional(),
  embedding_per_million: aiu.nullable().optional(),
  unknown_unit: aiu.nullable().optional(),
  custom_units: z
    .array(z.strictObject({ unit_key: unitKey, unit_size: unitSize, rate: aiu }))
    .max(32)
    .optional(),
} as const;

function hasValue(value: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(value).some(
    ([field, item]) =>
      item !== null &&
      item !== undefined &&
      (field !== "custom_units" || (item as unknown[]).length > 0),
  );
}

function hasUniqueCustomUnits(value: {
  readonly custom_units?: readonly { unit_key: string }[] | undefined;
}) {
  const keys = (value.custom_units ?? []).map((item) => item.unit_key);
  return new Set(keys).size === keys.length;
}

export const saveModelAiuSchema = z
  .strictObject(aiuFields)
  .refine(hasValue, "Set at least one AIU rate")
  .refine(hasUniqueCustomUnits, {
    message: "Custom unit keys must be unique",
    path: ["custom_units"],
  });

export type SaveModelAiu = z.infer<typeof saveModelAiuSchema>;
