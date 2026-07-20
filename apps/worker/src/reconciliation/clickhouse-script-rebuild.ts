import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { FreshClickHouseRebuildPlan } from "@tokenpilot/reconciliation-engine";

import type { ClickHouseRebuildExecutor } from "./operation-executor.js";

const executeFile = promisify(execFile);

export interface ClickHouseScriptRebuildOptions {
  readonly evidenceDirectory: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runCommand?: (
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly encoding: "utf8";
      readonly timeout: number;
      readonly maxBuffer: number;
    },
  ) => Promise<{ readonly stdout: string }>;
}

function output(value: string): Readonly<Record<string, unknown>> {
  const line = value
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) throw new Error("ClickHouse rebuild returned no result");
  const parsed: unknown = JSON.parse(line);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { readonly status?: unknown }).status !== "passed"
  ) {
    throw new Error("ClickHouse rebuild returned an invalid result");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/** Runs a guarded fresh-schema rebuild; the child owns sink pause, replay, and verification. */
export class ClickHouseScriptRebuildExecutor implements ClickHouseRebuildExecutor {
  private readonly root: string;
  private readonly evidenceDirectory: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: ClickHouseScriptRebuildOptions) {
    this.root = resolve(options.workspaceRoot ?? process.cwd());
    this.evidenceDirectory = isAbsolute(options.evidenceDirectory)
      ? options.evidenceDirectory
      : resolve(this.root, options.evidenceDirectory);
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.environment = options.environment ?? process.env;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new RangeError("ClickHouse rebuild timeout must be at least one second");
    }
  }

  async execute(
    plan: FreshClickHouseRebuildPlan,
    context: { readonly runId: string; readonly reason: string },
  ): Promise<Readonly<Record<string, unknown>>> {
    if (context.runId !== plan.rebuildId) {
      throw new TypeError("Reconciliation run and rebuild plan identities must match");
    }
    if (
      this.environment.CLICKHOUSE_FRESH_REBUILD_ALLOWED !== "true" ||
      !this.environment.CLICKHOUSE_MIGRATION_USERNAME ||
      !this.environment.CLICKHOUSE_MIGRATION_PASSWORD
    ) {
      throw new Error(
        "ClickHouse fresh rebuild requires operator-run release tooling; the Worker has no DDL credentials",
      );
    }
    await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.evidenceDirectory, 0o700);
    const planPath = join(this.evidenceDirectory, `${plan.rebuildId}.plan.json`);
    const evidencePath = join(this.evidenceDirectory, `${plan.rebuildId}.evidence.json`);
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(planPath, 0o600);
    try {
      const result = await (this.options.runCommand ?? executeFile)(
        process.execPath,
        [
          resolve(this.root, "scripts/release/clickhouse-fresh-rebuild.mjs"),
          "--plan",
          planPath,
          "--actor",
          "worker:reconciliation",
          "--reason",
          context.reason,
          "--evidence",
          evidencePath,
          "--acknowledge-fresh-database",
        ],
        {
          cwd: this.root,
          env: this.environment,
          encoding: "utf8",
          timeout: this.timeoutMs,
          maxBuffer: 1_048_576,
        },
      );
      return { ...output(result.stdout), evidence_path: evidencePath, plan_path: planPath };
    } catch {
      throw new Error("ClickHouse fresh rebuild failed; inspect its private evidence file");
    }
  }
}
