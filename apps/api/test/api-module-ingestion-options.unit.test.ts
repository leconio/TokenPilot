import { describe, expect, it } from "vitest";

import type { ApiConfiguration } from "../src/api-config.js";
import { ApiModule } from "../src/api.module.js";
import type { ApiInfrastructure } from "../src/infrastructure.js";
import { USAGE_INGESTION_OPTIONS } from "../src/usage-ingestion.service.js";

describe("API ingestion configuration", () => {
  it("passes the configured batch and decoded-body limits to ingestion", () => {
    const moduleDefinition = ApiModule.forRoot(
      {
        maxBatchSize: 37,
        maxDecompressedBytes: 1_234_567,
      } as ApiConfiguration,
      {} as ApiInfrastructure,
    );
    const provider = moduleDefinition.providers?.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "provide" in candidate &&
        candidate.provide === USAGE_INGESTION_OPTIONS,
    );

    expect(provider).toMatchObject({
      useValue: {
        maxBatchSize: 37,
        maxBatchBytes: 1_234_567,
      },
    });
  });
});
