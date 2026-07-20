import { Redis } from "ioredis";

import { loadSchedulerEnvironment } from "@tokenpilot/shared";

async function main(): Promise<void> {
  let redisUrl: string;
  try {
    redisUrl = loadSchedulerEnvironment(process.env).REDIS_URL;
  } catch {
    process.exitCode = 1;
    return;
  }

  const redis = new Redis(redisUrl, {
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  });
  // Connection errors are represented by the rejected connect/ping promise below. Avoid a
  // duplicate unhandled EventEmitter error while keeping the health command output content-free.
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    if ((await redis.ping()) !== "PONG") process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}

await main();
