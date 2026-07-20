import { createZodDto } from "nestjs-zod";

import {
  apiErrorSchema,
  batchIngestionResponseSchema,
  connectorHeartbeatSchema,
} from "./machine-contracts.js";
import { usageBatchSchema, usageEventSchema } from "./usage-event.js";
import { runtimeConfigurationAcknowledgementSchema } from "./runtime-acknowledgement.js";

export class UsageEventDto extends createZodDto(usageEventSchema) {}
export class UsageBatchDto extends createZodDto(usageBatchSchema) {}
export class ConnectorHeartbeatDto extends createZodDto(connectorHeartbeatSchema) {}
export class BatchIngestionResponseDto extends createZodDto(batchIngestionResponseSchema) {}
export class ApiErrorDto extends createZodDto(apiErrorSchema) {}
export class RuntimeConfigurationAcknowledgementDto extends createZodDto(
  runtimeConfigurationAcknowledgementSchema,
) {}
