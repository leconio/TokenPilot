export interface OpenAiCompatibleRequest {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface OpenAiCompatibleOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export function sanitizeCallerTags(
  tags: string | readonly string[] | undefined,
): readonly string[] {
  const values =
    tags === undefined
      ? []
      : typeof tags === "string"
        ? tags.split(",")
        : tags.flatMap((tag) => tag.split(","));
  return Object.freeze(
    values.map((tag) => tag.trim()).filter((tag) => tag.length > 0 && !tag.startsWith("cp:")),
  );
}

import { requireAiContext } from "./context.js";
import type { AiRuntimeClient } from "./client.js";

function sanitizedMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => key !== "cp" && !key.startsWith("cp:") && !key.startsWith("cp_"),
    ),
  );
}

export function applyAiContextToOpenAiRequest(
  client: AiRuntimeClient,
  body: OpenAiCompatibleRequest,
  options: OpenAiCompatibleOptions = {},
): Readonly<{ body: OpenAiCompatibleRequest; options: OpenAiCompatibleOptions }> {
  const context = requireAiContext();
  const envelope = client.createMetadataEnvelope(context);
  if (typeof body.model !== "string") {
    throw new TypeError("OpenAI-compatible requests must name a virtual model.");
  }
  const route = client.selectRoute(body.model, {
    userId: context.userId,
    userProperties: context.userProperties,
    selectionKey: context.requestId,
    ...(context.callSource === null ? {} : { callSource: context.callSource }),
  });
  const headers = { ...(options.headers ?? {}) };
  const tagKey =
    Object.keys(headers).find((key) => key.toLowerCase() === "x-litellm-tags") ?? "x-litellm-tags";
  const tags = sanitizeCallerTags(headers[tagKey]);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-litellm-tags") delete headers[key];
  }
  headers["x-litellm-tags"] = [
    ...tags,
    route.routeTag,
    `cp:model:${route.primary.model_id}`,
    `cp:configuration:${route.configurationVersion}`,
  ].join(",");
  return Object.freeze({
    body: Object.freeze({
      ...body,
      model: route.primary.model_tag,
      fallbacks: route.fallbacks.map((target) => target.model_tag),
      metadata: Object.freeze({
        ...sanitizedMetadata(body.metadata),
        cp: envelope,
        cp_route: Object.freeze({
          virtual_model: route.virtualModel,
          route_tag: route.routeTag,
          model_id: route.primary.model_id,
          model_tag: route.primary.model_tag,
          configuration_version: route.configurationVersion,
          fallback_model_ids: route.fallbacks.map((target) => target.model_id),
          candidate_models: [route.primary, ...route.fallbacks].map((target) => ({
            model_id: target.model_id,
            model_tag: target.model_tag,
          })),
        }),
      }),
    }),
    options: Object.freeze({ ...options, headers: Object.freeze(headers) }),
  });
}
