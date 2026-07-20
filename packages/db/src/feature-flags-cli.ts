import { pathToFileURL } from "node:url";

import {
  featureRuntimePrerequisitesFromEnvironment,
  INSTANCE_FEATURE_FLAG_NAMES,
  instanceFeatureConfigurationIssues,
  InvalidInstanceFeatureConfigurationError,
  loadFeatureFlagOperatorEnvironment,
  type InstanceFeatureFlagName,
} from "@tokenpilot/shared";

import { createPrismaClient } from "./client.js";
import {
  InvalidFeatureFlagUpdateError,
  setInstanceFeatureFlags,
  type InstanceFeatureFlagPatch,
} from "./feature-flag-operator.js";
import {
  InstanceSettingsNotInitializedError,
  readInstanceFeatureFlags,
} from "./instance-settings.js";

const usage = `Usage:
  pnpm ops:feature-flags show
  pnpm ops:feature-flags set <flag>=<true|false> [...] --actor <id> --reason <text>

Flags:
  ${INSTANCE_FEATURE_FLAG_NAMES.join("\n  ")}

Feature flags are persisted in PostgreSQL. A successful change requires the
Worker service to be restarted before it takes effect there. Audit reasons must
describe the change and must never contain passwords, tokens, or other secrets.`;

export type FeatureFlagCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "show" }
  | {
      readonly kind: "set";
      readonly patch: InstanceFeatureFlagPatch;
      readonly actorId: string;
      readonly reason: string;
    };

export class FeatureFlagCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureFlagCliUsageError";
  }
}

function requireOptionValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new FeatureFlagCliUsageError(`${option} requires a value`);
  }
  return value;
}

export function parseFeatureFlagCliCommand(arguments_: readonly string[]): FeatureFlagCliCommand {
  const [command, ...rest] = arguments_;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "show") {
    if (rest.length > 0) throw new FeatureFlagCliUsageError("show does not accept arguments");
    return { kind: "show" };
  }
  if (command !== "set") throw new FeatureFlagCliUsageError(`Unknown command: ${command}`);

  const patch: Partial<Record<InstanceFeatureFlagName, boolean>> = {};
  let actorId: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--actor") {
      actorId = requireOptionValue(rest, index, "--actor");
      index += 1;
      continue;
    }
    if (argument === "--reason") {
      reason = requireOptionValue(rest, index, "--reason");
      index += 1;
      continue;
    }
    const match = /^([a-z][a-z0-9_]+)=(true|false)$/u.exec(argument ?? "");
    if (match === null) {
      throw new FeatureFlagCliUsageError(`Invalid flag assignment: ${argument ?? "(missing)"}`);
    }
    const name = match[1] as InstanceFeatureFlagName;
    if (!INSTANCE_FEATURE_FLAG_NAMES.includes(name)) {
      throw new FeatureFlagCliUsageError(`Unknown feature flag: ${name}`);
    }
    if (patch[name] !== undefined) {
      throw new FeatureFlagCliUsageError(`Duplicate feature flag assignment: ${name}`);
    }
    patch[name] = match[2] === "true";
  }
  if (Object.keys(patch).length === 0) {
    throw new FeatureFlagCliUsageError("set requires at least one flag assignment");
  }
  if (actorId === undefined) throw new FeatureFlagCliUsageError("set requires --actor");
  if (reason === undefined) throw new FeatureFlagCliUsageError("set requires --reason");
  return { kind: "set", patch: Object.freeze(patch), actorId, reason };
}

function knownOperatorError(error: unknown): error is Error {
  return (
    error instanceof FeatureFlagCliUsageError ||
    error instanceof InvalidFeatureFlagUpdateError ||
    error instanceof InvalidInstanceFeatureConfigurationError ||
    error instanceof InstanceSettingsNotInitializedError ||
    (error instanceof Error && error.name === "ZodError")
  );
}

async function main(): Promise<void> {
  let command: FeatureFlagCliCommand;
  try {
    command = parseFeatureFlagCliCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid command"}\n${usage}\n`,
    );
    process.exitCode = 64;
    return;
  }
  if (command.kind === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  let database: ReturnType<typeof createPrismaClient> | undefined;
  try {
    const environment = loadFeatureFlagOperatorEnvironment(process.env);
    const runtime = featureRuntimePrerequisitesFromEnvironment(environment);
    database = createPrismaClient(environment.DATABASE_URL);
    if (command.kind === "show") {
      const flags = await readInstanceFeatureFlags(database);
      const issues = instanceFeatureConfigurationIssues(flags, runtime);
      process.stdout.write(
        `${JSON.stringify(
          {
            source: "postgresql",
            effective_configuration: issues.length === 0 ? "valid" : "invalid",
            configuration_issues: issues,
            feature_flags: flags,
            worker_refresh_policy: "startup_snapshot_restart_required",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const result = await setInstanceFeatureFlags(database, {
      patch: command.patch,
      runtime,
      actorId: command.actorId,
      reason: command.reason,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          source: "postgresql",
          feature_flags: result.after,
          changed_flags: result.changedFlags,
          worker_restart_required: result.workerRestartRequired,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${knownOperatorError(error) ? error.message : "Feature flag command failed"}\n`,
    );
    process.exitCode = knownOperatorError(error) ? 2 : 1;
  } finally {
    try {
      await database?.$disconnect();
    } catch {
      if (process.exitCode === undefined) {
        process.stderr.write("Feature flag command failed while closing the database connection\n");
        process.exitCode = 1;
      }
    }
  }
}

const executablePath = process.argv[1];
if (executablePath !== undefined && import.meta.url === pathToFileURL(executablePath).href) {
  void main().catch(() => {
    process.stderr.write("Feature flag command failed\n");
    process.exitCode = 1;
  });
}
