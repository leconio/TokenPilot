import type { OpenApiSchema } from "../types.js";
import { array, DATE_TIME, nullable, object, UUID } from "../schema-helpers.js";

export const SERVICE_KEY_COMPONENT_SCHEMAS: Readonly<Record<string, OpenApiSchema>> = {
  ServiceApiKey: object(
    ["id", "name", "keyPrefix", "scopes", "status", "lastUsedAt", "expiresAt", "createdAt"],
    {
      id: UUID,
      name: { type: "string" },
      keyPrefix: { type: "string", description: "Non-secret identifying prefix." },
      scopes: array({ type: "string" }),
      status: { type: "string", enum: ["ACTIVE", "REVOKED", "EXPIRED"] },
      lastUsedAt: nullable(DATE_TIME),
      expiresAt: nullable(DATE_TIME),
      createdAt: DATE_TIME,
    },
  ),
};
