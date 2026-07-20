import { resolve } from "node:path";

import type { RuntimeSnapshot } from "@tokenpilot/contracts";

import { AiControlSdkError } from "../errors.js";
import { readLkg, writeLkgAtomically } from "../lkg.js";
import { RuntimeAcknowledgementQueue } from "./acknowledgements.js";
import { parseVerifiedRuntimeSnapshot } from "./snapshot-validation.js";
import type { RuntimeFailMode, RuntimeRefreshResult } from "./types.js";

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown runtime SDK failure");
}

export class RuntimeSnapshotManager {
  readonly #controlPlaneUrl: string;
  readonly #apiKey: string;
  readonly #lkgPath: string;
  readonly #failMode: RuntimeFailMode;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #onError: (error: Error) => void;
  readonly #afterRefresh: () => Promise<void>;
  readonly #acknowledgements: RuntimeAcknowledgementQueue;
  #snapshot: RuntimeSnapshot | null = null;
  #source: "remote" | "lkg" = "lkg";

  public constructor(options: {
    readonly controlPlaneUrl: string;
    readonly apiKey: string;
    readonly lkgPath: string;
    readonly failMode: RuntimeFailMode;
    readonly fetch: typeof fetch;
    readonly now: () => Date;
    readonly onError: (error: Error) => void;
    readonly afterRefresh: () => Promise<void>;
    readonly instanceId: string;
    readonly sdkVersion: string;
  }) {
    this.#controlPlaneUrl = options.controlPlaneUrl;
    this.#apiKey = options.apiKey;
    this.#lkgPath = resolve(options.lkgPath);
    this.#failMode = options.failMode;
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#onError = options.onError;
    this.#afterRefresh = options.afterRefresh;
    this.#acknowledgements = new RuntimeAcknowledgementQueue({
      controlPlaneUrl: options.controlPlaneUrl,
      apiKey: options.apiKey,
      identity: { instanceId: options.instanceId, version: options.sdkVersion },
      fetch: options.fetch,
      now: options.now,
      onError: options.onError,
    });
  }

  public get snapshot(): RuntimeSnapshot | null {
    return this.#snapshot === null ? null : structuredClone(this.#snapshot);
  }

  public get source(): "remote" | "lkg" {
    return this.#source;
  }

  public async loadLkg(): Promise<boolean> {
    const candidate = await readLkg(this.#lkgPath);
    if (candidate === null) return false;
    this.#snapshot = parseVerifiedRuntimeSnapshot(candidate, this.#now(), { allowExpired: true });
    this.#source = "lkg";
    return true;
  }

  public requireUsable(): RuntimeSnapshot {
    if (this.#snapshot === null) {
      throw new AiControlSdkError("SDK_RUNTIME_UNAVAILABLE", "No Runtime Snapshot is loaded.");
    }
    if (
      Date.parse(this.#snapshot.expires_at) <= this.#now().getTime() &&
      this.#failMode === "fail_closed"
    ) {
      throw new AiControlSdkError("SDK_RUNTIME_EXPIRED", "Runtime Snapshot has expired.");
    }
    return this.#snapshot;
  }

  public async refresh(): Promise<RuntimeRefreshResult> {
    try {
      await this.#acknowledgements.flush(true);
      const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}` };
      if (this.#snapshot !== null) headers["if-none-match"] = `"${this.#snapshot.etag}"`;
      const response = await this.#fetch(`${this.#controlPlaneUrl}/runtime/snapshot`, {
        method: "GET",
        headers,
      });
      if (response.status === 304) {
        if (this.#snapshot === null) {
          throw new AiControlSdkError(
            "SDK_UNEXPECTED_NOT_MODIFIED",
            "Control Plane returned 304 without a Runtime Snapshot.",
          );
        }
        parseVerifiedRuntimeSnapshot(this.#snapshot, this.#now(), { allowExpired: false });
        this.#source = "remote";
        await this.#afterRefresh();
        return this.result("not_modified");
      }
      if (!response.ok) {
        throw new AiControlSdkError(
          "SDK_RUNTIME_FETCH_FAILED",
          `Control Plane returned HTTP ${response.status}.`,
        );
      }
      const rawCandidate: unknown = await response.json();
      let candidate: RuntimeSnapshot;
      try {
        candidate = parseVerifiedRuntimeSnapshot(rawCandidate, this.#now(), {
          allowExpired: false,
        });
        if (
          this.#snapshot !== null &&
          candidate.version === this.#snapshot.version &&
          candidate.etag !== this.#snapshot.etag
        ) {
          throw new AiControlSdkError(
            "SDK_RUNTIME_VERSION_COLLISION",
            "Runtime Snapshot version was reused with another ETag.",
          );
        }
      } catch (error) {
        const failure = errorValue(error);
        this.#acknowledgements.queue(rawCandidate, "rejected", failure);
        await this.#acknowledgements.flush(false);
        throw failure;
      }
      this.#acknowledgements.queue(candidate, "received");
      await this.#acknowledgements.flush(true);
      try {
        await writeLkgAtomically(this.#lkgPath, candidate);
        this.#snapshot = candidate;
      } catch (error) {
        const failure = errorValue(error);
        this.#acknowledgements.queue(candidate, "rejected", failure);
        await this.#acknowledgements.flush(false);
        throw failure;
      }
      this.#source = "remote";
      this.#acknowledgements.queue(candidate, "applied");
      await this.#acknowledgements.flush(false);
      await this.#afterRefresh();
      return this.result("updated");
    } catch (error) {
      const failure = errorValue(error);
      this.#onError(failure);
      if (this.#snapshot === null) await this.loadLkg();
      if (this.#snapshot === null) throw failure;
      this.#source = "lkg";
      return this.result("lkg");
    }
  }

  private result(status: RuntimeRefreshResult["status"]): RuntimeRefreshResult {
    const snapshot = this.requireUsable();
    return {
      status,
      version: snapshot.version,
      etag: snapshot.etag,
      expired: Date.parse(snapshot.expires_at) <= this.#now().getTime(),
    };
  }
}
