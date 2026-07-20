import { createHash } from "node:crypto";

import type { NormalizedUsage } from "@tokenpilot/contracts";
import { PublicationStatus, type DatabaseClient } from "@tokenpilot/db";

import type { PipelineResolutionArtifact, PipelineStageHandlers } from "../pipeline/types.js";
import {
  rateApplicationAiu,
  rateApplicationCost,
  type AiuRatingArtifact,
  type CostRatingArtifact,
} from "./rating.js";

export interface ApplicationQuotaArtifact {
  readonly kind: "application_quota";
  readonly reservationId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fingerprint(applicationId: string, modelId: string | null, tag: string | null): string {
  return `sha256:${createHash("sha256")
    .update(`${applicationId}\u0000${modelId ?? ""}\u0000${tag ?? ""}`, "utf8")
    .digest("hex")}`;
}

export class ApplicationUsageStageHandlers implements PipelineStageHandlers {
  constructor(private readonly database: DatabaseClient) {}

  async resolveModel(
    applicationId: string,
    normalized: NormalizedUsage,
  ): Promise<PipelineResolutionArtifact> {
    const modelId = normalized.model.model_id ?? null;
    const connectionId = normalized.model.connection_id ?? null;
    const requestModel = normalized.model.request_model;
    const hasModelId = modelId !== null && UUID.test(modelId);
    const hasConnectionId = connectionId !== null && UUID.test(connectionId);
    if (!hasModelId && !hasConnectionId) {
      return {
        status: "unmapped",
        modelId: null,
        mappingFingerprint: fingerprint(applicationId, modelId, requestModel),
        evidence: { model_id: modelId, connection_id: connectionId, request_model: requestModel },
      };
    }
    const model = await this.database.modelDefinition.findFirst({
      where: {
        applicationId,
        enabled: true,
        ...(hasModelId
          ? {
              id: modelId,
              requestModel,
              ...(hasConnectionId ? { connectionId } : {}),
            }
          : hasConnectionId
            ? { connectionId, requestModel }
            : {}),
      },
      select: { id: true, connectionId: true, requestModel: true },
    });
    if (model === null) {
      return {
        status: "unmapped",
        modelId: null,
        mappingFingerprint: fingerprint(applicationId, modelId, requestModel),
        evidence: { model_id: modelId, connection_id: connectionId, request_model: requestModel },
      };
    }
    return {
      status: "matched",
      modelId: model.id,
      mappingFingerprint: fingerprint(applicationId, model.id, model.requestModel),
      evidence: {
        model_id: model.id,
        connection_id: model.connectionId,
        request_model: model.requestModel,
      },
    };
  }

  async rateProviderCost(
    applicationId: string,
    normalized: NormalizedUsage,
    resolution: PipelineResolutionArtifact,
  ): Promise<CostRatingArtifact> {
    const version =
      resolution.modelId === null
        ? null
        : await this.database.modelCostVersion.findFirst({
            where: {
              applicationId,
              modelId: resolution.modelId,
              status: { in: [PublicationStatus.PUBLISHED, PublicationStatus.RETIRED] },
              effectiveFrom: { lte: new Date(normalized.event_time) },
            },
            include: { items: true },
            orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
          });
    return rateApplicationCost(version, normalized.usage_lines);
  }

  async rateAiu(
    applicationId: string,
    normalized: NormalizedUsage,
    resolution: PipelineResolutionArtifact,
  ): Promise<AiuRatingArtifact> {
    const version =
      resolution.modelId === null
        ? null
        : await this.database.modelAiuVersion.findFirst({
            where: {
              applicationId,
              modelId: resolution.modelId,
              status: { in: [PublicationStatus.PUBLISHED, PublicationStatus.RETIRED] },
              effectiveFrom: { lte: new Date(normalized.event_time) },
            },
            include: { items: true },
            orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
          });
    return rateApplicationAiu(version, normalized.usage_lines);
  }

  async settleQuota(
    _applicationId: string,
    normalized: NormalizedUsage,
  ): Promise<ApplicationQuotaArtifact> {
    return {
      kind: "application_quota",
      reservationId: normalized.request.reservation_id ?? null,
    };
  }
}
