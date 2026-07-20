import { Redis } from "ioredis";
import { expect, it } from "vitest";

import { enabled, redisUrl } from "./support/config.js";

export function registerConfigurationCases(): void {
  it("keeps its Redis test database isolated", () => {
    const parsed = new URL(redisUrl);
    expect(parsed.pathname).not.toBe("/");
  });

  it("can create an isolated Redis client", async () => {
    if (!enabled) return;
    const redis = new Redis(redisUrl);
    await expect(redis.ping()).resolves.toBe("PONG");
    await redis.quit();
  });
}
