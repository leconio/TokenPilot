import type { Route } from "@playwright/test";

import { json, objectBody, problem } from "./control-plane-mock-http";
import { mockNow, type MockConnection, type MockModel } from "./control-plane-mock-state";

function present(connection: MockConnection, models: readonly MockModel[]) {
  return {
    ...connection,
    model_count: models.filter((model) => model.connection_id === connection.id).length,
  };
}

export function handleMockConnection(
  route: Route,
  method: string,
  slug: string,
  suffix: string,
  value: unknown,
  items: MockConnection[],
  models: readonly MockModel[],
) {
  if (suffix === "/connections" && method === "GET") {
    return json(route, { connections: items.map((connection) => present(connection, models)) });
  }
  if (suffix === "/connections" && method === "POST") {
    const input = objectBody(value);
    const connection: MockConnection = {
      id: `connection-${slug}-${items.length + 1}`,
      name: String(input.name),
      driver: input.driver as MockConnection["driver"],
      base_url: typeof input.base_url === "string" ? input.base_url : null,
      credential_ref: typeof input.credential_ref === "string" ? input.credential_ref : null,
      public_config:
        typeof input.public_config === "object" && input.public_config !== null
          ? (input.public_config as Record<string, unknown>)
          : {},
      enabled: true,
      status: "unverified",
      last_seen_at: null,
      connector_instance: null,
      created_at: mockNow,
      updated_at: mockNow,
    };
    items.push(connection);
    return json(route, present(connection, models), 201);
  }
  const match = suffix.match(/^\/connections\/([^/]+)(?:\/(check))?$/u);
  if (match === null) return problem(route, 404, "Connection not found");
  const index = items.findIndex((item) => item.id === match[1]);
  if (index < 0) return problem(route, 404, "Connection not found");
  const connection = items[index]!;
  if (match[2] === "check" && method === "POST") {
    return json(route, { valid: true, status: connection.status, message: "Connection is valid" });
  }
  if (method === "GET") return json(route, present(connection, models));
  if (method === "PATCH") {
    const input = objectBody(value);
    if (typeof input.enabled === "boolean") connection.enabled = input.enabled;
    return json(route, present(connection, models));
  }
  if (method === "DELETE") {
    if (models.some((model) => model.connection_id === connection.id)) {
      return problem(route, 409, "Move or delete the connection's models before deleting it");
    }
    items.splice(index, 1);
    return json(route, { deleted: true });
  }
  return problem(route, 405, "Method not allowed");
}
