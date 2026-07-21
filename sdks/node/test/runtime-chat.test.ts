import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DurableUsageSpool,
  UsageSpoolCapacityError,
  createAiRuntimeClient,
  withAiContext,
} from "../src/index.js";

import {
  type CapturedUsageBatch,
  type CapturedUsageEvent,
  now,
  signedSnapshot,
  baseSnapshot,
  json,
  acceptedUsage,
  client,
  directory,
  lkgPath,
  parseBody,
} from "./runtime-testkit.js";

describe("Node runtime SDK chat", () => {
  it("falls back across connections and reports each actual provider attempt", async () => {
    const routed = structuredClone(baseSnapshot);
    routed.connections["connection-litellm"]!.max_retries = 1;
    routed.connections["connection-anthropic"] = {
      id: "connection-anthropic",
      name: "Anthropic direct",
      driver: "anthropic",
      base_url: "https://anthropic.example.com/v1",
      credential_ref: "ANTHROPIC_API_KEY",
      timeout_ms: 60_000,
      max_retries: 0,
      api_version: "2023-06-01",
    };
    const fallback = routed.routing["text.fast"]!.default.targets[1]!;
    routed.routing["text.fast"]!.default.targets[1] = {
      ...fallback,
      connection_id: "connection-anthropic",
    };
    const snapshot = signedSnapshot(routed);
    const batches: CapturedUsageBatch[] = [];
    const providerUrls: string[] = [];
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      credentials: {
        LITELLM_API_KEY: "litellm-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(snapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) {
          batches.push(parseBody<CapturedUsageBatch>(init));
          return json({}, 202);
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      providerFetch: async (input, init) => {
        const url = String(input);
        providerUrls.push(url);
        if (url.includes("models.example.com")) return json({ error: "busy" }, 503);
        expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-secret");
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "litellm-fallback" });
        return json({
          content: [{ type: "text", text: "fallback worked" }],
          usage: { input_tokens: 12, output_tokens: 5 },
        });
      },
      now: () => now,
    });
    await runtime.refresh();
    const result = await withAiContext(
      {
        userId: "user-chat",
        displayUser: "Chat User",
        eventProperties: { next_action: "answer" },
        analyticsDimensions: { client: "node" },
      },
      () => runtime.chat({ model: "text.fast", messages: [{ role: "user", content: "hello" }] }),
    );

    expect(result.connection.id).toBe("connection-anthropic");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "failure",
      "failure",
      "success",
    ]);
    expect(providerUrls).toHaveLength(3);
    const events: CapturedUsageEvent[] = batches[0]!.events;
    expect(events.map((event) => event.request.attempt_index)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.request.is_final_attempt)).toEqual([false, false, true]);
    expect(events[2]!.model.connection_driver).toBe("anthropic");
    expect(events[2]!.usage.output_tokens).toBe("5");
    expect(events[2]!.event_properties).toEqual({ next_action: "answer" });
    runtime.close();
  });

  it("durably replays usage after the control plane recovers", async () => {
    const spoolPath = join(directory, "usage-spool.sqlite3");
    let firstBatch: CapturedUsageBatch | null = null;
    const offline = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      usageSpoolPath: spoolPath,
      credentials: { LITELLM_API_KEY: "litellm-secret" },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(baseSnapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) {
          firstBatch = parseBody<CapturedUsageBatch>(init);
          throw new Error("control plane temporarily unavailable");
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      providerFetch: async () =>
        json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        }),
      now: () => now,
    });
    await offline.refresh();
    await withAiContext({ userId: "durable-user" }, () =>
      offline.chat({ model: "text.fast", messages: [{ role: "user", content: "hello" }] }),
    );
    expect(firstBatch).not.toBeNull();
    offline.close();

    let replayed = 0;
    const recovered = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      usageSpoolPath: spoolPath,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(baseSnapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) {
          const batch = JSON.parse(String(init?.body)) as {
            batch_id: string;
            events: Array<{ event_id: string }>;
          };
          replayed += batch.events.length;
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
        throw new Error(`Unexpected control request: ${url}`);
      },
      now: () => now,
    });
    await recovered.refresh();
    expect(replayed).toBe(1);
    await expect(recovered.flushUsage()).resolves.toBe(0);
    recovered.close();
  });

  it("reuses a registered provider client without requiring a duplicate credential", async () => {
    const batches: CapturedUsageBatch[] = [];
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(baseSnapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) {
          batches.push(parseBody<CapturedUsageBatch>(init));
          return acceptedUsage(init);
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      now: () => now,
    }).registerConnectionAdapter("connection-litellm", {
      requiresCredential: false,
      chat: async ({ target, connection }) => {
        expect(target.request_model).toBe("litellm-primary");
        expect(connection.id).toBe("connection-litellm");
        return {
          response: { choices: [{ message: { content: "from existing client" } }] },
          httpStatus: 201,
          usage: { uncached_input_tokens: "3", output_tokens: "2", request_count: "1" },
        };
      },
    });
    await runtime.refresh();
    const result = await withAiContext({ userId: "adapter-user" }, () =>
      runtime.chat({ model: "text.fast", messages: [{ role: "user", content: "hello" }] }),
    );
    expect(result.response).toMatchObject({
      choices: [{ message: { content: "from existing client" } }],
    });
    expect(result.attempts[0]).toMatchObject({ status: "success", httpStatus: 201 });
    expect(batches[0]!.events[0]!.usage).toMatchObject({
      uncached_input_tokens: "3",
      output_tokens: "2",
    });
    const event = batches[0]!.events[0]!;
    expect(() => new DurableUsageSpool(join(directory, "invalid.sqlite3"), 0)).toThrow(
      /positive safe integer/u,
    );
    const spool = new DurableUsageSpool(join(directory, "direct-spool.sqlite3"), 1_000_000);
    expect(spool.enqueue(event)).toBe(true);
    expect(spool.enqueue(event)).toBe(false);
    expect(spool.depth).toBe(1);
    expect(spool.pending(10)[0]?.eventId).toBe(event.event_id);
    spool.reject(event.event_id, "INVALID");
    expect(spool.depth).toBe(0);
    expect(spool.enqueue(event)).toBe(false);
    const another = {
      ...event,
      event_id: `${event.event_id.slice(0, -1)}${event.event_id.endsWith("0") ? "1" : "0"}`,
    };
    expect(spool.enqueue(another)).toBe(true);
    expect(spool.acknowledge([another.event_id, "missing"])).toBe(1);
    expect(spool.acknowledge([])).toBe(0);
    spool.close();
    const constrained = new DurableUsageSpool(join(directory, "tiny-spool.sqlite3"), 1);
    expect(() => constrained.enqueue(event)).toThrow(UsageSpoolCapacityError);
    constrained.close();
    runtime.close();
  });

  it("manually records governed usage with caller-supplied idempotency IDs", async () => {
    const batches: CapturedUsageBatch[] = [];
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(baseSnapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) {
          batches.push(parseBody<CapturedUsageBatch>(init));
          return acceptedUsage(init);
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      now: () => now,
    });
    await runtime.refresh();
    const event = await withAiContext(
      {
        userId: "manual-user",
        displayUser: "Manual User",
        operationId: "manual-operation-1",
        eventProperties: { next_action: "review" },
        analyticsDimensions: { client: "node" },
      },
      () =>
        runtime.recordUsage({
          eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          attemptId: "manual-attempt-1",
          model: "text.fast",
          modelId: "model-primary",
          status: "success",
          latencyMs: 42,
          sourceCost: { amount: "0.0125", currency: "USD", isEstimated: false },
          usage: { uncached_input_tokens: "6", output_tokens: "2", request_count: "1" },
        }),
    );
    expect(event).toMatchObject({
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      user: { user_id: "manual-user", display_user: "Manual User" },
      request: { attempt_id: "manual-attempt-1", operation_id: "manual-operation-1" },
      model: { model_id: "model-primary", connection_id: "connection-litellm" },
      route: { reason: "manual" },
      source_cost: { amount: "0.0125", currency: "USD", is_estimated: false },
      privacy: { contains_prompt: false, contains_response: false },
    });
    expect(batches[0]!.events).toEqual([event]);
    await expect(
      withAiContext({ userId: "manual-user" }, () =>
        runtime.recordUsage({
          eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          attemptId: "manual-attempt-2",
          model: "text.fast",
          modelId: "not-a-candidate",
          usage: { request_count: "1" },
        }),
      ),
    ).rejects.toMatchObject({ code: "SDK_MANUAL_USAGE_MODEL_INVALID" });
    runtime.close();
  });

  it("rejects image input before a provider call when no routed model supports images", async () => {
    let providerCalls = 0;
    const runtime = client(async () => json({}));
    runtime.registerProviderAdapter("litellm", {
      requiresCredential: false,
      chat: async () => {
        providerCalls += 1;
        return { response: {} };
      },
    });
    await runtime.refresh();
    await expect(
      withAiContext({ userId: "image-user" }, () =>
        runtime.chat({
          model: "text.fast",
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://image.test/a.png" } }],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "SDK_MODEL_CAPABILITY_UNAVAILABLE" });
    expect(providerCalls).toBe(0);
    runtime.close();
  });
});
