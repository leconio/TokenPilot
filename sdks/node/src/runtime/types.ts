import type {
  AnalyticsDimensions,
  RuntimeUserReservationRequest,
  RuntimeUserReservationResponse,
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
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
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
