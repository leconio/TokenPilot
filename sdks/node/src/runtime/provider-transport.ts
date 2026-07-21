import type { RuntimeCallConnection, RuntimeRouteTarget, UsageEvent } from "@tokenpilot/contracts";

import type { AiChatInput, AiProviderAdapter, AiProviderStreamPart } from "./types.js";
import { anthropicUsage, openAiUsage, streamUsage } from "./provider-usage.js";

export interface ProviderResult<T> {
  readonly response: T;
  readonly status: number;
  readonly usage: UsageEvent["usage"];
  readonly sourceCost: UsageEvent["source_cost"];
}

export class AiProviderRequestError extends Error {
  public constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "failure" | "timeout" | "cancelled",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/$/u, "")}${suffix}`;
}

function abortSignal(timeoutMs: number, caller: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

export async function requestProvider<T>(
  input: AiChatInput,
  target: RuntimeRouteTarget,
  connection: RuntimeCallConnection,
  credential: string,
  providerFetch: typeof fetch,
  adapter: AiProviderAdapter | undefined,
): Promise<ProviderResult<T>> {
  const signal = abortSignal(connection.timeout_ms, input.signal);
  if (adapter !== undefined) {
    try {
      const result = await adapter.chat({ input, target, connection, credential, signal });
      return {
        response: result.response as T,
        status: result.httpStatus ?? 200,
        usage: result.usage ?? { request_count: "1" },
        sourceCost: result.sourceCost ?? null,
      };
    } catch (error) {
      if (error instanceof AiProviderRequestError) throw error;
      throw providerFailure(error, input, signal);
    }
  }
  const anthropic = connection.driver === "anthropic";
  const url = anthropic
    ? endpoint(connection.base_url ?? "https://api.anthropic.com/v1", "/messages")
    : endpoint(connection.base_url, "/chat/completions");
  const headers: Record<string, string> = anthropic
    ? {
        "content-type": "application/json",
        "anthropic-version": connection.api_version ?? "2023-06-01",
        ...(credential.length === 0 ? {} : { "x-api-key": credential }),
      }
    : {
        "content-type": "application/json",
        ...(credential.length === 0 ? {} : { authorization: `Bearer ${credential}` }),
      };
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const body: Record<string, unknown> = anthropic
    ? {
        model: target.request_model,
        max_tokens: input.maxTokens ?? 1_024,
        messages: input.messages.filter((message) => message.role !== "system"),
        ...(system.length === 0 ? {} : { system }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      }
    : {
        model: target.request_model,
        messages: input.messages,
        stream: false,
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat }),
      };
  try {
    const response = await providerFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const retryable = [408, 409, 429].includes(response.status) || response.status >= 500;
      throw new AiProviderRequestError(
        `Model service returned HTTP ${response.status}.`,
        response.status,
        "failure",
        retryable,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AiProviderRequestError(
        "Model service returned invalid JSON.",
        response.status,
        "failure",
        false,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AiProviderRequestError(
        "Model service returned an invalid response.",
        response.status,
        "failure",
        false,
      );
    }
    return {
      response: value as T,
      status: response.status,
      usage: anthropic ? anthropicUsage(value) : openAiUsage(value),
      sourceCost: null,
    };
  } catch (error) {
    throw providerFailure(error, input, signal);
  }
}

async function* responseStream<T>(
  response: Response,
  driver: RuntimeCallConnection["driver"],
): AsyncGenerator<AiProviderStreamPart<T>, void, void> {
  if (response.body === null) {
    throw new AiProviderRequestError(
      "Model service returned an empty stream.",
      response.status,
      "failure",
      false,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseBlock = (block: string): AiProviderStreamPart<T> | null => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") return null;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new AiProviderRequestError(
        "Model service returned invalid streaming data.",
        response.status,
        "failure",
        false,
      );
    }
    const usage = streamUsage(value, driver);
    return usage === undefined ? { value: value as T } : { value: value as T, usage };
  };
  try {
    for (;;) {
      const read = await reader.read();
      buffer += decoder.decode(read.value, { stream: !read.done });
      let match = /\r?\n\r?\n/u.exec(buffer);
      while (match !== null) {
        const part = parseBlock(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (part !== null) yield part;
        match = /\r?\n\r?\n/u.exec(buffer);
      }
      if (read.done) break;
    }
    if (buffer.trim().length > 0) {
      const part = parseBlock(buffer);
      if (part !== null) yield part;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestProviderStream<T>(
  input: AiChatInput,
  target: RuntimeRouteTarget,
  connection: RuntimeCallConnection,
  credential: string,
  providerFetch: typeof fetch,
  adapter: AiProviderAdapter | undefined,
): Promise<{ readonly status: number; readonly stream: AsyncIterable<AiProviderStreamPart<T>> }> {
  const signal = abortSignal(connection.timeout_ms, input.signal);
  if (adapter !== undefined) {
    if (adapter.stream === undefined) {
      throw new AiProviderRequestError(
        `The registered adapter for connection ${connection.name} does not support streaming.`,
        null,
        "failure",
        false,
      );
    }
    try {
      const result = await adapter.stream({ input, target, connection, credential, signal });
      return {
        status: result.httpStatus ?? 200,
        stream: result.stream as AsyncIterable<AiProviderStreamPart<T>>,
      };
    } catch (error) {
      throw providerFailure(error, input, signal);
    }
  }
  const anthropic = connection.driver === "anthropic";
  const url = anthropic
    ? endpoint(connection.base_url ?? "https://api.anthropic.com/v1", "/messages")
    : endpoint(connection.base_url, "/chat/completions");
  const headers: Record<string, string> = anthropic
    ? {
        "content-type": "application/json",
        "anthropic-version": connection.api_version ?? "2023-06-01",
        ...(credential.length === 0 ? {} : { "x-api-key": credential }),
      }
    : {
        "content-type": "application/json",
        ...(credential.length === 0 ? {} : { authorization: `Bearer ${credential}` }),
      };
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const body: Record<string, unknown> = anthropic
    ? {
        model: target.request_model,
        max_tokens: input.maxTokens ?? 1_024,
        messages: input.messages.filter((message) => message.role !== "system"),
        stream: true,
        ...(system.length === 0 ? {} : { system }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      }
    : {
        model: target.request_model,
        messages: input.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat }),
      };
  try {
    const response = await providerFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new AiProviderRequestError(
        `Model service returned HTTP ${response.status}.`,
        response.status,
        "failure",
        [408, 409, 429].includes(response.status) || response.status >= 500,
      );
    }
    return { status: response.status, stream: responseStream<T>(response, connection.driver) };
  } catch (error) {
    throw providerFailure(error, input, signal);
  }
}

export function providerFailure(
  error: unknown,
  input: AiChatInput,
  signal: AbortSignal,
): AiProviderRequestError {
  if (error instanceof AiProviderRequestError) return error;
  if (input.signal?.aborted === true) {
    return new AiProviderRequestError("Model request was cancelled.", null, "cancelled", false);
  }
  if (
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
  ) {
    return new AiProviderRequestError("Model request timed out.", null, "timeout", true);
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new AiProviderRequestError("Model request timed out.", null, "timeout", true);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiProviderRequestError("Model request was cancelled.", null, "cancelled", false);
  }
  return new AiProviderRequestError("Model service request failed.", null, "failure", true);
}
