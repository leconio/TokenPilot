export const REQUIRED_SAMPLE_COUNT: 7;

export interface SampleSummary {
  readonly count: number;
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly maximum: number;
}

export function rounded(value: number, digits?: number): number;
export function finiteSamples(values: unknown, name: string, minimum?: number): readonly number[];
export function percentile(values: readonly number[], percentileValue: number): number;
export function sampleSummary(values: readonly number[]): SampleSummary;
