import type { Route } from "@playwright/test";

import { json, objectBody, problem } from "./control-plane-mock-http";
import { mockNow, type MockConnection, type MockModel } from "./control-plane-mock-state";

function present(model: MockModel, connections: readonly MockConnection[]) {
  const connection = connections.find((item) => item.id === model.connection_id);
  if (connection === undefined) throw new Error(`Missing mock connection ${model.connection_id}`);
  return {
    ...model,
    connection: {
      id: connection.id,
      name: connection.name,
      driver: connection.driver,
      enabled: connection.enabled,
      status: connection.status,
    },
  };
}

function references(modelId: string) {
  return modelId === "model-support"
    ? [
        {
          id: "virtual-support",
          name: "support-assistant",
          display_name: "客服虚拟模型",
          enabled: true,
          uses_as: ["default", "candidate"],
        },
      ]
    : [];
}

export function handleMockModel(
  route: Route,
  method: string,
  slug: string,
  suffix: string,
  value: unknown,
  items: MockModel[],
  connections: readonly MockConnection[],
) {
  if (suffix === "/models" && method === "GET") {
    return json(route, { models: items.map((model) => present(model, connections)) });
  }
  if (suffix === "/models" && method === "POST") {
    const input = objectBody(value);
    const requestModel = String(input.request_model);
    const model: MockModel = {
      id: `model-${slug}-${items.length + 1}`,
      name: String(input.name),
      request_model: requestModel,
      provider: String(input.provider),
      connection_id: String(input.connection_id),
      task_type: (input.task_type ?? "chat") as MockModel["task_type"],
      capabilities: Array.isArray(input.capabilities)
        ? input.capabilities.map((item) => String(item))
        : [],
      enabled: true,
    };
    items.push(model);
    return json(route, present(model, connections), 201);
  }
  const itemMatch = suffix.match(/^\/models\/([^/]+)$/u);
  if (itemMatch !== null) {
    const model = items.find((item) => item.id === itemMatch[1]);
    if (!model) return problem(route, 404, "Model not found");
    if (method === "PATCH") {
      const input = objectBody(value);
      if (typeof input.enabled === "boolean") model.enabled = input.enabled;
      return json(route, present(model, connections));
    }
    if (method !== "GET") return problem(route, 405, "Method not allowed");
    return json(route, {
      ...present(model, connections),
      metrics: {
        calls: 12,
        tokens: "3456",
        cost: "0.1234",
        currency: "USD",
        aiu: "4.5",
        aiu_micros: "4500000",
      },
      virtual_model_references: references(model.id),
      recent_issues: [],
    });
  }
  const impactMatch = suffix.match(/^\/models\/([^/]+)\/disable-impact$/u);
  if (impactMatch !== null && method === "GET") {
    const model = items.find((item) => item.id === impactMatch[1]);
    if (!model) return problem(route, 404, "Model not found");
    const virtualModels = references(model.id);
    return json(route, {
      model: present(model, connections),
      virtual_models: virtualModels,
      reference_count: virtualModels.length,
      affects_routing: virtualModels.length > 0,
    });
  }
  const match = suffix.match(/^\/models\/([^/]+)\/(rates|cost-rules|aiu)$/u);
  if (match === null) return problem(route, 404, "Model not found");
  const model = items.find((item) => item.id === match[1]);
  if (!model) return problem(route, 404, "Model not found");
  const rates = {
    model: present(model, connections),
    cost_currency: "USD",
    cost: {
      version: 1,
      currency: "USD",
      effective_from: mockNow,
      source_priority: "reported_first",
      rules: [
        {
          id: "00000000-0000-4000-8000-000000000299",
          name: "Default fallback",
          priority: 0,
          match: "all",
          conditions: [],
          fixed_amount: "0",
          rates: [
            { usage_type: "uncached_input_token", amount_per_unit: "0.000001" },
            { usage_type: "output_token", amount_per_unit: "0.000002" },
          ],
        },
      ],
    },
    aiu: {
      version: 1,
      effective_from: mockNow,
      rates: {
        input_per_million: "1",
        output_per_million: "2",
        cache_read_per_million: "0.5",
        cache_write_per_million: "1",
      },
    },
  };
  return json(route, rates, method === "GET" ? 200 : 201);
}
