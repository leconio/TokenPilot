import "reflect-metadata";

import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import type { OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";

import { ApiModule } from "../src/api.module.js";
import {
  completeOpenApiDocument,
  OPENAPI_OPERATION_CONTRACTS,
  type OpenApiSchema,
} from "../src/openapi-contract.js";

const methodNames: Readonly<Record<number, "delete" | "get" | "patch" | "post" | "put">> = {
  0: "get",
  1: "post",
  2: "put",
  3: "delete",
  4: "patch",
};

function pathPart(value: unknown): string {
  if (typeof value !== "string") throw new Error("Controller path metadata must be a string");
  return value;
}

function openApiPath(controllerPath: string, methodPath: string): string {
  const joined = `/${controllerPath}/${methodPath}`.replaceAll(/\/{2,}/gu, "/").replace(/\/$/u, "");
  return joined.replaceAll(/:([A-Za-z][A-Za-z\d_]*)/gu, "{$1}");
}

function routeDocument(): OpenAPIObject {
  const paths: OpenAPIObject["paths"] = {};
  const module = ApiModule.forRoot({} as never, {} as never);
  for (const controller of module.controllers ?? []) {
    if (typeof controller !== "function" || controller.prototype === undefined) continue;
    const controllerPath = pathPart(Reflect.getMetadata(PATH_METADATA, controller));
    for (const property of Object.getOwnPropertyNames(controller.prototype)) {
      if (property === "constructor") continue;
      const handler: unknown = controller.prototype[property];
      if (typeof handler !== "function") continue;
      const requestMethod: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof requestMethod !== "number") continue;
      const method = methodNames[requestMethod];
      if (method === undefined) continue;
      const route = openApiPath(
        controllerPath,
        pathPart(Reflect.getMetadata(PATH_METADATA, handler)),
      );
      const pathItem = (paths[route] ??= {});
      pathItem[method] = { responses: {} };
    }
  }
  return {
    openapi: "3.0.0",
    info: { title: "contract gate", version: "test" },
    paths,
    components: {
      schemas: {
        ApiErrorDto: { type: "object" },
        BatchIngestionResponseDto: { type: "object" },
        ConnectorHeartbeatDto: { type: "object" },
        RuntimeConfigurationAcknowledgementDto: { type: "object" },
        UsageBatchDto: { type: "object" },
      },
    },
  };
}

function asSchema(value: unknown): OpenApiSchema {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as OpenApiSchema;
}

function assertMeaningfulSchema(schema: OpenApiSchema): void {
  if (schema.$ref !== undefined) {
    expect(schema.$ref).toMatch(/^#\/components\/schemas\/[A-Za-z\d]+$/u);
    return;
  }
  expect(
    schema.type !== undefined || schema.oneOf !== undefined || schema.allOf !== undefined,
  ).toBe(true);
  if (schema.type === "object") {
    expect(
      Object.keys(schema.properties ?? {}).length > 0 || schema.additionalProperties !== false,
    ).toBe(true);
  }
  if (schema.type === "array") assertMeaningfulSchema(asSchema(schema.items));
  for (const candidate of schema.oneOf ?? []) assertMeaningfulSchema(candidate);
  for (const candidate of schema.allOf ?? []) assertMeaningfulSchema(candidate);
}

function schemaReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => schemaReferences(item));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : schemaReferences(child),
  );
}

function responseSchema(document: OpenAPIObject, path: string, status = "200"): OpenApiSchema {
  const response = document.paths[path]?.get?.responses[status];
  expect(response !== undefined && !("$ref" in response)).toBe(true);
  if (response === undefined || "$ref" in response) throw new Error(`Missing GET ${path}`);
  return asSchema(response.content?.["application/json"]?.schema);
}

describe("current OpenAPI contract", () => {
  it("enriches every registered contract with path parameters, schemas, and standard errors", () => {
    const document = completeOpenApiDocument(routeDocument());
    let operationCount = 0;

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = pathItem[method];
        if (operation === undefined) continue;
        if (OPENAPI_OPERATION_CONTRACTS[`${method.toUpperCase()} ${path}`] === undefined) continue;
        operationCount += 1;

        const pathNames = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]);
        const pathParameters = (operation.parameters ?? []).flatMap((parameter) =>
          "$ref" in parameter || parameter.in !== "path" ? [] : [parameter],
        );
        expect(pathParameters.map((parameter) => parameter.name).sort()).toEqual(pathNames.sort());
        for (const parameter of operation.parameters ?? []) {
          expect("$ref" in parameter).toBe(false);
          if ("$ref" in parameter) continue;
          if (parameter.in === "path") expect(parameter.required).toBe(true);
          assertMeaningfulSchema(asSchema(parameter.schema));
        }

        if (operation.requestBody !== undefined) {
          expect("$ref" in operation.requestBody).toBe(false);
          if ("$ref" in operation.requestBody) continue;
          expect(operation.requestBody.required).toBe(true);
          const media = Object.values(operation.requestBody.content);
          expect(media).toHaveLength(1);
          assertMeaningfulSchema(asSchema(media[0]?.schema));
        }

        const success = Object.entries(operation.responses).filter(([status]) =>
          /^2\d\d$/u.test(status),
        );
        expect(success).toHaveLength(1);
        const successResponse = success[0]?.[1];
        expect(successResponse !== undefined && !("$ref" in successResponse)).toBe(true);
        if (successResponse === undefined || "$ref" in successResponse) continue;
        const successMedia = Object.values(successResponse.content ?? {});
        expect(successMedia).toHaveLength(1);
        assertMeaningfulSchema(asSchema(successMedia[0]?.schema));

        for (const status of ["400", "401", "403", "404", "409", "413", "415", "429", "503"]) {
          const response = operation.responses[status];
          expect(response).toBeDefined();
          if (response === undefined || "$ref" in response) continue;
          expect(response.content?.["application/json"]?.schema).toEqual({
            $ref: "#/components/schemas/ApiErrorDto",
          });
        }
      }
    }

    expect(operationCount).toBe(Object.keys(OPENAPI_OPERATION_CONTRACTS).length);
    const schemas = document.components?.schemas ?? {};
    const unresolved = [...new Set(schemaReferences(document))].filter((reference) => {
      const name = /^#\/components\/schemas\/([^/]+)$/u.exec(reference)?.[1];
      return name === undefined || schemas[name] === undefined;
    });
    expect(unresolved).toEqual([]);
  });

  it("documents application-scoped users reported by model calls or created manually", () => {
    const document = completeOpenApiDocument(routeDocument());
    const listPath = "/applications/{applicationSlug}/users";
    const list = document.paths[listPath]?.get;
    expect(list?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "path", name: "applicationSlug", required: true }),
        expect.objectContaining({ in: "query", name: "search" }),
        expect.objectContaining({ in: "query", name: "status" }),
        expect.objectContaining({ in: "query", name: "tag" }),
      ]),
    );

    const create = document.paths[listPath]?.post?.requestBody;
    expect(create !== undefined && !("$ref" in create)).toBe(true);
    if (create === undefined || "$ref" in create) return;
    const schema = asSchema(create.content["application/json"]?.schema);
    expect(schema.required).toEqual(["user_id"]);
    expect(schema.properties?.user_id).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(schema.properties?.display_user).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(String(schema.properties?.display_user?.description)).toContain("Recommended");

    const summary = responseSchema(document, `${listPath}/summary`);
    expect(summary.required).toContain("remaining_aiu_micros");
  });

  it("documents the current application model, configuration, and reporting surfaces", () => {
    const document = completeOpenApiDocument(routeDocument());
    for (const path of [
      "/applications/{applicationSlug}/models",
      "/applications/{applicationSlug}/virtual-models",
      "/applications/{applicationSlug}/runtime-configurations",
      "/applications/{applicationSlug}/reports/usage",
      "/applications/{applicationSlug}/reports/aiu",
    ]) {
      expect(document.paths[path]).toBeDefined();
      const operation = document.paths[path]?.get;
      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: "path", name: "applicationSlug", required: true }),
        ]),
      );
    }

    const overview = document.paths["/applications/{applicationSlug}/reports/overview"]?.get;
    expect(
      overview?.parameters?.some(
        (parameter) => !("$ref" in parameter) && parameter.name === "source",
      ),
    ).toBe(false);
    const usage = document.paths["/applications/{applicationSlug}/reports/usage"]?.get;
    expect(
      usage?.parameters?.some((parameter) => !("$ref" in parameter) && parameter.name === "cursor"),
    ).toBe(true);
  });

  it("documents current application request details without retired rating fields", () => {
    const document = completeOpenApiDocument(routeDocument());
    const requestDetails = asSchema(document.components?.schemas?.RequestDetails);
    const attempts = asSchema(requestDetails.properties?.attempts);
    const attempt = asSchema(attempts.items);

    expect(attempt.required).toEqual(
      expect.arrayContaining([
        "user_id",
        "display_user",
        "model_resolution",
        "model_cost",
        "aiu",
        "aiu_history",
      ]),
    );
    expect(attempt.properties).toHaveProperty("user_id");
    expect(attempt.properties).toHaveProperty("display_user");
    expect(attempt.properties).toHaveProperty("model_resolution");
    expect(attempt.properties).toHaveProperty("model_cost");
    expect(attempt.properties).toHaveProperty("aiu");
    expect(attempt.properties).not.toHaveProperty("billing_context");
    expect(attempt.properties).not.toHaveProperty("resolution");
    expect(attempt.properties).not.toHaveProperty("provider_cost");
    expect(attempt.properties).not.toHaveProperty("aiu_rating");

    const modelResolution = asSchema(attempt.properties?.model_resolution);
    expect(modelResolution.required).toEqual(["status", "model_id", "request_model"]);
    const rawEvent = asSchema(attempt.properties?.raw_event);
    expect(rawEvent.required).toContain("error");
    expect(rawEvent.properties).not.toHaveProperty("error_code");

    expect(
      document.paths["/applications/{applicationSlug}/requests/{requestId}"]?.get?.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "path", name: "applicationSlug", required: true }),
        expect.objectContaining({ in: "path", name: "requestId", required: true }),
      ]),
    );
  });

  it("documents one-time keys, browser session protection, and current machine payloads", () => {
    const document = completeOpenApiDocument(routeDocument());
    const createKey = document.paths["/applications/{applicationSlug}/service-api-keys"]?.post;
    const createKeyResponse = createKey?.responses["201"];
    expect(createKeyResponse !== undefined && !("$ref" in createKeyResponse)).toBe(true);
    if (createKeyResponse !== undefined && !("$ref" in createKeyResponse)) {
      const schema = asSchema(createKeyResponse.content?.["application/json"]?.schema);
      expect(schema.properties?.api_key).toMatchObject({ type: "string", readOnly: true });
    }

    expect(document.paths["/web/session"]?.get?.security).toEqual([{ webSession: [] }]);
    expect(
      document.paths["/web/session/logout"]?.post?.parameters?.find(
        (parameter) => !("$ref" in parameter) && parameter.name === "x-csrf-token",
      ),
    ).toMatchObject({ in: "header", required: true });
    expect(
      document.paths["/usage-events/batch"]?.post?.requestBody !== undefined &&
        !("$ref" in document.paths["/usage-events/batch"]!.post!.requestBody!),
    ).toBe(true);
    expect(document.paths["/runtime/configuration-acknowledgements"]?.post).toBeDefined();
  });

  it("keeps capabilities, connectors, audit, and settings inside an application", () => {
    const document = completeOpenApiDocument(routeDocument());
    for (const suffix of ["capabilities", "connectors", "audit", "settings"]) {
      const path = `/applications/{applicationSlug}/${suffix}`;
      expect(document.paths[path]?.get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: "path", name: "applicationSlug", required: true }),
        ]),
      );
    }
    const settings = responseSchema(document, "/applications/{applicationSlug}/settings");
    expect(settings.required).toContain("app_name");
    expect(settings.properties).not.toHaveProperty("app_slug");
    const capabilities = responseSchema(document, "/applications/{applicationSlug}/capabilities");
    expect(Object.keys(capabilities.properties ?? {})).toEqual([
      "feature_flags",
      "capabilities",
      "permissions",
    ]);
  });
});
