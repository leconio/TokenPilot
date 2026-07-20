import type { OperationContract } from "../types.js";
import { array, AUDIT_REASON, body, id, object, ref, success, UUID } from "../schema-helpers.js";
import { SERVICE_KEY_CREATE } from "../schemas/platform.js";

export const SERVICE_KEY_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /applications/{applicationSlug}/service-api-keys": {
    parameters: [
      {
        in: "path",
        name: "applicationSlug",
        required: true,
        schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      },
    ],
    success: success(
      "200",
      array(ref("ServiceApiKey")),
      "Service API Keys without hashes or raw keys.",
    ),
  },
  "POST /applications/{applicationSlug}/service-api-keys": {
    parameters: [
      {
        in: "path",
        name: "applicationSlug",
        required: true,
        schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      },
    ],
    requestBody: body(SERVICE_KEY_CREATE),
    success: success(
      "201",
      object(["id", "key_prefix", "api_key"], {
        id: UUID,
        key_prefix: { type: "string" },
        api_key: {
          type: "string",
          readOnly: true,
          description: "Raw key returned exactly once and never listed again.",
        },
      }),
      "Service API Key issued once.",
    ),
  },
  "DELETE /applications/{applicationSlug}/service-api-keys/{id}": {
    parameters: [
      {
        in: "path",
        name: "applicationSlug",
        required: true,
        schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      },
      id("id"),
    ],
    requestBody: body(object(["reason"], { reason: AUDIT_REASON })),
    success: success(
      "200",
      object(["id", "name", "keyPrefix", "scopes", "status"], {
        id: UUID,
        name: { type: "string" },
        keyPrefix: { type: "string" },
        scopes: array({ type: "string" }),
        status: { type: "string", enum: ["REVOKED"] },
      }),
      "Service API Key revoked.",
    ),
  },
};
