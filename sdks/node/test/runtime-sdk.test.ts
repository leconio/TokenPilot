import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  runtimeConfigurationAcknowledgementSchema,
  type RuntimeSnapshot,
} from "@tokenpilot/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AiControlSdkError,
  applyAiContextToOpenAiRequest,
  createAiRuntimeClient,
  currentAiContext,
  withAiContext,
  withAiuReservation,
} from "../src/index.js";

const now = new Date("2026-07-16T13:00:00.000Z");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function signedSnapshot(
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

const baseSnapshot = signedSnapshot({
  schema_version: "2.0",
  application_id: "00000000-0000-4000-8000-000000000042",
  version: "runtime-v42",
  expires_at: "2026-07-16T14:00:00.000Z",
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
            model_tag: "litellm-primary",
            provider: "openai",
            route_tag: "cp:text.fast:default",
            fallback_order: 0,
            weight: 1,
          },
          {
            model_id: "model-fallback",
            model_tag: "litellm-fallback",
            provider: "anthropic",
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

let directory: string;
let lkgPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tokenpilot-node-"));
  lkgPath = join(directory, "runtime.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
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

describe("Node runtime SDK", () => {
  it("propagates isolated async context and automatically creates operation/request/trace IDs", async () => {
    expect(currentAiContext()).toBeNull();
    await withAiContext({ userId: "user-1", callSource: "receipt_parse" }, async () => {
      await Promise.resolve();
      expect(currentAiContext()).toMatchObject({
        userId: "user-1",
        callSource: "receipt_parse",
        operationId: expect.stringMatching(/^op_/u),
        requestId: expect.stringMatching(/^req_/u),
        traceId: expect.stringMatching(/^trace_/u),
      });
    });
    expect(currentAiContext()).toBeNull();
  });

  it("uses ETag/LKG, strips hostile metadata, and reports the current application user", async () => {
    const acknowledgements: unknown[] = [];
    const runtime = client(async () => json({}), baseSnapshot, acknowledgements);
    await expect(runtime.refresh()).resolves.toMatchObject({ status: "updated" });
    await expect(runtime.refresh()).resolves.toMatchObject({ status: "not_modified" });
    expect(acknowledgements).toMatchObject([
      { state: "received", applied_at: null, error: null },
      { state: "applied", applied_at: now.toISOString(), error: null },
    ]);

    const applied = await withAiContext(
      {
        userId: "user-1",
        displayUser: "Ada",
        applicationVersion: "ios-2.8.0",
        operationId: "op-1",
        parentRequestId: "parent-request-1",
        sessionId: "session-1",
        conversationId: "conversation-1",
        callSource: "receipt_parse",
        eventProperties: { voice_enabled: true, next_action: "confirm" },
        userProperties: { member_level: "VVIP" },
        analyticsDimensions: { client: "ios" },
      },
      async () =>
        applyAiContextToOpenAiRequest(
          runtime,
          {
            model: "text.fast",
            metadata: { cp: { forged: true }, "cp:route": "forged", safe: "kept" },
          },
          { headers: { "X-LiteLLM-Tags": "customer,cp:forged" } },
        ),
    );
    expect(applied.body.metadata).toMatchObject({
      safe: "kept",
      cp: {
        context_version: "runtime-v42",
        user_id: "user-1",
        display_user: "Ada",
        application_version: "ios-2.8.0",
        sdk_version: "0.2.0",
        parent_request_id: "parent-request-1",
        session_id: "session-1",
        conversation_id: "conversation-1",
        event_properties: { voice_enabled: true, next_action: "confirm" },
        user_properties: { member_level: "VVIP" },
        call_source: "receipt_parse",
        operation_id: "op-1",
        analytics_dimensions: { client: "ios" },
        request_id: expect.stringMatching(/^req_/u),
        trace_id: expect.stringMatching(/^trace_/u),
      },
    });
    expect(applied.options.headers).toEqual({
      "x-litellm-tags": "customer,cp:text.fast:default,cp:model:model-primary,cp:configuration:81",
    });
    expect(applied.body).toMatchObject({
      model: "litellm-primary",
      fallbacks: ["litellm-fallback"],
      metadata: {
        cp_route: {
          virtual_model: "text.fast",
          route_tag: "cp:text.fast:default",
          model_id: "model-primary",
          model_tag: "litellm-primary",
          configuration_version: 81,
          candidate_models: [
            { model_id: "model-primary", model_tag: "litellm-primary" },
            { model_id: "model-fallback", model_tag: "litellm-fallback" },
          ],
        },
      },
    });
    expect(JSON.stringify(applied)).not.toContain("forged");
  });

  it("rejects analytics dimensions not governed by the Runtime Snapshot", async () => {
    const runtime = client(async () => json({}));
    await runtime.refresh();
    expect(() =>
      withAiContext({ userId: "user-1", analyticsDimensions: { attacker_level: "root" } }, () =>
        applyAiContextToOpenAiRequest(runtime, { model: "text.fast" }),
      ),
    ).toThrowError(AiControlSdkError);
    expect(() => withAiContext({ userId: " ", eventProperties: {} }, () => undefined)).toThrow(
      /userId/u,
    );
    expect(() =>
      withAiContext(
        { userId: "user-1", eventProperties: { prompt: "must not leave the app" } },
        () => undefined,
      ),
    ).toThrow(/eventProperties\.prompt/u);
  });

  it("retains the last known good route when a fetched snapshot fails checksum validation", async () => {
    let calls = 0;
    const acknowledgements: Array<Record<string, unknown>> = [];
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      instanceId: "node-test-instance",
      sdkVersion: "0.2.0-test",
      fetch: async (input, init) => {
        if (String(input).endsWith("/runtime/configuration-acknowledgements")) {
          const acknowledgement = runtimeConfigurationAcknowledgementSchema.parse(
            JSON.parse(String(init?.body)),
          );
          acknowledgements.push(acknowledgement);
          return json({ status: "accepted", duplicate: false }, 202);
        }
        calls += 1;
        return json(calls === 1 ? baseSnapshot : { ...baseSnapshot, version: "tampered" });
      },
      now: () => now,
    });
    await expect(runtime.refresh()).resolves.toMatchObject({ status: "updated" });
    await expect(runtime.refresh()).resolves.toMatchObject({ status: "lkg" });
    expect(runtime.selectRoute("text.fast").primary.model_id).toBe("model-primary");
    expect(runtime.snapshotSource).toBe("lkg");
    expect(acknowledgements.map(({ state }) => state)).toEqual(["received", "applied", "rejected"]);
    expect(acknowledgements[2]).toMatchObject({
      connector: { instance_id: "node-test-instance", name: "node", version: "0.2.0-test" },
      state: "rejected",
      applied_at: null,
      error: { code: "SDK_RUNTIME_SNAPSHOT_REJECTED" },
    });
  });

  it("rejects a Runtime Snapshot whose signature is bound to another application", async () => {
    const runtime = client(async () => json({}), {
      ...baseSnapshot,
      signature: `sha256:${"0".repeat(64)}`,
    });
    await expect(runtime.refresh()).rejects.toMatchObject({
      code: "SDK_RUNTIME_SIGNATURE_MISMATCH",
    });
  });

  it("adds no preflight network dependency when hard limit is disabled", async () => {
    let runtimeCalls = 0;
    const runtime = client(async () => {
      runtimeCalls += 1;
      return json({});
    });
    await runtime.refresh();
    const result = await withAiuReservation({
      client: runtime,
      reservation: {
        user_id: "user-1",
        operation_id: "op-1",
        virtual_model: "text.fast",
        estimated_aiu_micros: "100",
        candidate_model_ids: ["00000000-0000-4000-8000-000000000001"],
      },
      operation: async (token) => token ?? "model-result",
      settledAiuMicros: () => "80",
    });
    expect(result).toMatchObject({
      value: "model-result",
      reservation: { status: "not_required", networkUsed: false },
    });
    expect(runtimeCalls).toBe(0);
  });

  it("uses an explicit weighted default route without changing ordered fallbacks", async () => {
    const weighted = structuredClone(baseSnapshot);
    const route = weighted.routing["text.fast"]!.default as unknown as {
      selection_mode: "ordered" | "weighted";
      targets: Array<{ weight: number }>;
    };
    route.selection_mode = "weighted";
    route.targets[0]!.weight = 1;
    route.targets[1]!.weight = 1_000;
    const runtime = client(async () => json({}), signedSnapshot(weighted));
    await runtime.refresh();

    const selected = runtime.selectRoute("text.fast", { selectionKey: "req-weighted" });

    expect(selected.primary.model_id).toBe("model-fallback");
    expect(selected.fallbacks.map((target) => target.model_id)).toEqual(["model-primary"]);
  });

  it("reserves and settles in hard-limit mode, while fail-open still runs the model", async () => {
    const calls: string[] = [];
    const hardLimit = signedSnapshot({
      ...baseSnapshot,
      aiu: { ...baseSnapshot.aiu, mode: "hard_limit" as const },
    });
    const runtime = client(async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/settle")) return json({ status: "settled" });
      return json({
        allowed: true,
        reason: "reserved",
        user: {
          id: "user-internal-1",
          limit_aiu_micros: "1000",
          used_aiu_micros: "0",
          reserved_aiu_micros: "100",
          remaining_aiu_micros: "900",
        },
        reservation: {
          id: "reservation-1",
          token: "reservation-token-0123456789abcdef0123456789abcdef0123456789abcdef",
          reserved_aiu_micros: "100",
          expires_at: "2026-07-16T13:05:00.000Z",
        },
      });
    }, hardLimit);
    await runtime.refresh();
    const result = await withAiuReservation({
      client: runtime,
      reservation: {
        user_id: "user-1",
        operation_id: "op-1",
        virtual_model: "text.fast",
        estimated_aiu_micros: "100",
        candidate_model_ids: ["00000000-0000-4000-8000-000000000001"],
      },
      operation: async (token) => (token === null ? "missing" : "called"),
      settledAiuMicros: () => "80",
    });
    expect(result.value).toBe("called");
    expect(calls.some((url) => url.endsWith("/settle"))).toBe(true);

    let modelCalled = false;
    const offline = client(async () => Promise.reject(new Error("offline")), hardLimit);
    await offline.loadLkg();
    const fallback = await withAiuReservation({
      client: offline,
      reservation: {
        user_id: "user-1",
        operation_id: "op-2",
        virtual_model: "text.fast",
        estimated_aiu_micros: "100",
        candidate_model_ids: ["00000000-0000-4000-8000-000000000001"],
      },
      operation: async () => {
        modelCalled = true;
        return "fallback";
      },
      settledAiuMicros: () => "80",
    });
    expect(fallback.reservation.status).toBe("fail_open");
    expect(modelCalled).toBe(true);
  });

  it("routes with the current application-user properties", async () => {
    const contextual = structuredClone(baseSnapshot);
    const plan = contextual.routing["text.fast"]!;
    const routeTag = "cp:text.fast:pro";
    const targets = [...plan.default.targets]
      .reverse()
      .map((target, index) => ({ ...target, route_tag: routeTag, fallback_order: index }));
    plan.rules = [
      {
        id: "pro-users",
        priority: 100,
        match: {
          user_property: { key: "member_level", operator: "equals", value: "pro" },
        },
        route: { route_tag: routeTag, selection_mode: "ordered", targets },
      },
    ];
    const runtime = client(async () => json({}), signedSnapshot(contextual));
    await runtime.refresh();
    expect(
      runtime.selectRoute("text.fast", {
        userId: "user-1",
        userProperties: { member_level: "pro" },
      }).primary.model_id,
    ).toBe("model-fallback");
  });
});
