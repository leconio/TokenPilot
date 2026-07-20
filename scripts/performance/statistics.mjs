export const REQUIRED_SAMPLE_COUNT = 7;

export function rounded(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

export function finiteSamples(values, name, minimum = REQUIRED_SAMPLE_COUNT) {
  if (!Array.isArray(values) || values.length < minimum) {
    throw new TypeError(`${name} must contain at least ${minimum} samples`);
  }
  return values.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name}[${index}] must be a non-negative finite number`);
    }
    return value;
  });
}

export function percentile(values, percentileValue) {
  const samples = finiteSamples(values, "percentile samples", 1);
  if (
    typeof percentileValue !== "number" ||
    !Number.isFinite(percentileValue) ||
    percentileValue <= 0 ||
    percentileValue > 1
  ) {
    throw new RangeError("percentile must be greater than zero and at most one");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return rounded(sorted[index]);
}

export function sampleSummary(values) {
  const samples = finiteSamples(values, "samples");
  return {
    count: samples.length,
    samples,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    maximum: rounded(Math.max(...samples)),
  };
}
