import { dirname, join, resolve } from "node:path";

import {
  runtimeUserReservationRequestSchema,
  runtimeUserReservationResponseSchema,
  type RuntimeCallConnection,
  type UsageEvent,
  type RuntimeSnapshot,
  type RuntimeUserReservationRequest,
  type RuntimeUserReservationResponse,
} from "@tokenpilot/contracts";

import {
  resolveRuntimeRoute,
  type RuntimeRouteContext,
  type RuntimeRouteSelection,
} from "./routing.js";
import { AiControlSdkError } from "../errors.js";
import { executeChat, executeChatStream } from "./chat.js";
import { requireAiContext } from "./context.js";
import { allowedDimensions, buildManualUsageEvent } from "./manual-usage.js";
import { RuntimeUsageReporter } from "./runtime-usage-reporter.js";
import { RuntimeSnapshotManager } from "./runtime-snapshot-manager.js";
import type {
  AiChatInput,
  AiChatResult,
  AiChatStream,
  AiProviderAdapter,
  RecordUsageInput,
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

export class AiRuntimeClient {
  readonly #controlPlaneUrl: string;
  readonly #apiKey: string;
  readonly #failMode: "fail_open" | "fail_closed";
  readonly #fetch: typeof fetch;
  readonly #providerFetch: typeof fetch;
  readonly #credentials: Readonly<Record<string, string>>;
  readonly #credentialResolver:
    | ((reference: string, connection: RuntimeCallConnection) => string | Promise<string>)
    | undefined;
  readonly #now: () => Date;
  readonly #sdkVersion: string;
  readonly #onError: (error: Error) => void;
  readonly #usageReporter: RuntimeUsageReporter;
  readonly #refreshIntervalMs: number;
  readonly #instanceId: string;
  readonly #providerAdapters: Map<RuntimeCallConnection["driver"], AiProviderAdapter>;
  readonly #connectionAdapters: Map<string, AiProviderAdapter>;
  readonly #runtimeState: RuntimeSnapshotManager;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #backgroundRefresh: Promise<unknown> | null = null;

  public constructor(options: RuntimeClientOptions) {
    if (options.apiKey.length < 16) {
      throw new AiControlSdkError("SDK_INVALID_CONFIGURATION", "A server API key is required.");
    }
    this.#controlPlaneUrl = normalizedUrl(options.controlPlaneUrl);
    this.#apiKey = options.apiKey;
    const lkgPath = resolve(options.lkgPath ?? ".tokenpilot/runtime-snapshot.json");
    const usageSpoolPath = resolve(
      options.usageSpoolPath ?? join(dirname(lkgPath), "usage-spool.sqlite3"),
    );
    const usageSpoolMaxBytes = options.usageSpoolMaxBytes ?? 64 * 1024 * 1024;
    const usageBatchSize = options.usageBatchSize ?? 100;
    if (!Number.isSafeInteger(usageBatchSize) || usageBatchSize < 1 || usageBatchSize > 1_000) {
      throw new AiControlSdkError(
        "SDK_INVALID_CONFIGURATION",
        "usageBatchSize must be an integer between 1 and 1000.",
      );
    }
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#refreshIntervalMs) ||
      this.#refreshIntervalMs < 0 ||
      (this.#refreshIntervalMs > 0 && this.#refreshIntervalMs < 1_000)
    ) {
      throw new AiControlSdkError(
        "SDK_INVALID_CONFIGURATION",
        "refreshIntervalMs must be 0 or an integer of at least 1000 milliseconds.",
      );
    }
    this.#failMode = options.failMode ?? "fail_open";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#providerFetch = options.providerFetch ?? globalThis.fetch;
    this.#credentials = Object.freeze({ ...(options.credentials ?? {}) });
    this.#credentialResolver = options.credentialResolver;
    this.#providerAdapters = new Map(
      Object.entries(options.providerAdapters ?? {}) as Array<
        [RuntimeCallConnection["driver"], AiProviderAdapter]
      >,
    );
    this.#connectionAdapters = new Map(Object.entries(options.connectionAdapters ?? {}));
    this.#now = options.now ?? (() => new Date());
    this.#sdkVersion = options.sdkVersion ?? "0.2.0";
    this.#instanceId = options.instanceId ?? "node-sdk";
    this.#onError = options.onError ?? (() => undefined);
    this.#usageReporter = new RuntimeUsageReporter({
      path: usageSpoolPath,
      maxBytes: usageSpoolMaxBytes,
      batchSize: usageBatchSize,
      request: (path, body) => this.request(path, body),
      now: this.#now,
      onError: this.#onError,
    });
    this.#runtimeState = new RuntimeSnapshotManager({
      controlPlaneUrl: this.#controlPlaneUrl,
      apiKey: this.#apiKey,
      lkgPath,
      failMode: this.#failMode,
      fetch: this.#fetch,
      now: this.#now,
      onError: this.#onError,
      afterRefresh: () => this.#usageReporter.flushQuietly(),
      instanceId: this.#instanceId,
      sdkVersion: this.#sdkVersion,
    });
  }

  public get snapshot(): RuntimeSnapshot | null {
    return this.#runtimeState.snapshot;
  }

  public get snapshotSource(): "remote" | "lkg" {
    return this.#runtimeState.source;
  }

  public async loadLkg(): Promise<boolean> {
    return this.#runtimeState.loadLkg();
  }

  /** Load current configuration and keep future requests current without restarting the app. */
  public async start(): Promise<RuntimeRefreshResult> {
    const result = await this.refresh();
    if (this.#refreshIntervalMs > 0 && this.#refreshTimer === null) {
      this.#refreshTimer = setInterval(() => {
        if (this.#backgroundRefresh !== null) return;
        this.#backgroundRefresh = this.refresh()
          .catch((error: unknown) => this.#onError(errorValue(error)))
          .finally(() => {
            this.#backgroundRefresh = null;
          });
      }, this.#refreshIntervalMs);
      this.#refreshTimer.unref?.();
    }
    return result;
  }

  public async refresh(): Promise<RuntimeRefreshResult> {
    return this.#runtimeState.refresh();
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

  public async chat<T = unknown>(input: AiChatInput): Promise<AiChatResult<T>> {
    return executeChat<T>(input, {
      snapshot: this.requireUsableSnapshot(),
      selectRoute: (virtualModel, context) => this.selectRoute(virtualModel, context),
      providerFetch: this.#providerFetch,
      resolveCredential: (connection) => this.resolveCredential(connection),
      adapterFor: (connection) => this.adapterFor(connection),
      reserve: (reservation) => this.reserveUserAiu(reservation),
      release: (token, reason) => this.releaseUserAiuReservation(token, reason),
      settle: (token, amount) => this.settleUserAiuReservation(token, amount),
      report: (events) => this.reportUsage(events),
      onError: this.#onError,
      sdkVersion: this.#sdkVersion,
      instanceId: this.#instanceId,
      now: this.#now,
    });
  }

  public chatStream<T = unknown>(input: AiChatInput): AiChatStream<T> {
    return executeChatStream<T>(input, {
      snapshot: this.requireUsableSnapshot(),
      selectRoute: (virtualModel, context) => this.selectRoute(virtualModel, context),
      providerFetch: this.#providerFetch,
      resolveCredential: (connection) => this.resolveCredential(connection),
      adapterFor: (connection) => this.adapterFor(connection),
      reserve: (reservation) => this.reserveUserAiu(reservation),
      release: (token, reason) => this.releaseUserAiuReservation(token, reason),
      settle: (token, amount) => this.settleUserAiuReservation(token, amount),
      report: (events) => this.reportUsage(events),
      onError: this.#onError,
      sdkVersion: this.#sdkVersion,
      instanceId: this.#instanceId,
      now: this.#now,
    });
  }

  public registerProviderAdapter(
    driver: RuntimeCallConnection["driver"],
    adapter: AiProviderAdapter,
  ): this {
    this.#providerAdapters.set(driver, adapter);
    return this;
  }

  public registerConnectionAdapter(connectionId: string, adapter: AiProviderAdapter): this {
    if (connectionId.trim().length === 0) throw new TypeError("connectionId is required");
    this.#connectionAdapters.set(connectionId, adapter);
    return this;
  }

  public async recordUsage(input: RecordUsageInput): Promise<UsageEvent> {
    const context = requireAiContext();
    const snapshot = this.requireUsableSnapshot();
    const route = this.selectRoute(input.model, {
      userId: context.userId,
      userProperties: context.userProperties,
      selectionKey: context.requestId,
      ...(context.callSource === null ? {} : { callSource: context.callSource }),
    });
    const event = buildManualUsageEvent({
      value: input,
      context,
      snapshot,
      route,
      now: this.#now(),
      sdkVersion: this.#sdkVersion,
      instanceId: this.#instanceId,
    });
    await this.#usageReporter.report([event]);
    return event;
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

  public async flushUsage(): Promise<number> {
    return this.#usageReporter.flush();
  }

  public close(): void {
    if (this.#refreshTimer !== null) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#usageReporter.close();
  }

  private requireUsableSnapshot(): RuntimeSnapshot {
    return this.#runtimeState.requireUsable();
  }

  private async resolveCredential(connection: RuntimeCallConnection): Promise<string> {
    const reference = connection.credential_ref;
    if (reference === null) return "";
    const configured = this.#credentials[reference];
    const resolved =
      configured ??
      (this.#credentialResolver === undefined
        ? process.env[reference]
        : await this.#credentialResolver(reference, connection));
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new AiControlSdkError(
        "SDK_CONNECTION_CREDENTIAL_MISSING",
        `Credential ${reference} is not configured for connection ${connection.name}.`,
      );
    }
    return resolved;
  }

  private adapterFor(connection: RuntimeCallConnection): AiProviderAdapter | undefined {
    return (
      this.#connectionAdapters.get(connection.id) ?? this.#providerAdapters.get(connection.driver)
    );
  }

  private async reportUsage(events: readonly UsageEvent[]): Promise<void> {
    await this.#usageReporter.report(events);
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
