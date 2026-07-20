import type { OpenAPIObject } from "@nestjs/swagger";
import { describe, expect, it } from "vitest";

import { completeOpenApiDocument, OPENAPI_OPERATION_CONTRACTS } from "../src/openapi-contract.js";

function contractDocument(): OpenAPIObject {
  const paths: Record<string, Record<string, { responses: Record<string, never> }>> = {};
  for (const key of Object.keys(OPENAPI_OPERATION_CONTRACTS)) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator).toLowerCase();
    const path = key.slice(separator + 1);
    (paths[path] ??= {})[method] = { responses: {} };
  }
  return {
    openapi: "3.0.0",
    info: { title: "determinism", version: "test" },
    paths: paths as OpenAPIObject["paths"],
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

describe("modular OpenAPI contract", () => {
  it("produces a deterministic document without duplicate operation keys", () => {
    const keys = Object.keys(OPENAPI_OPERATION_CONTRACTS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(50);
    expect(JSON.stringify(completeOpenApiDocument(contractDocument()))).toBe(
      JSON.stringify(completeOpenApiDocument(contractDocument())),
    );
  });
});
