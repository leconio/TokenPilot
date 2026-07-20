import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";

import { checkClickHouseHealth } from "../src/index.js";

describe("ClickHouse health check", () => {
  it("returns the authenticated server version and database", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ version: "26.3.17.4", database: "ai_control_plane" }]),
    });
    const client = { query } as unknown as ClickHouseClient;

    await expect(checkClickHouseHealth(client)).resolves.toMatchObject({
      ok: true,
      version: "26.3.17.4",
      database: "ai_control_plane",
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("currentDatabase()"),
        format: "JSONEachRow",
      }),
    );
  });

  it("returns a sanitized failure without throwing", async () => {
    const client = {
      query: vi
        .fn()
        .mockRejectedValue(new Error("http://admin:top-secret@clickhouse:8123 refused")),
    } as unknown as ClickHouseClient;

    await expect(checkClickHouseHealth(client)).resolves.toMatchObject({
      ok: false,
      error: "http://[redacted]@[redacted] refused",
    });
  });
});
