import { expect } from "vitest";

export interface RemoteResponse {
  readonly response: Response;
  readonly body: unknown;
}

export class RemoteApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  public async json(path: string, options: RequestInit = {}): Promise<RemoteResponse> {
    const response = await this.fetch(path, options);
    const text = await response.text();
    return { response, body: text.length === 0 ? null : JSON.parse(text) };
  }

  public async text(
    path: string,
    options: RequestInit = {},
  ): Promise<{
    readonly response: Response;
    readonly body: string;
  }> {
    const response = await this.fetch(path, options);
    return { response, body: await response.text() };
  }

  public async expectJson(
    path: string,
    status: number,
    options: RequestInit = {},
  ): Promise<unknown> {
    const result = await this.json(path, options);
    expect(result.response.status, `${options.method ?? "GET"} ${path}`).toBe(status);
    return result.body;
  }

  private fetch(path: string, options: RequestInit): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (this.apiKey !== undefined) headers.set("authorization", `Bearer ${this.apiKey}`);
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  }
}

export function jsonBody(value: unknown): Pick<RequestInit, "body" | "method"> {
  return { method: "POST", body: JSON.stringify(value) };
}

export function record(value: unknown, field = "response"): Record<string, unknown> {
  expect(value, field).toBeTypeOf("object");
  expect(value, field).not.toBeNull();
  expect(Array.isArray(value), field).toBe(false);
  return value as Record<string, unknown>;
}

export function records(value: unknown, field: string): readonly Record<string, unknown>[] {
  expect(Array.isArray(value), field).toBe(true);
  return (value as unknown[]).map((item, index) => record(item, `${field}[${index}]`));
}

export function requiredString(value: unknown, field: string): string {
  expect(value, field).toBeTypeOf("string");
  expect((value as string).length, field).toBeGreaterThan(0);
  return value as string;
}

export async function poll<T>(input: {
  readonly description: string;
  readonly load: () => Promise<T>;
  readonly ready: (value: T) => boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<T> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await input.load();
    if (input.ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 500));
  }
  throw new Error(`${input.description} did not become ready: ${JSON.stringify(last)}`);
}
