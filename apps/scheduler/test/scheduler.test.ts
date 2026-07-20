import { describe, expect, it } from "vitest";

import { ControlPlaneScheduler, type SchedulerQueue } from "../src/scheduler.js";

class MemoryQueue implements SchedulerQueue {
  readonly jobs: Array<{ name: string; data: unknown; options: unknown }> = [];
  async add(
    name: string,
    data: Parameters<SchedulerQueue["add"]>[1],
    options: Parameters<SchedulerQueue["add"]>[2],
  ) {
    this.jobs.push({ name, data, options });
  }
}

describe("ControlPlaneScheduler", () => {
  it("enqueues deterministic maintenance jobs with retry jitter", async () => {
    const maintenance = new MemoryQueue();
    const scheduler = new ControlPlaneScheduler(maintenance);
    const now = new Date("2026-07-16T00:00:30.000Z");

    const first = await scheduler.tick(now);
    const second = await scheduler.tick(now);

    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
    expect(maintenance.jobs).toHaveLength(6);
    expect(maintenance.jobs[0]?.options).toMatchObject({
      attempts: 8,
      backoff: { type: "exponential", jitter: 0.5 },
    });
    expect(first).toContain("maintenance:api-key:2026-07-16T00:00:00.000Z");
  });
});
