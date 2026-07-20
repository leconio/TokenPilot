import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createAiRuntimeClient } from "../../sdks/node/src/runtime/client.js";
import type { ResolvedAiRuntimeContext } from "../../sdks/node/src/runtime/types.js";

interface Fixture {
  readonly snapshot: Record<string, unknown>;
  readonly context: {
    readonly user_id: string;
    readonly display_user: string | null;
    readonly operation_id: string;
    readonly request_id: string;
    readonly conversation_id: string | null;
    readonly trace_id: string;
    readonly call_source: string | null;
    readonly user_properties: Readonly<
      Record<string, string | number | boolean | readonly string[]>
    >;
    readonly analytics_dimensions: Readonly<Record<string, string | number | boolean>>;
  };
  readonly issued_at: string;
  readonly sdk_version: string;
}

describe("Node/Python Runtime Context parity", () => {
  it("renders exactly the same governed signed Metadata envelope", async () => {
    const fixtureUrl = new URL("../../fixtures/sdk/runtime-context.json", import.meta.url);
    const fixtureText = await readFile(fixtureUrl, "utf8");
    const fixture = JSON.parse(fixtureText) as Fixture;
    const client = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "runtime-parity-key-00000001",
      sdkVersion: fixture.sdk_version,
      now: () => new Date(fixture.issued_at),
      fetch: async () => new Response(JSON.stringify(fixture.snapshot), { status: 200 }),
    });
    await client.refresh();
    const context: ResolvedAiRuntimeContext = {
      userId: fixture.context.user_id,
      displayUser: fixture.context.display_user,
      applicationVersion: null,
      operationId: fixture.context.operation_id,
      requestId: fixture.context.request_id,
      conversationId: fixture.context.conversation_id,
      parentRequestId: null,
      sessionId: null,
      traceId: fixture.context.trace_id,
      callSource: fixture.context.call_source,
      eventProperties: {},
      userProperties: fixture.context.user_properties,
      analyticsDimensions: fixture.context.analytics_dimensions,
    };
    const nodeEnvelope = client.createMetadataEnvelope(context);
    const pythonEnvelope = JSON.parse(
      execFileSync(
        "uv",
        [
          "run",
          "--quiet",
          "--project",
          "sdks/python",
          "python",
          "sdks/python/scripts/render_runtime_context.py",
        ],
        { cwd: new URL("../../", import.meta.url), encoding: "utf8", input: fixtureText },
      ),
    ) as unknown;
    expect(pythonEnvelope).toEqual(nodeEnvelope);
  }, 30_000);
});
