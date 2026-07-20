export type NormalizationErrorCode =
  | "NORMALIZER_INVALID_EVENT"
  | "NORMALIZER_INCONSISTENT_USAGE"
  | "NORMALIZER_QUANTITY_OUT_OF_RANGE"
  | "NORMALIZER_SOURCE_COST_OUT_OF_RANGE"
  | "NORMALIZER_UNSUPPORTED_EVENT";

export class NormalizationError extends Error {
  constructor(
    readonly code: NormalizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NormalizationError";
  }
}
