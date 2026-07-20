import type { Route } from "@playwright/test";

import { json, objectBody, problem } from "./control-plane-mock-http";
import { mockNow, type MockModel } from "./control-plane-mock-state";

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
) {
  if (suffix === "/models" && method === "GET") return json(route, { models: items });
  if (suffix === "/models" && method === "POST") {
    const input = objectBody(value);
    const tag = String(input.litellm_tag);
    const model = {
      id: `model-${slug}-${items.length + 1}`,
      name: String(input.name),
      litellm_tag: tag,
      provider: tag.split("/")[0] ?? null,
      enabled: true,
    };
    items.push(model);
    return json(route, model, 201);
  }
  const itemMatch = suffix.match(/^\/models\/([^/]+)$/u);
  if (itemMatch !== null) {
    const model = items.find((item) => item.id === itemMatch[1]);
    if (!model) return problem(route, 404, "Model not found");
    if (method === "PATCH") {
      const input = objectBody(value);
      if (typeof input.enabled === "boolean") model.enabled = input.enabled;
      return json(route, model);
    }
    if (method !== "GET") return problem(route, 405, "Method not allowed");
    return json(route, {
      ...model,
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
      model,
      virtual_models: virtualModels,
      reference_count: virtualModels.length,
      affects_routing: virtualModels.length > 0,
    });
  }
  const match = suffix.match(/^\/models\/([^/]+)\/(rates|cost|aiu)$/u);
  if (match === null) return problem(route, 404, "Model not found");
  const model = items.find((item) => item.id === match[1]);
  if (!model) return problem(route, 404, "Model not found");
  const rates = {
    model,
    cost: {
      version: 1,
      currency: "USD",
      effective_from: mockNow,
      rates: { request: "0", input_per_million: "1", output_per_million: "2" },
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
