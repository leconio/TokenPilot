import { expect } from "vitest";

export interface RuntimeOpenApiSchema {
  readonly $ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly enum?: readonly unknown[];
  readonly nullable?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, RuntimeOpenApiSchema>>;
  readonly items?: RuntimeOpenApiSchema;
  readonly additionalProperties?: boolean | RuntimeOpenApiSchema;
  readonly oneOf?: readonly RuntimeOpenApiSchema[];
  readonly allOf?: readonly RuntimeOpenApiSchema[];
}

export interface RuntimeOpenApiDocument {
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, RuntimeOpenApiSchema>>;
  };
}

function openApiSchemaIssues(
  document: RuntimeOpenApiDocument,
  schema: RuntimeOpenApiSchema,
  value: unknown,
  path = "$",
  references = new Set<string>(),
): string[] {
  if (schema.$ref !== undefined) {
    const name = /^#\/components\/schemas\/([^/]+)$/u.exec(schema.$ref)?.[1];
    if (name === undefined) return [`${path}: unsupported reference ${schema.$ref}`];
    if (references.has(name)) return [];
    const target = document.components?.schemas?.[name];
    if (target === undefined) return [`${path}: unresolved reference ${schema.$ref}`];
    return openApiSchemaIssues(document, target, value, path, new Set([...references, name]));
  }
  if (value === null && schema.nullable === true) return [];
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(
      (candidate) => openApiSchemaIssues(document, candidate, value, path, references).length === 0,
    );
    return matches.length === 1
      ? []
      : [`${path}: expected exactly one oneOf branch, got ${matches.length}`];
  }
  if (schema.allOf !== undefined) {
    return schema.allOf.flatMap((candidate) =>
      openApiSchemaIssues(document, candidate, value, path, references),
    );
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return [`${path}: value is outside enum`];
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    const issues: string[] = [];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path}: string is shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push(`${path}: string is longer than ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      issues.push(`${path}: string does not match ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) {
      issues.push(`${path}: invalid date-time`);
    }
    if (
      schema.format === "uuid" &&
      !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(value)
    ) {
      issues.push(`${path}: invalid UUID`);
    }
    return issues;
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return [`${path}: expected integer`];
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected number`];
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected boolean`];
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const issues: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(`${path}: array has fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(`${path}: array has more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      issues.push(
        ...value.flatMap((item, index) =>
          openApiSchemaIssues(document, schema.items!, item, `${path}[${index}]`, references),
        ),
      );
    }
    return issues;
  } else if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected object`];
    }
    const record = value as Record<string, unknown>;
    const issues = (schema.required ?? []).flatMap((name) =>
      Object.hasOwn(record, name) ? [] : [`${path}.${name}: required property is missing`],
    );
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, name)) {
        issues.push(
          ...openApiSchemaIssues(document, property, record[name], `${path}.${name}`, references),
        );
      }
    }
    for (const [name, propertyValue] of Object.entries(record)) {
      if (schema.properties?.[name] !== undefined) continue;
      if (schema.additionalProperties === false) {
        issues.push(`${path}.${name}: additional property is forbidden`);
      } else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        issues.push(
          ...openApiSchemaIssues(
            document,
            schema.additionalProperties,
            propertyValue,
            `${path}.${name}`,
            references,
          ),
        );
      }
    }
    return issues;
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    return [`${path}: number is below ${schema.minimum}`];
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    return [`${path}: number is above ${schema.maximum}`];
  }
  return [];
}

export function expectOpenApiResponse(
  document: RuntimeOpenApiDocument,
  path: string,
  method: "get" | "post",
  status: string,
  payload: unknown,
): void {
  const operation = document.paths[path] as
    Readonly<Record<string, { responses?: Readonly<Record<string, unknown>> }>> | undefined;
  const response = operation?.[method]?.responses?.[status] as
    | {
        content?: Readonly<Record<string, { schema?: RuntimeOpenApiSchema }>>;
      }
    | undefined;
  const schema = response?.content?.["application/json"]?.schema;
  expect(schema, `${method.toUpperCase()} ${path} ${status} must have a JSON schema`).toBeDefined();
  if (schema === undefined) return;
  expect(openApiSchemaIssues(document, schema, payload)).toEqual([]);
}
