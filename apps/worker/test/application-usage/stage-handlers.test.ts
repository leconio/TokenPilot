import { describe, expect, it, vi } from "vitest";

import type { NormalizedUsage } from "@tokenpilot/contracts";
import type { DatabaseClient } from "@tokenpilot/db";

import { ApplicationUsageStageHandlers } from "../../src/application-usage/stage-handlers.js";

const applicationId = "00000000-0000-4000-8000-000000000101";
const modelId = "00000000-0000-4000-8000-000000000102";

function usage(id: string | null, tag = "openai/gpt-test"): NormalizedUsage {
  return { model: { model_id: id, model_tag: tag } } as NormalizedUsage;
}

describe("application model resolution", () => {
  it("treats an external LiteLLM deployment ID as evidence and resolves by the application tag", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: modelId, litellmTag: "openai/gpt-test" });
    const database = { modelDefinition: { findFirst } } as unknown as DatabaseClient;

    await expect(
      new ApplicationUsageStageHandlers(database).resolveModel(
        applicationId,
        usage("litellm-deployment-42"),
      ),
    ).resolves.toMatchObject({ status: "matched", modelId });
    expect(findFirst).toHaveBeenCalledWith({
      where: { applicationId, enabled: true, litellmTag: "openai/gpt-test" },
      select: { id: true, litellmTag: true },
    });
  });

  it("requires a supplied internal model UUID and LiteLLM tag to match in the same application", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: modelId, litellmTag: "openai/gpt-test" });
    const database = { modelDefinition: { findFirst } } as unknown as DatabaseClient;

    await new ApplicationUsageStageHandlers(database).resolveModel(applicationId, usage(modelId));

    expect(findFirst).toHaveBeenCalledWith({
      where: { applicationId, enabled: true, id: modelId, litellmTag: "openai/gpt-test" },
      select: { id: true, litellmTag: true },
    });
  });
});
