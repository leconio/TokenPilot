import { expect, it } from "vitest";

import { apiErrorSchema } from "@tokenpilot/contracts";
import { hashApplicationApiKey } from "@tokenpilot/db";

import { configuration, ingestKey } from "./support/config.js";
import { usageBatch, usageEvent } from "./support/fixtures.js";
import { database, infrastructure, postJson } from "./support/harness.js";

export function registerControlCases(): void {
  it("returns 429 with Retry-After when the per-key Redis rate limit is exceeded", async () => {
    const credential = await database.applicationApiKey.findUniqueOrThrow({
      where: {
        keyHash: hashApplicationApiKey(ingestKey, configuration.apiKeyPepper),
      },
    });
    const window = Math.floor(Date.now() / 60_000);
    await infrastructure.redis.set(
      `api-rate:app:${credential.applicationId}:key:${credential.id}:${window}`,
      configuration.rateLimitMax.toString(),
      "EX",
      61,
    );
    const response = await postJson("/usage-events/batch", usageBatch([usageEvent()]));
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(apiErrorSchema.parse(response.json())).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });
}
