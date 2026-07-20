import { gzipSync } from "node:zlib";

import { expect, it } from "vitest";

import { apiErrorSchema } from "@tokenpilot/contracts";

import { applicationSlug, ingestKey, policyKey } from "./support/config.js";
import { usageBatch, usageEvent } from "./support/fixtures.js";
import { database, originalEvents, postJson, server } from "./support/harness.js";

export function registerIngestionCases(): void {
  it("reports readiness and exposes the current application-scoped API contract", async () => {
    expect((await server.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
    const document = (await server.inject({ method: "GET", url: "/openapi-json" })).json();
    for (const path of [
      "/applications/{applicationSlug}/models",
      "/applications/{applicationSlug}/users",
      "/applications/{applicationSlug}/virtual-models",
      "/applications/{applicationSlug}/runtime-configurations",
      "/applications/{applicationSlug}/reports/usage",
    ]) {
      expect(document.paths[path], path).toBeDefined();
    }
    expect(
      document.paths["/usage-events/batch"].post.requestBody.content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/UsageBatchDto" });
  });

  it("accepts a batch and creates application users from reported model-call identity", async () => {
    const response = await postJson("/usage-events/batch", usageBatch(originalEvents));
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: 100,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
    });
    const application = await database.application.findUniqueOrThrow({
      where: { slug: applicationSlug },
    });
    expect(
      await database.usageEventRegistry.count({ where: { applicationId: application.id } }),
    ).toBe(100);
    expect(
      await database.ingestionInbox.count({
        where: { applicationId: application.id },
      }),
    ).toBe(100);
    await expect(
      database.applicationUser.findUniqueOrThrow({
        where: {
          applicationId_externalId: {
            applicationId: application.id,
            externalId: "integration-user",
          },
        },
      }),
    ).resolves.toMatchObject({ name: "Integration user" });
  });

  it("returns duplicate for the same payload and conflict for a changed payload", async () => {
    const event = usageEvent();
    expect(await postJson("/usage-events/batch", usageBatch([event]))).toMatchObject({
      statusCode: 202,
    });
    const duplicate = await postJson("/usage-events/batch", usageBatch([structuredClone(event)]));
    expect(duplicate.json()).toMatchObject({ duplicates: 1, conflicts: 0 });
    const changed = { ...structuredClone(event), usage: { uncached_input_tokens: "999" } };
    const conflict = await postJson("/usage-events/batch", usageBatch([changed]));
    expect(conflict.json()).toMatchObject({ duplicates: 0, conflicts: 1 });
  });

  it("supports gzip and rejects calls without the required application user ID", async () => {
    const event = usageEvent();
    const body = gzipSync(JSON.stringify(usageBatch([event])));
    const compressed = await server.inject({
      method: "POST",
      url: "/usage-events/batch",
      headers: {
        authorization: `Bearer ${ingestKey}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      payload: body,
    });
    expect(compressed.statusCode).toBe(202);

    const missingUser = structuredClone(usageEvent()) as unknown as Record<string, unknown>;
    delete missingUser.user;
    const rejected = await postJson("/usage-events/batch", usageBatch([missingUser]));
    expect(rejected.statusCode).toBe(202);
    expect(rejected.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect(rejected.json().results[0]).toMatchObject({ code: "INVALID_EVENT" });
  });

  it("enforces application-key scopes without echoing credentials", async () => {
    const denied = await server.inject({
      method: "POST",
      url: "/usage-events/batch",
      headers: {
        authorization: `Bearer ${policyKey}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(usageBatch([usageEvent()])),
    });
    expect(denied.statusCode).toBe(403);
    expect(apiErrorSchema.parse(denied.json())).toMatchObject({ retryable: false });
    expect(JSON.stringify(denied.json())).not.toContain(policyKey);
  });
}
