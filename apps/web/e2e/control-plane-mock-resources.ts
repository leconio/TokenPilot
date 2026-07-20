import type { Route } from "@playwright/test";

import { json, objectBody, problem } from "./control-plane-mock-http";
import { mockNow } from "./control-plane-mock-state";

export class ControlPlaneMockResources {
  private readonly properties = new Map<string, Array<Record<string, unknown>>>();
  private readonly virtualModels = new Map<string, Array<Record<string, unknown>>>();
  private readonly keys = new Map<string, Array<Record<string, unknown>>>();
  private readonly quotaPolicies = new Map<string, Array<Record<string, unknown>>>();

  virtualModel(route: Route, method: string, slug: string, suffix: string, value: unknown) {
    const items = this.virtualModels.get(slug) ?? [];
    this.virtualModels.set(slug, items);
    if (suffix === "/virtual-models" && method === "GET")
      return json(route, { virtual_models: items });
    if (suffix === "/virtual-models" && method === "POST") {
      const input = objectBody(value);
      const model = {
        id: `virtual-${slug}-${items.length + 1}`,
        name: String(input.name),
        display_name: String(input.display_name),
        enabled: true,
        default_model: null,
        targets: [],
        rules: [],
        last_published_version: null,
      };
      items.push(model);
      return json(route, model, 201);
    }
    return problem(route, 404, "Virtual model action not found");
  }

  quotaPolicy(route: Route, method: string, slug: string, suffix: string, value: unknown) {
    const items = this.quotaPolicies.get(slug) ?? [];
    this.quotaPolicies.set(slug, items);
    if (suffix === "/quota-policies" && method === "GET") {
      return json(route, { policies: items });
    }
    const group = suffix.match(/^\/quota-policies\/user-groups\/([^/]+)$/u);
    const scope = group === null ? "application" : "user_group";
    const subjectId = group?.[1] ?? null;
    if (suffix !== "/quota-policies/application" && group === null) {
      return problem(route, 404, "AIU quota rule not found");
    }
    const index = items.findIndex(
      (policy) =>
        policy.scope === scope && (scope === "application" || policy.user_group_id === subjectId),
    );
    if (method === "PUT") {
      const input = objectBody(value);
      const limit = String(input.limit ?? "0");
      const [whole = "0", fraction = ""] = limit.split(".");
      const policy = {
        id:
          index < 0 ? `quota-policy-${slug}-${scope}-${subjectId ?? "default"}` : items[index]!.id,
        scope,
        user_id: null,
        user_group_id: subjectId,
        subject_name: null,
        limit_aiu_micros: (
          BigInt(whole) * 1_000_000n +
          BigInt(fraction.padEnd(6, "0") || "0")
        ).toString(),
        hard_limit: Boolean(input.hard_limit),
        period: String(input.period ?? "month"),
        starts_at: input.starts_at ?? null,
        ends_at: input.ends_at ?? null,
        priority: Number(input.priority ?? 0),
        enabled: true,
        updated_at: mockNow,
      };
      if (index < 0) items.push(policy);
      else items[index] = policy;
      return json(route, policy);
    }
    if (method === "DELETE" && index >= 0) {
      items[index] = { ...items[index], enabled: false, updated_at: mockNow };
      return json(route, items[index]);
    }
    return problem(route, 404, "AIU quota rule not found");
  }

  property(route: Route, method: string, slug: string, suffix: string, value: unknown) {
    const items = this.properties.get(slug) ?? [];
    this.properties.set(slug, items);
    if (suffix === "/properties" && method === "GET") return json(route, { properties: items });
    if (suffix === "/properties" && method === "POST") {
      const input = objectBody(value);
      const property = {
        id: `property-${items.length + 1}`,
        ...input,
        allowed_values: input.allowed_values ?? null,
        status: "ACTIVE",
      };
      items.push(property);
      return json(route, property, 201);
    }
    return problem(route, 404, "Property not found");
  }

  serviceKey(route: Route, method: string, slug: string, suffix: string, value: unknown) {
    const items = this.keys.get(slug) ?? [];
    this.keys.set(slug, items);
    if (suffix === "/service-api-keys" && method === "GET") return json(route, items);
    if (suffix === "/service-api-keys" && method === "POST") {
      const input = objectBody(value);
      const key = {
        id: `key-${slug}-${items.length + 1}`,
        name: String(input.name),
        key_prefix: "tp_live_demo",
        scopes: input.scopes ?? [],
        status: "ACTIVE",
        last_used_at: null,
        expires_at: null,
        created_at: mockNow,
      };
      items.push(key);
      return json(route, { ...key, api_key: `tp_live_${slug}_shown_once` }, 201);
    }
    if (method === "DELETE") return json(route, { status: "REVOKED" });
    return problem(route, 405, "Method not allowed");
  }
}
