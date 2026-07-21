import { expect, it } from "vitest";

import { adminKey, applicationSlug } from "./support/config.js";
import { database, server } from "./support/harness.js";

function request(method: "GET" | "POST" | "PATCH" | "PUT", path: string, payload?: unknown) {
  return server.inject({
    method,
    url: `/applications/${applicationSlug}${path}`,
    headers: {
      authorization: `Bearer ${adminKey}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

export function registerAdministrationCases(): void {
  it("manages a connection, its model, independent rates, and application users", async () => {
    const connection = await request("POST", "/connections", {
      name: "Integration provider",
      driver: "openai_compatible",
      base_url: "https://models.example.test/api",
      credential_ref: "INTEGRATION_MODEL_API_KEY",
      public_config: { timeout_ms: 30_000, max_retries: 1 },
    });
    expect(connection.statusCode).toBe(201);
    expect(connection.json()).toMatchObject({
      name: "Integration provider",
      driver: "openai_compatible",
      model_count: 0,
    });

    const created = await request("POST", "/models", {
      name: "Integration model",
      connection_id: connection.json().id,
      request_model: "openai/integration-model",
      provider: "openai",
      task_type: "chat",
      capabilities: ["streaming", "tools"],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Integration model",
      request_model: "openai/integration-model",
      provider: "openai",
      task_type: "chat",
      capabilities: ["streaming", "tools"],
      connection: {
        id: connection.json().id,
        name: "Integration provider",
        driver: "openai_compatible",
      },
    });
    const modelId = created.json().id as string;

    const cost = await request("PUT", `/models/${modelId}/cost-rules`, {
      rules: [
        {
          name: "Integration fallback",
          match: "all",
          conditions: [],
          fixed_amount: "0.01",
          rates: [
            { usage_type: "uncached_input_token", amount_per_unit: "0.00000125" },
            { usage_type: "output_token", amount_per_unit: "0.0000045" },
          ],
        },
      ],
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json().cost).toMatchObject({
      source_priority: "reported_first",
      rules: [
        {
          name: "Integration fallback",
          fixed_amount: "0.01",
          rates: [
            { usage_type: "uncached_input_token", amount_per_unit: "0.00000125" },
            { usage_type: "output_token", amount_per_unit: "0.0000045" },
          ],
        },
      ],
    });
    const aiu = await request("PUT", `/models/${modelId}/aiu`, {
      input_per_million: "2",
      output_per_million: "8",
    });
    expect(aiu.statusCode).toBe(200);
    expect(aiu.json().aiu.rates).toMatchObject({
      input_per_million: "2",
      output_per_million: "8",
    });

    const manualUser = await request("POST", "/users", {
      user_id: "manual-user",
      display_user: "Manual user",
      tags: ["integration"],
    });
    expect(manualUser.statusCode).toBe(201);
    expect(manualUser.json()).toMatchObject({
      user_id: "manual-user",
      display_user: "Manual user",
    });
    const user = await request("GET", `/users/${manualUser.json().id}`);
    expect(user.statusCode).toBe(200);
    expect(user.json()).toMatchObject({
      user_id: "manual-user",
      display_user: "Manual user",
    });

    await expect(
      database.modelDefinition.findUniqueOrThrow({
        where: { id: modelId },
        include: { application: true },
      }),
    ).resolves.toMatchObject({
      requestModel: "openai/integration-model",
      connectionId: connection.json().id,
      application: { slug: applicationSlug },
    });
  });

  it("publishes a virtual model as the application's runtime configuration", async () => {
    const model = await database.modelDefinition.findFirstOrThrow({
      where: { application: { slug: applicationSlug }, enabled: true },
    });
    const created = await request("POST", "/virtual-models", {
      name: "assistant",
      display_name: "Assistant",
      task_type: "chat",
      default_model_id: model.id,
    });
    expect(created.statusCode).toBe(201);
    const virtualModelId = created.json().id as string;
    expect(
      (
        await request("POST", `/virtual-models/${virtualModelId}/routes`, {
          model_id: model.id,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await request("PATCH", `/virtual-models/${virtualModelId}`, {
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);

    const published = await request("POST", "/runtime-configurations/publish");
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({ version: 1, virtual_model_count: 1 });
    const versions = await request("GET", "/runtime-configurations");
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions[0]).toMatchObject({ version: 1, connectors: [] });
  });
}
