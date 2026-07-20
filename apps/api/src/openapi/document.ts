import type { OpenAPIObject } from "@nestjs/swagger";

import { OPENAPI_COMPONENT_SCHEMAS } from "./components/index.js";
import { OPENAPI_OPERATION_CONTRACTS } from "./paths/index.js";
import { ref } from "./schema-helpers.js";
import type { HttpMethod } from "./types.js";

const METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];
const ERROR_RESPONSES = {
  "400": "Invalid request.",
  "401": "Authentication is required.",
  "403": "Credential or CSRF authorization failed.",
  "404": "Resource not found.",
  "409": "Request conflicts with existing state.",
  "413": "Request body is too large.",
  "415": "Unsupported request media type.",
  "429": "Rate limit exceeded.",
  "503": "A required dependency is temporarily unavailable.",
} as const;

function operationKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Applies the complete, route-checked HTTP contract to the Swagger document.
 * This intentionally fails startup when a contracted public route is added without a contract,
 * or when a stale contract remains after a route is removed.
 */
export function completeOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  Object.assign(document.components.schemas, OPENAPI_COMPONENT_SCHEMAS);

  const seen = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!Object.keys(OPENAPI_OPERATION_CONTRACTS).some((key) => key.endsWith(` ${path}`))) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      const key = operationKey(method, path);
      const contract = OPENAPI_OPERATION_CONTRACTS[key];
      if (contract === undefined) throw new Error(`OpenAPI contract is missing for ${key}`);
      seen.add(key);

      operation.parameters = (contract.parameters ?? []).map((parameter) => ({
        ...parameter,
      })) as never;
      if (contract.requestBody !== undefined) {
        operation.requestBody = {
          required: true,
          ...(contract.requestBody.description === undefined
            ? {}
            : { description: contract.requestBody.description }),
          content: {
            [contract.requestBody.contentType ?? "application/json"]: {
              schema: contract.requestBody.schema,
            },
          },
        } as never;
      }
      const successContent =
        contract.success.schema === undefined
          ? undefined
          : {
              [contract.success.contentType ?? "application/json"]: {
                schema: contract.success.schema,
              },
            };
      operation.responses[contract.success.status] = {
        description: contract.success.description,
        ...(successContent === undefined ? {} : { content: successContent }),
        ...(contract.success.headers === undefined ? {} : { headers: contract.success.headers }),
      } as never;
      for (const [status, description] of Object.entries(ERROR_RESPONSES)) {
        operation.responses[status] = {
          description,
          content: { "application/json": { schema: ref("ApiErrorDto") } },
        } as never;
      }
      if (contract.security !== undefined) operation.security = [...contract.security] as never;
    }
  }

  const stale = Object.keys(OPENAPI_OPERATION_CONTRACTS).filter((key) => !seen.has(key));
  if (stale.length > 0)
    throw new Error(`OpenAPI contracts have no matching route: ${stale.join(", ")}`);
  return document;
}
