import { expect, it } from "vitest";

import { adminKey } from "./support/config.js";
import { server } from "./support/harness.js";
import {
  expectOpenApiResponse,
  type RuntimeOpenApiDocument,
} from "./support/openapi-assertions.js";

export function registerReportingCases(): void {
  it("serves reports only through the mandatory ClickHouse analytics path", async () => {
    const openapi = await server.inject({ method: "GET", url: "/openapi-json" });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json() as RuntimeOpenApiDocument;
    const reportBase = "/applications/current-integration/reports";
    const reportContractBase = "/applications/{applicationSlug}/reports";
    const operation = document.paths[`${reportContractBase}/overview`] as
      | {
          readonly get?: {
            readonly parameters?: readonly (
              { readonly $ref: string } | { readonly name: string }
            )[];
          };
        }
      | undefined;
    expect(operation?.get).toBeDefined();
    expect(
      operation?.get?.parameters?.some(
        (parameter) => !("$ref" in parameter) && parameter.name === "source",
      ),
    ).toBe(false);

    const range = "from=2028-01-01T15%3A00%3A00Z&to=2028-01-01T17%3A00%3A00Z";
    const getReport = (endpoint: string) =>
      server.inject({
        method: "GET",
        url: `${reportBase}/${endpoint}${endpoint.includes("?") ? "&" : "?"}${range}`,
        headers: { authorization: `Bearer ${adminKey}` },
      });

    const overview = await getReport("overview");
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      watermark: null,
      lag_seconds: null,
      range: {
        from: "2028-01-01T15:00:00.000Z",
        to: "2028-01-01T17:00:00.000Z",
        timezone: "Asia/Shanghai",
      },
      data: {
        requests: 0,
        attempts: 0,
        aiu: null,
      },
    });
    expect(overview.json()).not.toHaveProperty("source");
    expect(overview.json()).not.toHaveProperty("is_provisional");
    expect(overview.json()).not.toHaveProperty("as_of");
    expectOpenApiResponse(
      document,
      `${reportContractBase}/overview`,
      "get",
      "200",
      overview.json(),
    );

    const pipeline = await getReport("pipeline-health");
    expect(pipeline.statusCode).toBe(200);
    expect(pipeline.json()).toMatchObject({
      data: { postgres: "healthy", redis: "healthy", clickhouse: "healthy" },
    });

    for (const source of ["official", "realtime", "postgres", "clickhouse"]) {
      const rejected = await getReport(`overview?source=${source}`);
      expect(rejected.statusCode).toBe(400);
    }

    const injected = await getReport(
      "usage?group_dimension=provider%3Bdrop%20table%20usage_event_registry",
    );
    expect(injected.statusCode).toBe(400);

    const numberedUsagePage = await getReport("usage?page=2");
    expect(numberedUsagePage.statusCode).toBe(400);
    const numberedCostPage = await getReport("provider-cost?page=2");
    expect(numberedCostPage.statusCode).toBe(400);
    const numberedAiuPage = await getReport("aiu?page=2");
    expect(numberedAiuPage.statusCode).toBe(400);
  });
}
