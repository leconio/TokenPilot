import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";
import { executeObservedDatabaseQuery, type DatabaseQueryObserver } from "./query-observability.js";

interface DatabaseQueryObserverState {
  observer: DatabaseQueryObserver | undefined;
}

const observerStates = new WeakMap<object, DatabaseQueryObserverState>();

function withDatabaseQueryObservability(database: PrismaClient, state: DatabaseQueryObserverState) {
  return database.$extends({
    name: "databaseQueryObservability",
    query: {
      $allOperations({ model, operation, args, query }) {
        const observer = state.observer;
        if (observer === undefined) return query(args);
        return executeObservedDatabaseQuery(
          {
            model,
            operation,
            execute: () => query(args),
          },
          observer,
        );
      },
    },
  });
}

export type DatabaseClient = ReturnType<typeof withDatabaseQueryObservability>;

export function createPrismaClient(databaseUrl: string): DatabaseClient {
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const state: DatabaseQueryObserverState = { observer: undefined };
  const database = withDatabaseQueryObservability(
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    }),
    state,
  );
  observerStates.set(database, state);
  return database;
}

export function registerDatabaseQueryObserver(
  database: DatabaseClient,
  observer: DatabaseQueryObserver,
): () => void {
  const state = observerStates.get(database);
  if (state === undefined) {
    throw new Error("Database client does not support query observation");
  }
  state.observer = observer;
  return () => {
    if (state.observer === observer) state.observer = undefined;
  };
}
