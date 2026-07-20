import { describe, expect, it } from "vitest";

import { createAiRuntimeClient, withAiContext } from "../src/index.js";

import {
  type CapturedUsageBatch,
  now,
  signedSnapshot,
  baseSnapshot,
  json,
  acceptedUsage,
  sse,
  lkgPath,
  parseBody,
} from "./runtime-testkit.js";

describe("Node runtime SDK streaming", () => {
  it("streams OpenAI-compatible events and records final usage after the stream ends", async () => {
    const batches: CapturedUsageBatch[] = [];
    let providerBody: Record<string, unknown> | null = null;
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      credentials: { LITELLM_API_KEY: "local-secret" },
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
      providerFetch: async (_input, init) => {
        providerBody = parseBody<Record<string, unknown>>(init);
        return sse([
          { choices: [{ delta: { content: "hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 9,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens: 2,
            },
          },
          "[DONE]",
        ]);
      },
      now: () => now,
    });
    await runtime.refresh();
    await withAiContext({ userId: "stream-user" }, async () => {
      const stream = runtime.chatStream<Record<string, unknown>>({
        model: "text.fast",
        messages: [{ role: "user", content: "hello" }],
      });
      const chunks: Array<Record<string, unknown>> = [];
      let final: unknown;
      for (;;) {
        const item = await stream.next();
        if (item.done) {
          final = item.value;
          break;
        }
        chunks.push(item.value);
      }
      expect(chunks).toHaveLength(3);
      expect(final).toMatchObject({
        virtualModel: "text.fast",
        target: { model_id: "model-primary" },
      });
    });
    expect(providerBody).toMatchObject({
      model: "litellm-primary",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(batches[0]!.events[0]).toMatchObject({
      request: { is_final_attempt: true },
      result: { status: "success" },
      usage: {
        uncached_input_tokens: "5",
        cache_read_input_tokens: "4",
        output_tokens: "2",
      },
    });
    runtime.close();
  });

  it("records a user-cancelled stream and does not continue to a fallback model", async () => {
    const batches: CapturedUsageBatch[] = [];
    let calls = 0;
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
    }).registerProviderAdapter("litellm", {
      requiresCredential: false,
      chat: async () => ({ response: {} }),
      stream: async () => ({
        httpStatus: 200,
        stream: (async function* () {
          calls += 1;
          yield { value: { choices: [{ delta: { content: "partial" } }] } };
          await new Promise(() => undefined);
        })(),
      }),
    });
    await runtime.refresh();
    await withAiContext({ userId: "cancel-user" }, async () => {
      const stream = runtime.chatStream({
        model: "text.fast",
        messages: [{ role: "user", content: "hello" }],
      });
      await expect(stream.next()).resolves.toMatchObject({ done: false });
      await stream.return(undefined as never);
    });
    expect(calls).toBe(1);
    expect(batches[0]!.events).toHaveLength(1);
    expect(batches[0]!.events[0]).toMatchObject({
      request: { is_final_attempt: true },
      result: { status: "cancelled" },
    });
    runtime.close();
  });

  it("falls back from a rate-limited OpenAI stream to an Anthropic stream", async () => {
    const routed = structuredClone(baseSnapshot);
    routed.connections["connection-litellm"]!.max_retries = 0;
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
    routed.routing["text.fast"]!.default.targets[1] = {
      ...routed.routing["text.fast"]!.default.targets[1]!,
      connection_id: "connection-anthropic",
    };
    const snapshot = signedSnapshot(routed);
    const batches: CapturedUsageBatch[] = [];
    let calls = 0;
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
          return acceptedUsage(init);
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      providerFetch: async (input, init) => {
        calls += 1;
        if (String(input).includes("models.example.com")) return json({ error: "busy" }, 429);
        expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-secret");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "litellm-fallback",
          stream: true,
        });
        return sse([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 12,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 4,
              },
            },
          },
          { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
          { type: "message_delta", usage: { output_tokens: 5 } },
        ]);
      },
      now: () => now,
    });
    await runtime.refresh();
    await withAiContext({ userId: "fallback-stream-user" }, async () => {
      const stream = runtime.chatStream({
        model: "text.fast",
        messages: [{ role: "user", content: "hello" }],
      });
      for await (const chunk of stream) {
        // Consume the full stream so usage can be settled and reported.
        void chunk;
      }
    });
    expect(calls).toBe(2);
    expect(batches[0]!.events.map((event) => event.result.status)).toEqual(["failure", "success"]);
    expect(batches[0]!.events[1]!.usage).toMatchObject({
      uncached_input_tokens: "12",
      cache_write_input_tokens: "3",
      cache_read_input_tokens: "4",
      output_tokens: "5",
    });
    runtime.close();
  });

  it("propagates AbortSignal cancellation and does not call fallback targets", async () => {
    const batches: CapturedUsageBatch[] = [];
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      credentials: { LITELLM_API_KEY: "local-secret" },
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
      providerFetch: async () => {
        calls += 1;
        throw new DOMException("cancelled", "AbortError");
      },
      now: () => now,
    });
    await runtime.refresh();
    await expect(
      withAiContext({ userId: "abort-user" }, () =>
        runtime.chat({
          model: "text.fast",
          messages: [{ role: "user", content: "hello" }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "SDK_MODEL_REQUEST_FAILED" });
    expect(calls).toBe(1);
    expect(batches[0]!.events).toHaveLength(1);
    expect(batches[0]!.events[0]!.result.status).toBe("cancelled");
    runtime.close();
  });

  it("classifies timeouts, retries boundedly, and reports every failed attempt", async () => {
    const batches: CapturedUsageBatch[] = [];
    let calls = 0;
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      credentials: { LITELLM_API_KEY: "local-secret" },
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
      providerFetch: async () => {
        calls += 1;
        throw new DOMException("timed out", "TimeoutError");
      },
      now: () => now,
    });
    await runtime.refresh();
    await expect(
      withAiContext({ userId: "timeout-user" }, () =>
        runtime.chat({ model: "text.fast", messages: [{ role: "user", content: "hello" }] }),
      ),
    ).rejects.toMatchObject({ code: "SDK_MODEL_REQUEST_FAILED" });
    expect(calls).toBe(6);
    expect(batches[0]!.events).toHaveLength(6);
    expect(batches[0]!.events.map((event) => event.result.status)).toEqual(
      Array(6).fill("timeout"),
    );
    expect(batches[0]!.events.at(-1)!.request.is_final_attempt).toBe(true);
    runtime.close();
  });
});
