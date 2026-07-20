import type { EditableRates, RateField, RateValues } from "./types";

export const rateFields = [
  "request",
  "input_per_million",
  "cache_read_per_million",
  "cache_write_per_million",
  "output_per_million",
  "reasoning_per_million",
  "input_image",
  "output_image",
  "input_audio_second",
  "output_audio_second",
  "input_video_second",
  "output_video_second",
  "embedding_per_million",
  "unknown_unit",
] as const satisfies readonly RateField[];

export function emptyEditableRates(): EditableRates {
  return {
    request: "",
    input_per_million: "",
    cache_read_per_million: "",
    cache_write_per_million: "",
    output_per_million: "",
    reasoning_per_million: "",
    input_image: "",
    output_image: "",
    input_audio_second: "",
    output_audio_second: "",
    input_video_second: "",
    output_video_second: "",
    embedding_per_million: "",
    unknown_unit: "",
    custom_units: [],
  };
}

export function editableRates(values: RateValues | undefined): EditableRates {
  return {
    ...Object.fromEntries(
      rateFields.map((field) => [field, values?.[field] === null ? "" : (values?.[field] ?? "")]),
    ),
    custom_units: [...(values?.custom_units ?? [])],
  } as EditableRates;
}

export function rateRequestBody(values: EditableRates, kind: "cost" | "aiu") {
  return {
    ...Object.fromEntries(
      rateFields.flatMap((field) =>
        kind === "aiu" && field === "request"
          ? []
          : [[field, values[field] === "" ? null : values[field]]],
      ),
    ),
    custom_units: values.custom_units,
  };
}
