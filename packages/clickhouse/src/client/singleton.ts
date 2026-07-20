import type { ClickHouseClient } from "@clickhouse/client";

import { createClickHouseClient } from "../client.js";
import type { ClickHouseRuntimeConfig } from "../config.js";
import { ClickHouseConfigurationError } from "../errors.js";

export type ClickHouseClientRole = "application" | "migration";

export type ClickHouseClientFactory = (config: ClickHouseRuntimeConfig) => ClickHouseClient;

interface RegistryEntry {
  readonly config: ClickHouseRuntimeConfig;
  readonly client: ClickHouseClient;
}

function sameConfig(left: ClickHouseRuntimeConfig, right: ClickHouseRuntimeConfig): boolean {
  return (
    left.url === right.url &&
    left.database === right.database &&
    left.username === right.username &&
    left.password === right.password &&
    left.requestTimeoutMs === right.requestTimeoutMs &&
    left.maxOpenConnections === right.maxOpenConnections &&
    left.asyncInsert === right.asyncInsert &&
    left.waitForAsyncInsert === right.waitForAsyncInsert
  );
}

/** Owns one official client per credential role for the process lifetime. */
export class ClickHouseClientRegistry {
  readonly #entries = new Map<ClickHouseClientRole, RegistryEntry>();

  public constructor(private readonly factory: ClickHouseClientFactory = createClickHouseClient) {}

  public get(config: ClickHouseRuntimeConfig, role: ClickHouseClientRole): ClickHouseClient {
    const current = this.#entries.get(role);
    if (current !== undefined) {
      if (!sameConfig(current.config, config)) {
        throw new ClickHouseConfigurationError(
          `The ${role} ClickHouse singleton is already initialized with different settings`,
        );
      }
      return current.client;
    }

    const client = this.factory(config);
    this.#entries.set(role, { config, client });
    return client;
  }

  public async close(role?: ClickHouseClientRole): Promise<void> {
    const selected =
      role === undefined
        ? [...this.#entries.entries()]
        : [...this.#entries.entries()].filter(([entryRole]) => entryRole === role);
    for (const [entryRole] of selected) this.#entries.delete(entryRole);
    await Promise.all(selected.map(([, entry]) => entry.client.close()));
  }
}

const processClients = new ClickHouseClientRegistry();

export function getClickHouseClient(
  config: ClickHouseRuntimeConfig,
  role: ClickHouseClientRole = "application",
): ClickHouseClient {
  return processClients.get(config, role);
}

export async function closeClickHouseClients(role?: ClickHouseClientRole): Promise<void> {
  await processClients.close(role);
}
