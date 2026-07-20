import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { usageEventSchema, type UsageEvent } from "@tokenpilot/contracts";

const FORMAT_REVISION = 1;

export class UsageSpoolCapacityError extends Error {
  public constructor(
    readonly currentBytes: number,
    readonly maximumBytes: number,
  ) {
    super("Durable usage spool capacity reached.");
  }
}

export interface SpooledUsageEvent {
  readonly eventId: string;
  readonly payload: UsageEvent;
}

function fileBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${path}${suffix}`).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

/** Shared current SQLite spool layout used by the trusted Node and Python SDKs. */
export class DurableUsageSpool {
  readonly #database: DatabaseSync;

  public constructor(
    readonly path: string,
    readonly maximumBytes: number,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new TypeError("usageSpoolMaxBytes must be a positive safe integer");
    }
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout=10000");
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    const revision = Number(this.#database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (revision !== 0 && revision !== FORMAT_REVISION) {
      this.#database.close();
      throw new Error(`Usage spool format ${revision} is not supported; delete ${path} and retry.`);
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_events_created_idx
        ON usage_events (created_at, event_id);
      CREATE TABLE IF NOT EXISTS usage_rejected (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        rejected_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=${FORMAT_REVISION};
    `);
  }

  public enqueue(event: UsageEvent): boolean {
    const validated = usageEventSchema.parse(event);
    const serialized = JSON.stringify(validated);
    const known = this.#database
      .prepare(
        "SELECT 1 AS found FROM usage_events WHERE event_id = ? UNION ALL " +
          "SELECT 1 AS found FROM usage_rejected WHERE event_id = ? LIMIT 1",
      )
      .get(validated.event_id, validated.event_id);
    if (known !== undefined) return false;
    const currentBytes = fileBytes(this.path);
    if (currentBytes + Buffer.byteLength(serialized, "utf8") > this.maximumBytes) {
      throw new UsageSpoolCapacityError(currentBytes, this.maximumBytes);
    }
    const result = this.#database
      .prepare(
        "INSERT OR IGNORE INTO usage_events (event_id, payload_json, created_at) VALUES (?, ?, ?)",
      )
      .run(validated.event_id, serialized, Date.now());
    return result.changes === 1;
  }

  public pending(limit: number): readonly SpooledUsageEvent[] {
    const rows = this.#database
      .prepare("SELECT event_id, payload_json FROM usage_events ORDER BY rowid LIMIT ?")
      .all(limit);
    return rows.map((row) => ({
      eventId: String(row.event_id),
      payload: usageEventSchema.parse(JSON.parse(String(row.payload_json))),
    }));
  }

  public acknowledge(eventIds: readonly string[]): number {
    if (eventIds.length === 0) return 0;
    const remove = this.#database.prepare("DELETE FROM usage_events WHERE event_id = ?");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let removed = 0;
      for (const eventId of eventIds) removed += Number(remove.run(eventId).changes);
      this.#database.exec("COMMIT");
      return removed;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public reject(eventId: string, reasonCode: string): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "INSERT OR IGNORE INTO usage_rejected " +
            "(event_id, payload_json, reason_code, rejected_at) " +
            "SELECT event_id, payload_json, ?, ? FROM usage_events WHERE event_id = ?",
        )
        .run(reasonCode.slice(0, 120), Date.now(), eventId);
      this.#database.prepare("DELETE FROM usage_events WHERE event_id = ?").run(eventId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public get depth(): number {
    return Number(
      this.#database.prepare("SELECT COUNT(*) AS count FROM usage_events").get()?.count,
    );
  }

  public close(): void {
    this.#database.close();
  }
}
