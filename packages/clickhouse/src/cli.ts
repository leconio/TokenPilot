#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { closeClickHouseClients, getClickHouseClient } from "./client/singleton.js";
import { loadClickHouseConfig, publicClickHouseConfig } from "./config.js";
import { sanitizeClickHouseError } from "./errors.js";
import { checkClickHouseHealth } from "./health.js";
import {
  applyClickHouseMigrations,
  discoverClickHouseMigrations,
  getClickHouseMigrationStatus,
  verifyClickHouseMigrations,
} from "./migrations.js";

type CliCommand = "status" | "up" | "verify";

function parseCommand(value: string | undefined): CliCommand {
  if (value === "status" || value === "up" || value === "verify") {
    return value;
  }
  throw new Error("Usage: tokenpilot-clickhouse <status|up|verify>");
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const config = loadClickHouseConfig(process.env, {
    role: "migration",
  });
  const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
  const migrationsDirectory = process.env.CLICKHOUSE_MIGRATIONS_DIR ?? defaultMigrationsDirectory;
  const migrations = await discoverClickHouseMigrations(migrationsDirectory);
  const client = getClickHouseClient(config, "migration");

  try {
    const health = await checkClickHouseHealth(client);
    if (!health.ok) {
      throw new Error(`ClickHouse health check failed: ${health.error}`);
    }

    if (command === "status") {
      const status = await getClickHouseMigrationStatus(client, config.database, migrations);
      process.stdout.write(
        `${JSON.stringify({ command, config: publicClickHouseConfig(config), health, status }, null, 2)}\n`,
      );
      return;
    }

    if (command === "up") {
      const result = await applyClickHouseMigrations(client, config.database, migrations);
      process.stdout.write(
        `${JSON.stringify({ command, config: publicClickHouseConfig(config), health, result }, null, 2)}\n`,
      );
      return;
    }

    const status = await verifyClickHouseMigrations(client, config.database, migrations);
    process.stdout.write(
      `${JSON.stringify({ command, config: publicClickHouseConfig(config), health, status }, null, 2)}\n`,
    );
  } finally {
    await closeClickHouseClients("migration");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${sanitizeClickHouseError(error)}\n`);
  process.exitCode = 1;
});
