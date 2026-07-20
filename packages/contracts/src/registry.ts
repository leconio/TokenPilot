import type { z } from "zod";

import {
  ApiErrorDto,
  BatchIngestionResponseDto,
  ConnectorHeartbeatDto,
  RuntimeConfigurationAcknowledgementDto,
  UsageBatchDto,
  UsageEventDto,
} from "./dtos.js";
import {
  apiErrorSchema,
  batchIngestionResponseSchema,
  connectorHeartbeatSchema,
} from "./machine-contracts.js";
import { virtualModelRouteMatchSchema } from "./policy.js";
import { usageConfidenceSchema, usageTypeSchema } from "./primitives.js";
import { reconciliationDiffSchema, reconciliationRunSchema } from "./reconciliation.js";
import { reportEnvelopeSchema } from "./report-envelope.js";
import { reportQuerySchema } from "./report-query.js";
import { runtimeConfigurationAcknowledgementSchema } from "./runtime-acknowledgement.js";
import {
  runtimeSnapshotSchema,
  runtimeUserReservationReleaseSchema,
  runtimeUserReservationRequestSchema,
  runtimeUserReservationResponseSchema,
  runtimeUserReservationSettlementSchema,
} from "./runtime-snapshot.js";
import { analyticsDimensionsSchema } from "./usage-context.js";
import { normalizedUsageSchema, usageBatchSchema, usageEventSchema } from "./usage-event.js";

type ContractDto = { schema: z.ZodType };

export interface ContractDefinition {
  readonly name: string;
  readonly fileName: string;
  readonly schema: z.ZodType;
  readonly dto?: ContractDto;
}

export const contractDefinitions = [
  {
    name: "ConnectorHeartbeat",
    fileName: "connector-heartbeat.schema.json",
    schema: connectorHeartbeatSchema,
    dto: ConnectorHeartbeatDto,
  },
  {
    name: "BatchIngestionResponse",
    fileName: "batch-ingestion-response.schema.json",
    schema: batchIngestionResponseSchema,
    dto: BatchIngestionResponseDto,
  },
  {
    name: "ApiError",
    fileName: "api-error.schema.json",
    schema: apiErrorSchema,
    dto: ApiErrorDto,
  },
  {
    name: "RuntimeConfigurationAcknowledgement",
    fileName: "runtime-configuration-acknowledgement.schema.json",
    schema: runtimeConfigurationAcknowledgementSchema,
    dto: RuntimeConfigurationAcknowledgementDto,
  },
  {
    name: "UsageEvent",
    fileName: "usage-event.schema.json",
    schema: usageEventSchema,
    dto: UsageEventDto,
  },
  {
    name: "UsageBatch",
    fileName: "usage-batch.schema.json",
    schema: usageBatchSchema,
    dto: UsageBatchDto,
  },
  {
    name: "NormalizedUsage",
    fileName: "normalized-usage.schema.json",
    schema: normalizedUsageSchema,
  },
  {
    name: "UsageType",
    fileName: "usage-type.schema.json",
    schema: usageTypeSchema,
  },
  {
    name: "UsageConfidence",
    fileName: "usage-confidence.schema.json",
    schema: usageConfidenceSchema,
  },
  {
    name: "AnalyticsDimensions",
    fileName: "analytics-dimensions.schema.json",
    schema: analyticsDimensionsSchema,
  },
  {
    name: "VirtualModelRouteMatch",
    fileName: "virtual-model-route-match.schema.json",
    schema: virtualModelRouteMatchSchema,
  },
  {
    name: "RuntimeSnapshot",
    fileName: "runtime-snapshot.schema.json",
    schema: runtimeSnapshotSchema,
  },
  {
    name: "RuntimeUserReservationRequest",
    fileName: "runtime-user-reservation-request.schema.json",
    schema: runtimeUserReservationRequestSchema,
  },
  {
    name: "RuntimeUserReservationResponse",
    fileName: "runtime-user-reservation-response.schema.json",
    schema: runtimeUserReservationResponseSchema,
  },
  {
    name: "RuntimeUserReservationSettlement",
    fileName: "runtime-user-reservation-settlement.schema.json",
    schema: runtimeUserReservationSettlementSchema,
  },
  {
    name: "RuntimeUserReservationRelease",
    fileName: "runtime-user-reservation-release.schema.json",
    schema: runtimeUserReservationReleaseSchema,
  },
  {
    name: "ReportQuery",
    fileName: "report-query.schema.json",
    schema: reportQuerySchema,
  },
  {
    name: "ReportEnvelope",
    fileName: "report-envelope.schema.json",
    schema: reportEnvelopeSchema,
  },
  {
    name: "ReconciliationRun",
    fileName: "reconciliation-run.schema.json",
    schema: reconciliationRunSchema,
  },
  {
    name: "ReconciliationDiff",
    fileName: "reconciliation-diff.schema.json",
    schema: reconciliationDiffSchema,
  },
] as const satisfies readonly ContractDefinition[];

export type ContractName = (typeof contractDefinitions)[number]["name"];
