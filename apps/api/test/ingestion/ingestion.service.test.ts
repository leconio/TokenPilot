import { describe, expect, it, vi } from "vitest";

import type { UsageEvent } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import { canonicalPayloadHash } from "../../src/ingestion/canonical-payload.js";
import { UsageIngestionService } from "../../src/usage-ingestion.service.js";

const applicationId = "00000000-0000-4000-8000-000000000111";
const otherApplicationId = "00000000-0000-4000-8000-000000000112";
const modelId = "00000000-0000-4000-8000-000000000211";
const otherModelId = "00000000-0000-4000-8000-000000000212";

interface ModelFixture {
  readonly id: string;
  readonly applicationId: string;
  readonly litellmTag: string;
}

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    schema_version: "2.0",
    event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    event_time: "2026-07-16T08:00:00.000Z",
    user: { user_id: "user-default", display_user: "Default user" },
    source: { type: "gateway", name: "test-gateway", version: "1.0", instance_id: "gw-1" },
    request: {
      request_id: "request-1",
      attempt_id: "attempt-1",
      operation_id: "operation-1",
      parent_request_id: null,
      session_id: null,
      conversation_id: null,
      trace_id: null,
    },
    model: {
      virtual_model: "chat",
      model_tag: "openai/gpt-test",
      provider: "openai",
    },
    route: {
      configuration_version: null,
      rule: null,
      reason: "default",
      tags: [],
      fallback_from: null,
      is_final_success_attempt: true,
      is_user_visible_operation: true,
    },
    analytics_dimensions: { team: "test" },
    result: { status: "success", http_status: 200, latency_ms: 42, error_class: null },
    source_cost: null,
    privacy: { contains_prompt: false, contains_response: false },
    usage: { uncached_input_tokens: "10", output_tokens: "2" },
    ...overrides,
  };
}

function batch(events: readonly unknown[]) {
  return {
    schema_version: "2.0",
    batch_id: "batch-1",
    sent_at: "2026-07-16T08:00:01.000Z",
    events,
  };
}

function databaseFixture(models: readonly ModelFixture[] = []) {
  const rows = new Map<string, { payloadHash: string; data: Record<string, unknown> }>();
  const findFirst = vi.fn(
    async ({ where }: { where: { applicationId: string; eventId: string } }) => {
      const row = rows.get(`${where.applicationId}:${where.eventId}`);
      return row === undefined ? null : { payloadHash: row.payloadHash };
    },
  );
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const eventId = String(data.eventId);
    const key = `${String(data.applicationId)}:${eventId}`;
    if (rows.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" });
    rows.set(key, { payloadHash: String(data.payloadHash), data });
    return { id: `registry-${rows.size}` };
  });
  const upsertUser = vi.fn().mockResolvedValue({ id: "application-user-1" });
  const updateUsers = vi.fn().mockResolvedValue({ count: 1 });
  const findModelDefinition = vi.fn(
    async ({ where }: { where: { id: string; applicationId: string; litellmTag: string } }) =>
      models.find(
        (model) =>
          model.id === where.id &&
          model.applicationId === where.applicationId &&
          model.litellmTag === where.litellmTag,
      ) ?? null,
  );
  const transaction = {
    usageEventRegistry: { findFirst, create },
    applicationUser: { upsert: upsertUser, updateMany: updateUsers },
    modelDefinition: { findFirst: findModelDefinition },
  };
  const database = {
    usageEventRegistry: { findFirst },
    propertyDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  return { database, rows, create, upsertUser, updateUsers, findModelDefinition };
}

describe("UsageIngestionService", () => {
  it("rejects usage that cannot be assigned to an application user", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const event = { ...usageEvent() } as Record<string, unknown>;
    delete event.user;

    const response = await service.ingest(batch([event]), applicationId);

    expect(response).toMatchObject({ accepted: 0, rejected: 1 });
    expect(response.results[0]).toMatchObject({ code: "INVALID_EVENT" });
    expect(fixture.upsertUser).not.toHaveBeenCalled();
  });

  it("uses canonical object ordering for the immutable payload hash", () => {
    expect(canonicalPayloadHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalPayloadHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("atomically creates the Registry and Inbox without an analytics dependency", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const response = await service.ingest(batch([usageEvent()]), applicationId);

    expect(response).toMatchObject({ accepted: 1, duplicates: 0, conflicts: 0, rejected: 0 });
    expect(response.results).toEqual([
      { index: 0, event_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ", status: "accepted" },
    ]);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
          applicationId,
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          inbox: {
            create: {
              payloadJson: expect.objectContaining({ schema_version: "2.0" }),
            },
          },
        }),
      }),
    );
    expect(fixture.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          applicationId_externalId: { applicationId, externalId: "user-default" },
        },
      }),
    );
  });

  it("keeps a raw LiteLLM deployment ID as the model tag without writing it to the UUID foreign key", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const event = usageEvent({
      model: {
        virtual_model: "chat",
        model_id: "litellm-deployment-local",
        model_tag: "openai/gpt-test",
        provider: "openai",
      },
    });

    const response = await service.ingest(batch([event]), applicationId);

    expect(response).toMatchObject({ accepted: 1, rejected: 0 });
    expect(fixture.findModelDefinition).not.toHaveBeenCalled();
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          realModelId: null,
          modelTag: "openai/gpt-test",
        }),
      }),
    );
  });

  it("writes an internal model UUID only when it belongs to the application and matches the tag", async () => {
    const fixture = databaseFixture([
      { id: modelId, applicationId, litellmTag: "openai/gpt-test" },
    ]);
    const service = new UsageIngestionService(fixture.database);
    const response = await service.ingest(
      batch([
        usageEvent({
          model: {
            virtual_model: "chat",
            model_id: modelId,
            model_tag: "openai/gpt-test",
            provider: "openai",
          },
        }),
      ]),
      applicationId,
    );

    expect(response).toMatchObject({ accepted: 1, rejected: 0 });
    expect(fixture.findModelDefinition).toHaveBeenCalledWith({
      where: { id: modelId, applicationId, litellmTag: "openai/gpt-test" },
      select: { id: true },
    });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          realModelId: modelId,
          modelTag: "openai/gpt-test",
        }),
      }),
    );
  });

  it.each([
    {
      name: "another application",
      reportedModelId: modelId,
      models: [{ id: modelId, applicationId: otherApplicationId, litellmTag: "openai/gpt-test" }],
    },
    {
      name: "another LiteLLM tag",
      reportedModelId: otherModelId,
      models: [{ id: otherModelId, applicationId, litellmTag: "anthropic/claude-test" }],
    },
  ])("does not trust a model UUID from $name", async ({ reportedModelId, models }) => {
    const fixture = databaseFixture(models);
    const service = new UsageIngestionService(fixture.database);
    const response = await service.ingest(
      batch([
        usageEvent({
          model: {
            virtual_model: "chat",
            model_id: reportedModelId,
            model_tag: "openai/gpt-test",
            provider: "openai",
          },
        }),
      ]),
      applicationId,
    );

    expect(response).toMatchObject({ accepted: 1, rejected: 0 });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          realModelId: null,
          modelTag: "openai/gpt-test",
        }),
      }),
    );
  });

  it("classifies same-hash retries and immutable ID conflicts", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const original = usageEvent();
    await service.ingest(batch([original]), applicationId);

    const replay = await service.ingest(batch([structuredClone(original)]), applicationId);
    expect(replay).toMatchObject({ accepted: 0, duplicates: 1, conflicts: 0 });

    const changed = usageEvent({ usage: { uncached_input_tokens: "11", output_tokens: "2" } });
    const conflict = await service.ingest(batch([changed]), applicationId);
    expect(conflict).toMatchObject({ accepted: 0, duplicates: 0, conflicts: 1 });
    expect(conflict.results[0]).toMatchObject({
      status: "conflict",
      code: "PAYLOAD_HASH_CONFLICT",
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit result for valid, invalid, and oversized events", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database, { maxEventBytes: 1_500 });
    const invalid = {
      ...usageEvent(),
      privacy: { contains_prompt: true, contains_response: false },
    };
    const oversized = usageEvent({
      event_id: "01JZZZZZZZZZZZZZZZZZZZZZZY",
      analytics_dimensions: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`tag_${index}`, "x".repeat(120)]),
      ),
    });
    const response = await service.ingest(batch([usageEvent(), invalid, oversized]), applicationId);

    expect(response.results.map((result) => result.status)).toEqual([
      "accepted",
      "rejected",
      "rejected",
    ]);
    expect(response.results[1]).toMatchObject({ code: "INVALID_EVENT" });
    expect(response.results[2]).toMatchObject({ code: "EVENT_TOO_LARGE" });
  });

  it("accepts defined typed properties and persists built-in user fields", async () => {
    const fixture = databaseFixture();
    fixture.database.propertyDefinition.findMany = vi.fn().mockResolvedValue([
      { key: "next_action", scope: "EVENT", dataType: "TEXT", allowedValuesJson: null },
      {
        key: "customer_type",
        scope: "USER",
        dataType: "ENUM",
        allowedValuesJson: ["trial", "paid"],
      },
    ]);
    const service = new UsageIngestionService(fixture.database);
    const event = usageEvent({
      application_version: "2026.7.17",
      sdk_version: "0.2.0",
      user: { user_id: "user-42", display_user: "Ada" },
      event_properties: { next_action: "summarize" },
      user_properties: { customer_type: "paid" },
    });

    const response = await service.ingest(batch([event]), applicationId);

    expect(response).toMatchObject({ accepted: 1, rejected: 0 });
    expect(fixture.database.propertyDefinition.findMany).toHaveBeenCalledWith({
      where: { applicationId, status: "ACTIVE" },
      select: {
        key: true,
        scope: true,
        dataType: true,
        allowedValuesJson: true,
        constraintsJson: true,
      },
    });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applicationVersion: "2026.7.17",
          sdkVersion: "0.2.0",
          externalUserId: "user-42",
          userName: "Ada",
          eventPropertiesJson: { next_action: "summarize" },
          userPropertiesJson: { customer_type: "paid" },
        }),
      }),
    );
    expect(fixture.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId_externalId: { applicationId, externalId: "user-42" } },
        create: expect.objectContaining({
          applicationId,
          externalId: "user-42",
          name: "Ada",
          propertiesJson: { customer_type: "paid" },
        }),
      }),
    );
  });

  it("keeps the same reported user ID independent in every application", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const first = usageEvent({ user: { user_id: "shared-user", display_user: "First app" } });
    const second = usageEvent({
      event_id: "01JZZZZZZZZZZZZZZZZZZZZZZY",
      user: { user_id: "shared-user", display_user: "Second app" },
    });

    await service.ingest(batch([first]), applicationId);
    await service.ingest(batch([second]), otherApplicationId);

    expect(fixture.upsertUser).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { applicationId_externalId: { applicationId, externalId: "shared-user" } },
        create: expect.objectContaining({ applicationId, name: "First app" }),
      }),
    );
    expect(fixture.upsertUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          applicationId_externalId: {
            applicationId: otherApplicationId,
            externalId: "shared-user",
          },
        },
        create: expect.objectContaining({ applicationId: otherApplicationId, name: "Second app" }),
      }),
    );
  });

  it("allows two applications to use the same event ID independently", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);
    const event = usageEvent({ user: { user_id: "shared-user" } });

    const first = await service.ingest(batch([event]), applicationId);
    const second = await service.ingest(batch([structuredClone(event)]), otherApplicationId);

    expect(first).toMatchObject({ accepted: 1, conflicts: 0 });
    expect(second).toMatchObject({ accepted: 1, conflicts: 0 });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it("updates a reported display name without erasing it when later calls omit the name", async () => {
    const fixture = databaseFixture();
    const service = new UsageIngestionService(fixture.database);

    await service.ingest(
      batch([usageEvent({ user: { user_id: "user-42", display_user: "Ada Lovelace" } })]),
      applicationId,
    );
    await service.ingest(
      batch([
        usageEvent({
          event_id: "01JZZZZZZZZZZZZZZZZZZZZZZY",
          user: { user_id: "user-42" },
        }),
      ]),
      applicationId,
    );

    expect(fixture.upsertUser.mock.calls[0]?.[0]).toMatchObject({
      update: { name: "Ada Lovelace" },
    });
    expect(fixture.upsertUser.mock.calls[1]?.[0]).toMatchObject({ update: {} });
    expect(fixture.upsertUser.mock.calls[1]?.[0].update).not.toHaveProperty("name");
    expect(fixture.updateUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          applicationId,
          lastSeenAt: { lt: expect.any(Date) },
        }),
      }),
    );
  });

  it("rejects undefined and incorrectly typed properties before persistence", async () => {
    const fixture = databaseFixture();
    fixture.database.propertyDefinition.findMany = vi
      .fn()
      .mockResolvedValue([
        { key: "score", scope: "EVENT", dataType: "NUMBER", allowedValuesJson: null },
      ]);
    const service = new UsageIngestionService(fixture.database);
    const response = await service.ingest(
      batch([
        usageEvent({ event_properties: { score: "high" } }),
        usageEvent({
          event_id: "01JZZZZZZZZZZZZZZZZZZZZZZX",
          event_properties: { missing_field: true },
        }),
      ]),
      applicationId,
    );

    expect(response).toMatchObject({ accepted: 0, rejected: 2 });
    expect(response.results).toEqual([
      expect.objectContaining({ status: "rejected", code: "INVALID_PROPERTY" }),
      expect.objectContaining({ status: "rejected", code: "INVALID_PROPERTY" }),
    ]);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects a typed property that exceeds its application-defined limit", async () => {
    const fixture = databaseFixture();
    fixture.database.propertyDefinition.findMany = vi.fn().mockResolvedValue([
      {
        key: "score",
        scope: "EVENT",
        dataType: "NUMBER",
        allowedValuesJson: null,
        constraintsJson: { min: 0, max: 100 },
      },
    ]);
    const response = await new UsageIngestionService(fixture.database).ingest(
      batch([usageEvent({ event_properties: { score: 101 } })]),
      applicationId,
    );

    expect(response.results[0]).toMatchObject({ status: "rejected", code: "INVALID_PROPERTY" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
