import { describe, expect, it, vi } from "vitest";

import type { NormalizedUsage } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import { ApplicationUsageStageHandlers } from "../../src/application-usage/stage-handlers.js";

const applicationId = "00000000-0000-4000-8000-000000000101";
const modelId = "00000000-0000-4000-8000-000000000102";
const connectionId = "00000000-0000-4000-8000-000000000103";

function usage(
  id: string | null,
  tag = "openai/gpt-test",
  connection: string | null = null,
): NormalizedUsage {
  return {
    model: { model_id: id, connection_id: connection, request_model: tag },
  } as NormalizedUsage;
}

describe("application model resolution", () => {
  it("does not guess a model from an external deployment ID or ambiguous request model", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: modelId, requestModel: "openai/gpt-test" });
    const database = { modelDefinition: { findFirst } } as unknown as DatabaseClient;

    await expect(
      new ApplicationUsageStageHandlers(database).resolveModel(
        applicationId,
        usage("litellm-deployment-42"),
      ),
    ).resolves.toMatchObject({ status: "unmapped", modelId: null });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires a supplied real-model UUID and request identifier to match in the same application", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: modelId, requestModel: "openai/gpt-test" });
    const database = { modelDefinition: { findFirst } } as unknown as DatabaseClient;

    await new ApplicationUsageStageHandlers(database).resolveModel(applicationId, usage(modelId));

    expect(findFirst).toHaveBeenCalledWith({
      where: { applicationId, enabled: true, id: modelId, requestModel: "openai/gpt-test" },
      select: { id: true, connectionId: true, requestModel: true },
    });
  });

  it("resolves an event by its application connection and request model", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: modelId,
      connectionId,
      requestModel: "openai/gpt-test",
    });
    const database = { modelDefinition: { findFirst } } as unknown as DatabaseClient;

    await expect(
      new ApplicationUsageStageHandlers(database).resolveModel(
        applicationId,
        usage(null, "openai/gpt-test", connectionId),
      ),
    ).resolves.toMatchObject({ status: "matched", modelId });
    expect(findFirst).toHaveBeenCalledWith({
      where: { applicationId, enabled: true, connectionId, requestModel: "openai/gpt-test" },
      select: { id: true, connectionId: true, requestModel: true },
    });
  });
});
