import type {
  RuntimeCallConnection,
  RuntimeRouteTarget,
  RuntimeSnapshot,
  RuntimeUserReservationRequest,
  RuntimeUserReservationResponse,
  UsageEvent,
} from "@tokenpilot/contracts";
import { ulid } from "ulid";

import { AiControlSdkError } from "../errors.js";
import { requireAiContext } from "./context.js";
import type { RuntimeRouteContext, RuntimeRouteSelection } from "./routing.js";
import type {
  AiChatAttempt,
  AiChatInput,
  AiProviderAdapter,
  SdkReservationResult,
} from "./types.js";

export interface ChatEnvironment {
  readonly snapshot: RuntimeSnapshot;
  readonly selectRoute: (
    virtualModel: string,
    context: RuntimeRouteContext,
  ) => RuntimeRouteSelection;
  readonly providerFetch: typeof fetch;
  readonly resolveCredential: (connection: RuntimeCallConnection) => Promise<string>;
  readonly adapterFor: (connection: RuntimeCallConnection) => AiProviderAdapter | undefined;
  readonly reserve: (input: RuntimeUserReservationRequest) => Promise<SdkReservationResult>;
  readonly release: (
    token: NonNullable<RuntimeUserReservationResponse["reservation"]>,
    reason: string,
  ) => Promise<void>;
  readonly settle: (
    token: NonNullable<RuntimeUserReservationResponse["reservation"]>,
    amount: string,
  ) => Promise<void>;
  readonly report: (events: readonly UsageEvent[]) => Promise<void>;
  readonly onError: (error: Error) => void;
  readonly sdkVersion: string;
  readonly instanceId: string;
  readonly now: () => Date;
}

export function mutableProperties(
  values: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    output[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : [...value];
  }
  return output;
}

export function mergeUsage(
  current: UsageEvent["usage"],
  next: UsageEvent["usage"] | undefined,
): UsageEvent["usage"] {
  if (next === undefined) return current;
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (Array.isArray(value)) {
      result[key] = value;
      continue;
    }
    if (typeof value !== "string") continue;
    const previous = Number(typeof result[key] === "string" ? result[key] : "0");
    const candidate = Number(value);
    result[key] = Number.isFinite(candidate) ? String(Math.max(previous, candidate)) : value;
  }
  return result as UsageEvent["usage"];
}

export function eventFor(
  environment: ChatEnvironment,
  input: {
    readonly route: RuntimeRouteSelection;
    readonly target: RuntimeRouteTarget;
    readonly prior: RuntimeRouteTarget | undefined;
    readonly attemptIndex: number;
    readonly attemptId: string;
    readonly operationId: string;
    readonly connection: RuntimeCallConnection;
    readonly status: AiChatAttempt["status"];
    readonly httpStatus: number | null;
    readonly latencyMs: number;
    readonly usage: UsageEvent["usage"];
    readonly sourceCost?: UsageEvent["source_cost"];
    readonly final: boolean;
    readonly reservationId: string | null;
  },
): UsageEvent {
  const context = requireAiContext();
  return {
    schema_version: "2.0",
    event_id: ulid(environment.now().getTime()),
    event_time: environment.now().toISOString(),
    ...(context.applicationVersion === null
      ? {}
      : { application_version: context.applicationVersion }),
    sdk_version: environment.sdkVersion,
    config_version: String(input.route.configurationVersion),
    user: { user_id: context.userId, display_user: context.displayUser },
    ...(Object.keys(context.eventProperties).length === 0
      ? {}
      : { event_properties: mutableProperties(context.eventProperties) }),
    ...(Object.keys(context.userProperties).length === 0
      ? {}
      : { user_properties: mutableProperties(context.userProperties) }),
    source: {
      type: "sdk",
      name: "tokenpilot-node",
      version: environment.sdkVersion,
      instance_id: environment.instanceId,
    },
    request: {
      request_id: context.requestId,
      attempt_id: input.attemptId,
      attempt_index: input.attemptIndex,
      is_final_attempt: input.final,
      operation_id: input.operationId,
      parent_request_id: context.parentRequestId,
      session_id: context.sessionId,
      conversation_id: context.conversationId,
      trace_id: context.traceId,
      reservation_id: input.reservationId,
    },
    model: {
      virtual_model: input.route.virtualModel,
      model_id: input.target.model_id,
      connection_id: input.target.connection_id,
      connection_driver: input.connection.driver,
      request_model: input.target.request_model,
      provider: input.target.provider,
    },
    route: {
      configuration_version: String(input.route.configurationVersion),
      rule: input.route.ruleId,
      reason: input.route.ruleId === null ? "default" : "condition",
      tags: [input.route.routeTag],
      fallback_from: input.prior?.model_id ?? null,
      is_final_success_attempt: input.status === "success",
      is_user_visible_operation: input.final,
    },
    analytics_dimensions: context.analyticsDimensions,
    result: {
      status: input.status,
      http_status: input.httpStatus,
      latency_ms: input.latencyMs,
      error_class: input.status === "success" ? null : `provider_${input.status}`,
    },
    source_cost: input.sourceCost ?? null,
    privacy: { contains_prompt: false, contains_response: false },
    usage: input.usage,
  };
}

export function chatTargets(
  route: RuntimeRouteSelection,
  input: AiChatInput,
  streaming: boolean,
): readonly RuntimeRouteTarget[] {
  const requiredInputCapabilities = new Set<"image_input" | "audio_input">();
  for (const message of input.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const type = (part as { readonly type?: unknown }).type;
      if (type === "image" || type === "image_url" || type === "input_image") {
        requiredInputCapabilities.add("image_input");
      }
      if (type === "audio" || type === "input_audio") {
        requiredInputCapabilities.add("audio_input");
      }
    }
  }
  const targets = [route.primary, ...route.fallbacks].filter((target) => {
    if (target.task_type !== "chat") return false;
    if (streaming && !target.capabilities.includes("streaming")) return false;
    if (input.tools !== undefined && !target.capabilities.includes("tools")) return false;
    if (input.responseFormat !== undefined && !target.capabilities.includes("structured_output")) {
      return false;
    }
    if (
      [...requiredInputCapabilities].some((capability) => !target.capabilities.includes(capability))
    ) {
      return false;
    }
    return true;
  });
  if (targets.length === 0) {
    throw new AiControlSdkError(
      "SDK_MODEL_CAPABILITY_UNAVAILABLE",
      "No route target supports the requested chat capabilities.",
    );
  }
  return targets;
}
