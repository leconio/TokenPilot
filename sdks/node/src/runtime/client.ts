import { resolve } from "node:path";

import {
  runtimeUserReservationRequestSchema,
  runtimeUserReservationResponseSchema,
  type RuntimeSnapshot,
  type RuntimeUserReservationRequest,
  type RuntimeUserReservationResponse,
} from "@tokenpilot/contracts";

import { readLkg, writeLkgAtomically } from "../lkg.js";
import { RuntimeAcknowledgementQueue } from "./acknowledgements.js";
import {
  resolveRuntimeRoute,
  type RuntimeRouteContext,
  type RuntimeRouteSelection,
} from "./routing.js";
import { parseVerifiedRuntimeSnapshot } from "./snapshot-validation.js";
import { AiControlSdkError } from "../errors.js";
import type {
  ResolvedAiRuntimeContext,
  RuntimeClientOptions,
  RuntimeRefreshResult,
  SdkMetadataEnvelope,
  SdkReservationResult,
} from "./types.js";

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AiControlSdkError("SDK_INVALID_CONFIGURATION", "Control Plane URL must use HTTP(S).");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown runtime SDK failure");
}

function allowedDimensions(
  values: Readonly<Record<string, string | number | boolean>>,
  allowed: readonly string[],
): Readonly<Record<string, string | number | boolean>> {
  const allowedKeys = new Set(allowed);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowedKeys.has(key)) {
      throw new AiControlSdkError(
        "SDK_DIMENSION_NOT_ALLOWED",
        `Analytics dimension ${key} is not allowed by the Runtime Snapshot.`,
      );
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

export class AiRuntimeClient {
  readonly #controlPlaneUrl: string;
  readonly #apiKey: string;
  readonly #acknowledgements: RuntimeAcknowledgementQueue;
  readonly #lkgPath: string;
  readonly #failMode: "fail_open" | "fail_closed";
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #sdkVersion: string;
  readonly #onError: (error: Error) => void;
  #snapshot: RuntimeSnapshot | null = null;
  #source: "remote" | "lkg" = "lkg";

  public constructor(options: RuntimeClientOptions) {
    if (options.apiKey.length < 16) {
      throw new AiControlSdkError("SDK_INVALID_CONFIGURATION", "A server API key is required.");
    }
    this.#controlPlaneUrl = normalizedUrl(options.controlPlaneUrl);
    this.#apiKey = options.apiKey;
    this.#lkgPath = resolve(options.lkgPath ?? ".tokenpilot/runtime-snapshot.json");
    this.#failMode = options.failMode ?? "fail_open";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sdkVersion = options.sdkVersion ?? "0.2.0";
    this.#onError = options.onError ?? (() => undefined);
    this.#acknowledgements = new RuntimeAcknowledgementQueue({
      controlPlaneUrl: this.#controlPlaneUrl,
      apiKey: this.#apiKey,
      identity: {
        instanceId: options.instanceId ?? "node-sdk",
        version: options.sdkVersion ?? "0.2.0",
      },
      fetch: this.#fetch,
      now: this.#now,
      onError: this.#onError,
    });
  }

  public get snapshot(): RuntimeSnapshot | null {
    return this.#snapshot === null ? null : structuredClone(this.#snapshot);
  }

  public get snapshotSource(): "remote" | "lkg" {
    return this.#source;
  }

  public async loadLkg(): Promise<boolean> {
    const candidate = await readLkg(this.#lkgPath);
    if (candidate === null) return false;
    this.#snapshot = parseVerifiedRuntimeSnapshot(candidate, this.#now(), { allowExpired: true });
    this.#source = "lkg";
    return true;
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
        return this.refreshResult("not_modified");
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
      return this.refreshResult("updated");
    } catch (error) {
      const failure = errorValue(error);
      this.#onError(failure);
      if (this.#snapshot === null) await this.loadLkg();
      if (this.#snapshot === null) throw failure;
      this.#source = "lkg";
      return this.refreshResult("lkg");
    }
  }

  public createMetadataEnvelope(context: ResolvedAiRuntimeContext): SdkMetadataEnvelope {
    const snapshot = this.requireUsableSnapshot();
    const analyticsDimensions = allowedDimensions(
      context.analyticsDimensions,
      snapshot.dimensions.analytics_allowed_keys,
    );
    return Object.freeze({
      context_version: snapshot.version,
      operation_id: context.operationId,
      user_id: context.userId,
      ...(context.displayUser === null ? {} : { display_user: context.displayUser }),
      ...(context.applicationVersion === null
        ? {}
        : { application_version: context.applicationVersion }),
      sdk_version: this.#sdkVersion,
      ...(context.parentRequestId === null ? {} : { parent_request_id: context.parentRequestId }),
      ...(context.sessionId === null ? {} : { session_id: context.sessionId }),
      ...(context.conversationId === null ? {} : { conversation_id: context.conversationId }),
      ...(Object.keys(context.eventProperties).length === 0
        ? {}
        : { event_properties: context.eventProperties }),
      ...(Object.keys(context.userProperties).length === 0
        ? {}
        : { user_properties: context.userProperties }),
      ...(context.callSource === null ? {} : { call_source: context.callSource }),
      request_id: context.requestId,
      trace_id: context.traceId,
      ...(Object.keys(analyticsDimensions).length === 0
        ? {}
        : { analytics_dimensions: analyticsDimensions }),
    });
  }

  public selectRoute(
    virtualModel: string,
    context: RuntimeRouteContext = {},
    now: Date = this.#now(),
  ): RuntimeRouteSelection {
    return resolveRuntimeRoute(this.requireUsableSnapshot(), virtualModel, now, context);
  }

  public async reserveUserAiu(input: RuntimeUserReservationRequest): Promise<SdkReservationResult> {
    const snapshot = this.requireUsableSnapshot();
    if (snapshot.aiu.mode !== "hard_limit") {
      return { status: "not_required", networkUsed: false, token: null };
    }
    const request = runtimeUserReservationRequestSchema.parse(input);
    try {
      const response = await this.request("/runtime/users/aiu/reservations", request);
      const result = runtimeUserReservationResponseSchema.parse(await response.json());
      if (!result.allowed) {
        throw new AiControlSdkError("SDK_USER_AIU_DENIED", `AIU access denied: ${result.reason}`);
      }
      return result.reservation === null
        ? { status: "allowed", networkUsed: true, token: null }
        : { status: "reserved", networkUsed: true, token: result.reservation };
    } catch (error) {
      return this.failOpenOrThrow(error, { status: "fail_open", networkUsed: true, token: null });
    }
  }

  public async settleUserAiuReservation(
    token: NonNullable<RuntimeUserReservationResponse["reservation"]>,
    settledAiuMicros: string,
  ): Promise<void> {
    await this.request(`/runtime/users/aiu/reservations/${encodeURIComponent(token.id)}/settle`, {
      reservation_token: token.token,
      settled_aiu_micros: settledAiuMicros,
    });
  }

  public async releaseUserAiuReservation(
    token: NonNullable<RuntimeUserReservationResponse["reservation"]>,
    reason: string,
  ): Promise<void> {
    await this.request(`/runtime/users/aiu/reservations/${encodeURIComponent(token.id)}/release`, {
      reservation_token: token.token,
      reason,
    });
  }

  private requireUsableSnapshot(): RuntimeSnapshot {
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

  private refreshResult(status: RuntimeRefreshResult["status"]): RuntimeRefreshResult {
    const snapshot = this.requireSnapshot();
    return {
      status,
      version: snapshot.version,
      etag: snapshot.etag,
      expired: Date.parse(snapshot.expires_at) <= this.#now().getTime(),
    };
  }

  private requireSnapshot(): RuntimeSnapshot {
    if (this.#snapshot === null) {
      throw new AiControlSdkError("SDK_RUNTIME_UNAVAILABLE", "No Runtime Snapshot is loaded.");
    }
    return this.#snapshot;
  }

  private async request(
    path: string,
    body: unknown,
    method: "POST" | "PUT" = "POST",
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#controlPlaneUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new AiControlSdkError(
        "SDK_RUNTIME_REQUEST_FAILED",
        `Control Plane returned HTTP ${response.status}.`,
      );
    }
    return response;
  }

  private failOpenOrThrow<T>(error: unknown, fallback: T): T {
    const failure = errorValue(error);
    this.#onError(failure);
    if (this.#failMode === "fail_closed") throw failure;
    return fallback;
  }
}

export function createAiRuntimeClient(options: RuntimeClientOptions): AiRuntimeClient {
  return new AiRuntimeClient(options);
}
