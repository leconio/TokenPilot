import { Prisma } from "./generated/prisma/client.js";

export type DatabaseQueryOperation =
  | "read_one"
  | "read_many"
  | "aggregate"
  | "create"
  | "update"
  | "delete"
  | "raw_read"
  | "raw_write"
  | "other";

export type DatabaseQueryOutcome = "success" | "error";

export interface DatabaseQueryObservation {
  readonly model: string;
  readonly operation: DatabaseQueryOperation;
  readonly outcome: DatabaseQueryOutcome;
  readonly durationSeconds: number;
}

export type DatabaseQueryObserver = (observation: DatabaseQueryObservation) => void;

const knownModels = new Set<string>(Object.values(Prisma.ModelName));

const operationClasses: Readonly<Record<string, DatabaseQueryOperation>> = {
  findUnique: "read_one",
  findUniqueOrThrow: "read_one",
  findFirst: "read_one",
  findFirstOrThrow: "read_one",
  findMany: "read_many",
  count: "aggregate",
  aggregate: "aggregate",
  groupBy: "aggregate",
  create: "create",
  createMany: "create",
  createManyAndReturn: "create",
  update: "update",
  updateMany: "update",
  updateManyAndReturn: "update",
  upsert: "update",
  delete: "delete",
  deleteMany: "delete",
  $queryRaw: "raw_read",
  queryRaw: "raw_read",
  $executeRaw: "raw_write",
  executeRaw: "raw_write",
};

export function normalizeDatabaseQueryModel(model: string | undefined): string {
  if (model === undefined) return "raw";
  return knownModels.has(model) ? model : "unknown";
}

export function normalizeDatabaseQueryOperation(operation: string): DatabaseQueryOperation {
  return operationClasses[operation] ?? "other";
}

interface ObservedDatabaseQuery<T> {
  readonly model: string | undefined;
  readonly operation: string;
  readonly execute: () => PromiseLike<T>;
}

/** @internal Exported for deterministic unit testing of the instrumentation boundary. */
export async function executeObservedDatabaseQuery<T>(
  input: ObservedDatabaseQuery<T>,
  observer: DatabaseQueryObserver,
  now: () => bigint = process.hrtime.bigint,
): Promise<T> {
  const started = now();
  let outcome: DatabaseQueryOutcome = "success";
  try {
    return await input.execute();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    const observation: DatabaseQueryObservation = {
      model: normalizeDatabaseQueryModel(input.model),
      operation: normalizeDatabaseQueryOperation(input.operation),
      outcome,
      durationSeconds: Math.max(0, Number(now() - started) / 1_000_000_000),
    };
    try {
      observer(observation);
    } catch {
      // Telemetry is best effort and must never change a database operation's result.
    }
  }
}
