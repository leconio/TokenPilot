import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runtimeConfigurationAcknowledgementSchema,
  type RuntimeSnapshot,
  type UsageEvent,
} from "@tokenpilot/contracts";
import { afterEach, beforeEach } from "vitest";

import { createAiRuntimeClient } from "../src/index.js";

export const now = new Date("2026-07-16T13:00:00.000Z");

export type CapturedUsageEvent = UsageEvent;

export interface CapturedUsageBatch {
  readonly events: CapturedUsageEvent[];
}

export function parseBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body)) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function signedSnapshot(
  value: Omit<RuntimeSnapshot, "etag" | "signature"> | RuntimeSnapshot,
): RuntimeSnapshot {
  const unsigned = { ...value } as Partial<RuntimeSnapshot>;
  delete unsigned.etag;
  delete unsigned.signature;
  const etag = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  return {
    ...(unsigned as Omit<RuntimeSnapshot, "etag" | "signature">),
    etag,
    signature: `sha256:${createHash("sha256")
      .update(canonical({ application_id: unsigned.application_id, etag }))
      .digest("hex")}`,
  };
}

export const baseSnapshot = signedSnapshot({
  schema_version: "2.0",
  application_id: "00000000-0000-4000-8000-000000000042",
  version: "runtime-v42",
  expires_at: "2026-07-16T14:00:00.000Z",
  connections: {
    "connection-litellm": {
      id: "connection-litellm",
      name: "LiteLLM",
      driver: "litellm",
      base_url: "https://models.example.com/v1",
      credential_ref: "LITELLM_API_KEY",
      timeout_ms: 60_000,
      max_retries: 2,
    },
  },
  routing: {
    "text.fast": {
      virtual_model_id: "virtual-fast",
      configuration_version: 81,
      configuration_etag: `sha256:${"8".repeat(64)}`,
      published_at: "2026-07-16T12:00:00.000Z",
      timezone: "UTC",
      default: {
        route_tag: "cp:text.fast:default",
        selection_mode: "ordered",
        targets: [
          {
            model_id: "model-primary",
            connection_id: "connection-litellm",
            request_model: "litellm-primary",
            provider: "openai",
            task_type: "chat",
            capabilities: ["streaming", "tools"],
            route_tag: "cp:text.fast:default",
            fallback_order: 0,
            weight: 1,
          },
          {
            model_id: "model-fallback",
            connection_id: "connection-litellm",
            request_model: "litellm-fallback",
            provider: "anthropic",
            task_type: "chat",
            capabilities: ["streaming", "tools"],
            route_tag: "cp:text.fast:default",
            fallback_order: 1,
            weight: 1,
          },
        ],
      },
      rules: [],
    },
  },
  aiu: { enabled: true, mode: "observe", unrated_model_policy: "alert_only" },
  access: { application_enabled: true, blocked_user_ids: [] },
  dimensions: {
    analytics_allowed_keys: ["client", "region"],
  },
});

export let directory: string;
export let lkgPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tokenpilot-node-"));
  lkgPath = join(directory, "runtime.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function acceptedUsage(init: RequestInit | undefined): Response {
  const batch = JSON.parse(String(init?.body)) as {
    batch_id: string;
    events: Array<{ event_id: string }>;
  };
  return json(
    {
      schema_version: "2.0",
      batch_id: batch.batch_id,
      received_at: now.toISOString(),
      accepted: batch.events.length,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
      results: batch.events.map((event, index) => ({
        index,
        event_id: event.event_id,
        status: "accepted",
        code: null,
        message: null,
      })),
    },
    202,
  );
}

export function sse(blocks: readonly (object | "[DONE]")[]): Response {
  const body = `${blocks
    .map((block) => `data: ${typeof block === "string" ? block : JSON.stringify(block)}\n\n`)
    .join("")}`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function client(
  fetchImplementation: typeof fetch,
  snapshot = baseSnapshot,
  acknowledgements: unknown[] = [],
) {
  let served = false;
  return createAiRuntimeClient({
    controlPlaneUrl: "http://control.test",
    apiKey: "node-sdk-runtime-key-0000001",
    lkgPath,
    fetch: async (input, init) => {
      if (String(input).endsWith("/runtime/snapshot")) {
        if (served && new Headers(init?.headers).has("if-none-match")) {
          return new Response(null, { status: 304 });
        }
        served = true;
        return json(snapshot);
      }
      if (String(input).endsWith("/runtime/configuration-acknowledgements")) {
        acknowledgements.push(
          runtimeConfigurationAcknowledgementSchema.parse(JSON.parse(String(init?.body))),
        );
        return json({ status: "accepted", duplicate: false }, 202);
      }
      return fetchImplementation(input, init);
    },
    now: () => now,
  });
}
