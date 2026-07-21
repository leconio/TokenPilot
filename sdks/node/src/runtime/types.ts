import type {
  AnalyticsDimensions,
  RuntimeCallConnection,
  RuntimeRouteTarget,
  RuntimeUserReservationRequest,
  RuntimeUserReservationResponse,
  UsageEvent,
} from "@tokenpilot/contracts";

export type DimensionScalar = string | number | boolean;
export type DimensionMap = Readonly<Record<string, DimensionScalar>>;
export type RuntimeFailMode = "fail_open" | "fail_closed";

export interface AiRuntimeContext {
  readonly userId: string;
  readonly displayUser?: string;
  readonly applicationVersion?: string;
  readonly operationId?: string;
  readonly parentRequestId?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly callSource?: string;
  readonly eventProperties?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly userProperties?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly analyticsDimensions?: DimensionMap;
}

export interface ResolvedAiRuntimeContext {
  readonly userId: string;
  readonly displayUser: string | null;
  readonly applicationVersion: string | null;
  readonly operationId: string;
  readonly requestId: string;
  readonly parentRequestId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly traceId: string;
  readonly callSource: string | null;
  readonly eventProperties: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly userProperties: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly analyticsDimensions: DimensionMap;
}

export interface RuntimeClientOptions {
  readonly controlPlaneUrl: string;
  readonly apiKey: string;
  readonly instanceId?: string;
  readonly sdkVersion?: string;
  readonly lkgPath?: string;
  readonly failMode?: RuntimeFailMode;
  readonly fetch?: typeof fetch;
  readonly providerFetch?: typeof fetch;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly credentialResolver?: (
    reference: string,
    connection: RuntimeCallConnection,
  ) => string | Promise<string>;
  readonly providerAdapters?: Readonly<
    Partial<Record<RuntimeCallConnection["driver"], AiProviderAdapter>>
  >;
  readonly connectionAdapters?: Readonly<Record<string, AiProviderAdapter>>;
  readonly usageSpoolPath?: string;
  readonly usageSpoolMaxBytes?: number;
  readonly usageBatchSize?: number;
  /** Polling interval used after start(). Set to 0 to disable background refresh. */
  readonly refreshIntervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}

export interface AiChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly name?: string;
  readonly tool_call_id?: string;
}

export interface AiChatInput {
  readonly model: string;
  readonly messages: readonly AiChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly tools?: readonly unknown[];
  readonly responseFormat?: unknown;
  readonly estimatedAiuMicros?: string;
  readonly signal?: AbortSignal;
}

export interface AiChatAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly target: RuntimeRouteTarget;
  readonly connection: RuntimeCallConnection;
  readonly status: "success" | "failure" | "timeout" | "cancelled";
  readonly httpStatus: number | null;
  readonly latencyMs: number;
}

export interface AiChatResult<T = unknown> {
  readonly response: T;
  readonly virtualModel: string;
  readonly target: RuntimeRouteTarget;
  readonly connection: RuntimeCallConnection;
  readonly attempts: readonly AiChatAttempt[];
  readonly operationId: string;
}

export interface AiProviderChatRequest {
  readonly input: AiChatInput;
  readonly target: RuntimeRouteTarget;
  readonly connection: RuntimeCallConnection;
  readonly credential: string;
  readonly signal: AbortSignal;
}

export interface AiProviderChatResponse {
  readonly response: unknown;
  readonly httpStatus?: number;
  readonly usage?: UsageEvent["usage"];
  readonly sourceCost?: NonNullable<UsageEvent["source_cost"]>;
}

export interface AiProviderStreamPart<T = unknown> {
  readonly value: T;
  readonly usage?: UsageEvent["usage"];
  readonly sourceCost?: NonNullable<UsageEvent["source_cost"]>;
}

export interface AiProviderChatStreamResponse<T = unknown> {
  readonly httpStatus?: number;
  readonly stream: AsyncIterable<AiProviderStreamPart<T>>;
}

/**
 * Connection-local adapter contract. Wrap an existing official SDK client here to reuse its
 * proxy, connection pool, retries, and enterprise gateway configuration.
 */
export interface AiProviderAdapter {
  readonly requiresCredential?: boolean;
  chat(request: AiProviderChatRequest): Promise<AiProviderChatResponse>;
  stream?(request: AiProviderChatRequest): Promise<AiProviderChatStreamResponse>;
}

export type AiChatStream<T = unknown> = AsyncGenerator<T, AiChatResult<null>, void>;

export interface RecordUsageInput {
  /** Stable caller-generated ULID used for ingestion idempotency. */
  readonly eventId: string;
  /** Stable caller-generated attempt ID used with the operation in the active context. */
  readonly attemptId: string;
  readonly model: string;
  readonly modelId?: string;
  readonly attemptIndex?: number;
  readonly isFinalAttempt?: boolean;
  readonly status?: UsageEvent["result"]["status"];
  readonly httpStatus?: number | null;
  readonly latencyMs?: number | null;
  readonly errorClass?: string | null;
  readonly fallbackFrom?: string | null;
  /** Exact or estimated amount returned by the model service for this attempt. */
  readonly sourceCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
    readonly isEstimated?: boolean;
  }>;
  readonly usage: UsageEvent["usage"];
}

export interface RuntimeRefreshResult {
  readonly status: "updated" | "not_modified" | "lkg";
  readonly version: string;
  readonly etag: string;
  readonly expired: boolean;
}

export interface SdkMetadataEnvelope {
  readonly context_version: string;
  readonly operation_id: string;
  readonly user_id: string;
  readonly display_user?: string;
  readonly application_version?: string;
  readonly sdk_version: string;
  readonly parent_request_id?: string;
  readonly session_id?: string;
  readonly conversation_id?: string;
  readonly event_properties?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly user_properties?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly call_source?: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly analytics_dimensions?: AnalyticsDimensions;
}

export type SdkReservationResult =
  | { readonly status: "not_required"; readonly networkUsed: false; readonly token: null }
  | { readonly status: "allowed"; readonly networkUsed: true; readonly token: null }
  | {
      readonly status: "reserved";
      readonly networkUsed: true;
      readonly token: NonNullable<RuntimeUserReservationResponse["reservation"]>;
    }
  | { readonly status: "fail_open"; readonly networkUsed: true; readonly token: null };

export type ReservationOperationInput = RuntimeUserReservationRequest;

export interface ReservationOperationResult<T> {
  readonly value: T;
  readonly reservation: SdkReservationResult;
}
