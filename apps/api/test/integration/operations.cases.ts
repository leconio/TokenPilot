import { expect, it } from "vitest";

import { adminKey, applicationSlug, configuration } from "./support/config.js";
import { heartbeat, usageBatch, usageEvent } from "./support/fixtures.js";
import { database, postJson, server } from "./support/harness.js";

export function registerOperationsCases(): void {
  it("enforces the configurable ingestion batch maximum", async () => {
    const repeated = usageEvent();
    const response = await postJson(
      "/usage-events/batch",
      usageBatch(Array.from({ length: configuration.maxBatchSize + 1 }, () => repeated)),
    );
    expect(response.statusCode).toBe(413);
  });

  it("records application-scoped connector health", async () => {
    const payload = heartbeat();
    const response = await postJson("/connectors/heartbeat", payload);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "accepted",
      heartbeat_id: payload.heartbeat_id,
      received_at: expect.any(String),
      snapshot_updated: true,
    });
    const connector = await database.connectorInstance.findFirstOrThrow({
      where: { application: { slug: applicationSlug }, instanceId: payload.connector.instance_id },
    });
    expect(connector).toMatchObject({
      name: payload.connector.name,
      version: payload.connector.version,
      bufferDepth: payload.buffer_depth,
    });

    const visible = await server.inject({
      method: "GET",
      url: `/applications/${applicationSlug}/connectors`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({
      connectors: [{ instance_id: payload.connector.instance_id }],
    });
  });
}
