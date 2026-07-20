import type { ContractParameter, OpenApiSchema, OperationContract } from "./types.js";

export const UUID: OpenApiSchema = { type: "string", format: "uuid" };
export const DATE_TIME: OpenApiSchema = { type: "string", format: "date-time" };
export const DECIMAL: OpenApiSchema = {
  type: "string",
  pattern: "^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
  description:
    "Exact decimal value serialized as a JSON string; never a binary floating-point number.",
};
export const NONNEGATIVE_DECIMAL: OpenApiSchema = {
  ...DECIMAL,
  pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$",
};
export const CURRENCY: OpenApiSchema = {
  type: "string",
  pattern: "^[A-Z]{3}$",
  example: "USD",
};
export const JSON_VALUE: OpenApiSchema = {
  description: "JSON value without prompt or response content.",
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "string" },
    { type: "number" },
    { type: "integer" },
    { type: "boolean" },
  ],
  nullable: true,
};
export const NULLABLE_STRING: OpenApiSchema = { type: "string", nullable: true };
export const ROUTE_TAG: OpenApiSchema = {
  type: "string",
  maxLength: 200,
  pattern: "^cp:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$",
};
export const AUDIT_REASON: OpenApiSchema = { type: "string", minLength: 5, maxLength: 500 };
export const POLICY_REASON: OpenApiSchema = { type: "string", minLength: 1, maxLength: 500 };

export function ref(name: string): OpenApiSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export function array(items: OpenApiSchema): OpenApiSchema {
  return { type: "array", items };
}

export function object(
  required: readonly string[],
  properties: Readonly<Record<string, OpenApiSchema>>,
  additionalProperties: boolean | OpenApiSchema = false,
): OpenApiSchema {
  return { type: "object", required, properties, additionalProperties };
}

export function nullable(schema: OpenApiSchema): OpenApiSchema {
  return { ...schema, nullable: true };
}

export function id(name: string): ContractParameter {
  return { name, in: "path", required: true, schema: UUID };
}

export function pathString(name: string, maxLength = 256): ContractParameter {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1, maxLength },
  };
}

export function query(
  name: string,
  schema: OpenApiSchema,
  required = false,
  description?: string,
): ContractParameter {
  return {
    name,
    in: "query",
    required,
    schema,
    ...(description === undefined ? {} : { description }),
  };
}

export function header(
  name: string,
  schema: OpenApiSchema,
  required = false,
  description?: string,
): ContractParameter {
  return {
    name,
    in: "header",
    required,
    schema,
    ...(description === undefined ? {} : { description }),
  };
}

export function success(
  status: string,
  schema: OpenApiSchema | undefined,
  description: string,
  contentType = "application/json",
  headers?: OperationContract["success"]["headers"],
): OperationContract["success"] {
  return {
    status,
    ...(schema === undefined ? {} : { schema }),
    description,
    contentType,
    ...(headers === undefined ? {} : { headers }),
  };
}

export function body(
  schema: OpenApiSchema,
  contentType = "application/json",
  description?: string,
) {
  return { schema, contentType, ...(description === undefined ? {} : { description }) };
}

export const UUID_ENTITY_FIELDS = {
  id: UUID,
  createdAt: DATE_TIME,
  updatedAt: DATE_TIME,
} satisfies Readonly<Record<string, OpenApiSchema>>;
