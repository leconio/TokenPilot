import { existsSync } from "node:fs";

import { batchIngestionResponseSchema, type UsageEvent } from "@tokenpilot/contracts";

import { AiControlSdkError } from "../errors.js";
import { DurableUsageSpool } from "./usage-spool.js";

export class RuntimeUsageReporter {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #batchSize: number;
  readonly #request: (path: string, body: unknown) => Promise<Response>;
  readonly #now: () => Date;
  readonly #onError: (error: Error) => void;
  #spool: DurableUsageSpool | null = null;

  public constructor(options: {
    readonly path: string;
    readonly maxBytes: number;
    readonly batchSize: number;
    readonly request: (path: string, body: unknown) => Promise<Response>;
    readonly now: () => Date;
    readonly onError: (error: Error) => void;
  }) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes;
    this.#batchSize = options.batchSize;
    this.#request = options.request;
    this.#now = options.now;
    this.#onError = options.onError;
    if (existsSync(this.#path)) this.#spool = new DurableUsageSpool(this.#path, this.#maxBytes);
  }

  public async report(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    const spool = this.spool();
    for (const event of events) spool.enqueue(event);
    await this.flush();
  }

  public async flush(): Promise<number> {
    const spool = this.spool();
    let delivered = 0;
    while (true) {
      const pending = spool.pending(this.#batchSize);
      if (pending.length === 0) return delivered;
      const response = await this.#request("/usage-events/batch", {
        schema_version: "2.0",
        batch_id: pending[0]!.eventId,
        sent_at: this.#now().toISOString(),
        events: pending.map((item) => item.payload),
      });
      const result = batchIngestionResponseSchema.parse(await response.json());
      for (const item of result.results) {
        const eventId = item.event_id ?? pending[item.index]?.eventId;
        if (eventId === undefined) continue;
        if (item.status === "accepted" || item.status === "duplicate") {
          delivered += spool.acknowledge([eventId]);
        } else {
          spool.reject(eventId, item.code ?? item.status.toUpperCase());
          this.#onError(
            new AiControlSdkError(
              "SDK_USAGE_EVENT_REJECTED",
              item.message ?? `Usage event ${eventId} was ${item.status}.`,
            ),
          );
        }
      }
    }
  }

  public async flushQuietly(): Promise<void> {
    if (this.#spool === null) return;
    try {
      await this.flush();
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error("Usage upload failed"));
    }
  }

  public close(): void {
    this.#spool?.close();
    this.#spool = null;
  }

  private spool(): DurableUsageSpool {
    this.#spool ??= new DurableUsageSpool(this.#path, this.#maxBytes);
    return this.#spool;
  }
}
