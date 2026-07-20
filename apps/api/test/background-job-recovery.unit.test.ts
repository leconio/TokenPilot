import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  BackgroundJobStatus,
  BackgroundJobType,
  type DatabaseClient,
  type Prisma,
} from "@tokenpilot/db";

import type { AuditService } from "../src/audit.service.js";
import type { AuditContextService } from "../src/audit-context.js";
import {
  BackgroundJobRecoveryService,
  type RecoverableBackgroundJob,
} from "../src/background-job-recovery.service.js";
import type { ExportQueue } from "../src/infrastructure.js";
import { JobsService } from "../src/jobs.service.js";

function row(
  type: BackgroundJobType,
  id: string,
  parametersJson: Prisma.JsonObject,
): RecoverableBackgroundJob & { readonly createdAt: Date } {
  return {
    id,
    applicationId:
      type === BackgroundJobType.EXPORTS_GENERATE ? "3b542859-68b4-4f38-b955-a939d67d9bf6" : null,
    type,
    status: BackgroundJobStatus.QUEUED,
    idempotencyKey: `idempotency:${id}`,
    parametersJson,
    createdAt: new Date("2026-07-16T00:00:00.000Z"),
  };
}

function databaseWithRows(rows: readonly ReturnType<typeof row>[]): DatabaseClient {
  return {
    backgroundJob: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as DatabaseClient;
}

describe("BackgroundJobRecoveryService", () => {
  it("recovers persisted application exports with fixed BullMQ job IDs", async () => {
    const jobs = [
      row(BackgroundJobType.EXPORTS_GENERATE, "54b6a9e0-efb6-49ab-a934-b6d58872dd0d", {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        format: "csv",
      }),
    ];
    const queued = new Map<string, object>();
    const exportAdd = vi.fn(async (_name, _data, options: { jobId?: string }) => {
      queued.set(String(options.jobId), {});
      return {};
    });
    const getJob = vi.fn(async (id: string) => queued.get(id));
    const service = new BackgroundJobRecoveryService(databaseWithRows(jobs), {
      add: exportAdd,
      getJob,
    } as unknown as ExportQueue);

    await expect(service.recoverPending()).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      alreadyPresent: 0,
      failed: 0,
    });
    await expect(service.recoverPending()).resolves.toEqual({
      scanned: 1,
      enqueued: 0,
      alreadyPresent: 1,
      failed: 0,
    });

    expect(exportAdd).toHaveBeenCalledTimes(1);
    expect(exportAdd.mock.calls[0]?.[2]).toMatchObject({ jobId: jobs[0]?.id });
  });

  it("keeps a failed row queued and delivers it on a later scan without a client retry", async () => {
    const persisted = row(
      BackgroundJobType.EXPORTS_GENERATE,
      "6155a8c4-7277-459e-aad2-c43c27c3b1aa",
      {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        format: "csv",
      },
    );
    let available = false;
    let queued = false;
    const add = vi.fn(async () => {
      if (!available) throw new Error("temporary Redis outage");
      queued = true;
      return {};
    });
    const service = new BackgroundJobRecoveryService(databaseWithRows([persisted]), {
      add,
      getJob: vi.fn(async () => (queued ? {} : undefined)),
    } as unknown as ExportQueue);

    await expect(service.recoverPending()).resolves.toMatchObject({ failed: 1, enqueued: 0 });
    expect(persisted.status).toBe(BackgroundJobStatus.QUEUED);

    available = true;
    await expect(service.recoverPending()).resolves.toMatchObject({ failed: 0, enqueued: 1 });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping scans in one process", async () => {
    const persisted = row(
      BackgroundJobType.EXPORTS_GENERATE,
      "6c2c6961-e313-49c8-adca-d557f411230a",
      {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        format: "csv",
      },
    );
    let release: ((rows: readonly ReturnType<typeof row>[]) => void) | undefined;
    const findMany = vi.fn(
      () =>
        new Promise<readonly ReturnType<typeof row>[]>((resolve) => {
          release = resolve;
        }),
    );
    const add = vi.fn().mockResolvedValue({});
    const service = new BackgroundJobRecoveryService(
      { backgroundJob: { findMany } } as unknown as DatabaseClient,
      { getJob: vi.fn().mockResolvedValue(undefined), add } as unknown as ExportQueue,
    );

    const first = service.recoverPending();
    const second = service.recoverPending();
    release?.([persisted]);
    await Promise.all([first, second]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("starts recovery in the background without blocking API bootstrap during a Redis outage", () => {
    const persisted = row(
      BackgroundJobType.EXPORTS_GENERATE,
      "97d9ed23-4c5d-4d52-9a6d-d33a1fa01958",
      {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        format: "csv",
      },
    );
    const never = new Promise<never>(() => undefined);
    const service = new BackgroundJobRecoveryService(databaseWithRows([persisted]), {
      getJob: vi.fn(() => never),
    } as unknown as ExportQueue);

    expect(service.onApplicationBootstrap()).toBeUndefined();
    service.onApplicationShutdown();
  });

  it("bounds an unavailable 100-row scan to one ten-operation batch and one deadline", async () => {
    vi.useFakeTimers();
    try {
      const rows = Array.from({ length: 100 }, (_unused, index) =>
        row(
          BackgroundJobType.EXPORTS_GENERATE,
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          {
            from: "2026-07-01T00:00:00.000Z",
            to: "2026-08-01T00:00:00.000Z",
            format: "csv",
          },
        ),
      );
      const never = new Promise<never>(() => undefined);
      const getJob = vi.fn(() => never);
      const service = new BackgroundJobRecoveryService(databaseWithRows(rows), {
        getJob,
      } as unknown as ExportQueue);

      const scan = service.recoverPending();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(scan).resolves.toEqual({
        scanned: 10,
        enqueued: 0,
        alreadyPresent: 0,
        failed: 10,
      });
      expect(getJob).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically retries a retained row on the periodic scan", async () => {
    vi.useFakeTimers();
    try {
      const persisted = row(
        BackgroundJobType.EXPORTS_GENERATE,
        "283e80ed-0752-4e83-b7ad-96c4d2cb21e5",
        {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
          format: "csv",
        },
      );
      let available = false;
      let queued = false;
      const add = vi.fn(async () => {
        if (!available) throw new Error("temporary Redis outage");
        queued = true;
        return {};
      });
      const service = new BackgroundJobRecoveryService(databaseWithRows([persisted]), {
        getJob: vi.fn(async () => (queued ? {} : undefined)),
        add,
      } as unknown as ExportQueue);

      service.onApplicationBootstrap();
      await service.recoverPending();
      available = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await service.recoverPending();
      service.onApplicationShutdown();

      expect(add).toHaveBeenCalledTimes(2);
      expect(queued).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("initial persistent enqueue failures", () => {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const recovery = {
    enqueue: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
  } as unknown as BackgroundJobRecoveryService;
  const context = {
    current: () => ({ applicationId: "3b542859-68b4-4f38-b955-a939d67d9bf6" }),
  } as unknown as AuditContextService;

  it("returns 503 for an export while retaining its QUEUED outbox row", async () => {
    const persisted = {
      ...row(BackgroundJobType.EXPORTS_GENERATE, "cdb70c25-d7c8-4dbc-a756-9a1970cb02af", {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-01T00:00:00.000Z",
        format: "csv",
      }),
      resultJson: null,
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
    };
    const database = {
      $transaction: vi.fn((callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ backgroundJob: { upsert: vi.fn().mockResolvedValue(persisted) } }),
      ),
    } as unknown as DatabaseClient;
    const service = new JobsService(database, recovery, audit, context);

    const result = service.createExport({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
      format: "csv",
      reason: "Finance export after outage",
    });
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({ status: 503 });
    expect(persisted.status).toBe(BackgroundJobStatus.QUEUED);
  });
});
