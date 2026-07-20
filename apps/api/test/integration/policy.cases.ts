import { expect, it } from "vitest";
import { ulid } from "ulid";

import { policyKey } from "./support/config.js";
import { server } from "./support/harness.js";

export function registerPolicyCases(): void {
  it("serves an ETag-aware runtime configuration and journals connector application state", async () => {
    const snapshot = await server.inject({
      method: "GET",
      url: "/runtime/snapshot",
      headers: { authorization: `Bearer ${policyKey}` },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      schema_version: "2.0",
      routing: { assistant: expect.any(Object) },
    });
    const etag = snapshot.json().etag as string;
    const configurationVersion = snapshot.json().routing.assistant.configuration_version as number;
    const unchanged = await server.inject({
      method: "GET",
      url: "/runtime/snapshot",
      headers: { authorization: `Bearer ${policyKey}`, "if-none-match": `"${etag}"` },
    });
    expect(unchanged.statusCode).toBe(304);

    const acknowledgedAt = new Date().toISOString();
    const acknowledgement = {
      schema_version: "2.0",
      application_id: snapshot.json().application_id,
      acknowledgement_id: ulid(),
      acknowledged_at: acknowledgedAt,
      connector: { instance_id: "integration-litellm", name: "litellm", version: "1.2.3" },
      configuration_version: configurationVersion,
      configuration_etag: etag,
      state: "applied",
      applied_at: acknowledgedAt,
      error: null,
    };
    const accepted = await server.inject({
      method: "POST",
      url: "/runtime/configuration-acknowledgements",
      headers: {
        authorization: `Bearer ${policyKey}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(acknowledgement),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ status: "accepted", duplicate: false });
    const duplicate = await server.inject({
      method: "POST",
      url: "/runtime/configuration-acknowledgements",
      headers: {
        authorization: `Bearer ${policyKey}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(acknowledgement),
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ status: "accepted", duplicate: true });
  });
}
