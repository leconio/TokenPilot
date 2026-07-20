import { ZodError } from "zod";

import type { PipelineFailure, PipelineStageName } from "./types.js";

interface ErrorWithCode {
  readonly code?: unknown;
  readonly originalCode?: unknown;
  readonly sqlState?: unknown;
  readonly meta?: unknown;
  readonly cause?: unknown;
  readonly driverAdapterError?: unknown;
}

const RETRYABLE_DATABASE_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

export class PermanentPipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export class RetryablePipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

function collectErrorCodes(
  value: unknown,
  candidates: string[],
  visited: Set<object>,
  depth = 0,
): void {
  if (typeof value !== "object" || value === null || depth > 4 || visited.has(value)) return;
  visited.add(value);
  const typed = value as ErrorWithCode;
  for (const code of [typed.code, typed.originalCode, typed.sqlState]) {
    if (typeof code === "string" && code.length > 0) candidates.push(code);
  }
  for (const nested of [typed.meta, typed.cause, typed.driverAdapterError]) {
    collectErrorCodes(nested, candidates, visited, depth + 1);
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  // Prisma's client engine wraps adapter errors as
  // meta.driverAdapterError.cause.originalCode while other engines expose
  // meta.code. Walk only the known error-envelope fields and prefer an
  // actionable transient SQLSTATE over the outer P2010 wrapper.
  const candidates: string[] = [];
  collectErrorCodes(error, candidates, new Set());
  return (
    candidates.find((candidate) => RETRYABLE_DATABASE_CODES.has(candidate)) ?? candidates[0] ?? null
  );
}

export function classifyPipelineError(error: unknown, stage: PipelineStageName): PipelineFailure {
  if (error instanceof PermanentPipelineError) {
    return {
      code: error.code,
      errorClass: error.constructor.name,
      message: error.message,
      retryable: false,
      details: error.details,
    };
  }
  if (error instanceof RetryablePipelineError) {
    return {
      code: error.code,
      errorClass: error.constructor.name,
      message: error.message,
      retryable: true,
      details: error.details,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "INVALID_USAGE_PAYLOAD",
      errorClass: error.constructor.name,
      message: "Inbox payload no longer satisfies Usage Event",
      retryable: false,
      details: { stage, issues: error.issues },
    };
  }
  const code = errorCode(error);
  const retryable = code !== null && RETRYABLE_DATABASE_CODES.has(code);
  return {
    code: code ?? (retryable ? "PIPELINE_TRANSIENT_FAILURE" : "PIPELINE_STAGE_FAILURE"),
    errorClass: error instanceof Error ? error.constructor.name : "UnknownPipelineError",
    message: error instanceof Error ? error.message : "Unknown pipeline failure",
    retryable,
    details: { stage },
  };
}

export function retryDelayMs(
  attemptCount: number,
  baseDelayMs = 1_000,
  maximumMs = 300_000,
): number {
  const exponent = Math.max(0, Math.min(20, attemptCount - 1));
  return Math.min(maximumMs, baseDelayMs * 2 ** exponent);
}
