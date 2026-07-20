import type { DatabaseClient } from "./client.js";
import { CallConnectionDriver, ModelTaskType } from "./generated/prisma/client.js";

export const exampleSeedApplicationEnvironment = "TOKENPILOT_EXAMPLE_APPLICATION_SLUG";

/**
 * Adds a secret-free routing example to an application that already exists.
 * The regular database seed intentionally does not call this function.
 */
export async function seedExampleModelRouting(
  database: DatabaseClient,
  applicationSlug: string,
): Promise<{
  applicationId: string;
  connectionIds: readonly [string, string];
  modelIds: readonly [string, string];
  virtualModelId: string;
}> {
  const application = await database.application.findUnique({
    where: { slug: applicationSlug },
    select: { id: true },
  });
  if (application === null) {
    throw new Error(`Application ${applicationSlug} does not exist; finish Setup first`);
  }

  const liteLlmConnection = await database.callConnection.upsert({
    where: {
      applicationId_name: { applicationId: application.id, name: "Example LiteLLM" },
    },
    create: {
      applicationId: application.id,
      name: "Example LiteLLM",
      driver: CallConnectionDriver.LITELLM,
      baseUrl: "http://127.0.0.1:4001/v1",
      credentialRef: "LITELLM_API_KEY",
      publicConfigJson: { timeout_ms: 60_000, max_retries: 1 },
    },
    update: {
      driver: CallConnectionDriver.LITELLM,
      baseUrl: "http://127.0.0.1:4001/v1",
      credentialRef: "LITELLM_API_KEY",
      publicConfigJson: { timeout_ms: 60_000, max_retries: 1 },
      enabled: true,
    },
    select: { id: true },
  });
  const directConnection = await database.callConnection.upsert({
    where: {
      applicationId_name: {
        applicationId: application.id,
        name: "Example OpenAI compatible",
      },
    },
    create: {
      applicationId: application.id,
      name: "Example OpenAI compatible",
      driver: CallConnectionDriver.OPENAI_COMPATIBLE,
      baseUrl: "https://api.openai.com/v1",
      credentialRef: "OPENAI_API_KEY",
      publicConfigJson: { timeout_ms: 60_000, max_retries: 1 },
    },
    update: {
      driver: CallConnectionDriver.OPENAI_COMPATIBLE,
      baseUrl: "https://api.openai.com/v1",
      credentialRef: "OPENAI_API_KEY",
      publicConfigJson: { timeout_ms: 60_000, max_retries: 1 },
      enabled: true,
    },
    select: { id: true },
  });

  const primaryModel = await database.modelDefinition.upsert({
    where: {
      applicationId_connectionId_requestModel: {
        applicationId: application.id,
        connectionId: liteLlmConnection.id,
        requestModel: "customer-support-primary",
      },
    },
    create: {
      applicationId: application.id,
      connectionId: liteLlmConnection.id,
      name: "Example primary",
      requestModel: "customer-support-primary",
      provider: "example",
      taskType: ModelTaskType.CHAT,
      capabilitiesJson: ["streaming", "tools", "structured_output"],
    },
    update: {
      name: "Example primary",
      provider: "example",
      taskType: ModelTaskType.CHAT,
      capabilitiesJson: ["streaming", "tools", "structured_output"],
      enabled: true,
    },
    select: { id: true },
  });
  const fallbackModel = await database.modelDefinition.upsert({
    where: {
      applicationId_connectionId_requestModel: {
        applicationId: application.id,
        connectionId: directConnection.id,
        requestModel: "gpt-4.1-mini",
      },
    },
    create: {
      applicationId: application.id,
      connectionId: directConnection.id,
      name: "Example fallback",
      requestModel: "gpt-4.1-mini",
      provider: "openai",
      taskType: ModelTaskType.CHAT,
      capabilitiesJson: ["streaming", "tools", "structured_output", "image_input"],
    },
    update: {
      name: "Example fallback",
      provider: "openai",
      taskType: ModelTaskType.CHAT,
      capabilitiesJson: ["streaming", "tools", "structured_output", "image_input"],
      enabled: true,
    },
    select: { id: true },
  });

  const virtualModel = await database.virtualModel.upsert({
    where: {
      applicationId_name: { applicationId: application.id, name: "customer-support" },
    },
    create: {
      applicationId: application.id,
      name: "customer-support",
      displayName: "Customer support",
      taskType: ModelTaskType.CHAT,
      defaultModelId: primaryModel.id,
      enabled: true,
      description: "Secret-free example with LiteLLM primary and direct fallback.",
    },
    update: {
      displayName: "Customer support",
      taskType: ModelTaskType.CHAT,
      defaultModelId: primaryModel.id,
      enabled: true,
    },
    select: { id: true },
  });
  await database.virtualModelTarget.upsert({
    where: {
      virtualModelId_modelId: {
        virtualModelId: virtualModel.id,
        modelId: primaryModel.id,
      },
    },
    create: {
      applicationId: application.id,
      virtualModelId: virtualModel.id,
      modelId: primaryModel.id,
      priority: 0,
      weight: 1,
    },
    update: { priority: 0, weight: 1, enabled: true },
  });
  await database.virtualModelTarget.upsert({
    where: {
      virtualModelId_modelId: {
        virtualModelId: virtualModel.id,
        modelId: fallbackModel.id,
      },
    },
    create: {
      applicationId: application.id,
      virtualModelId: virtualModel.id,
      modelId: fallbackModel.id,
      priority: 1,
      weight: 1,
    },
    update: { priority: 1, weight: 1, enabled: true },
  });

  return {
    applicationId: application.id,
    connectionIds: [liteLlmConnection.id, directConnection.id],
    modelIds: [primaryModel.id, fallbackModel.id],
    virtualModelId: virtualModel.id,
  };
}
