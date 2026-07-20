import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiTags } from "@nestjs/swagger";

import { UsageBatchDto } from "@tokenpilot/contracts";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { AuditContextService } from "./audit-context.js";
import { ConnectorMetricsService } from "./metrics.controller.js";
import { UsageIngestionService } from "./usage-ingestion.service.js";

@ApiTags("Usage")
@ApiBearerAuth()
@Controller("usage-events")
@UseGuards(ApiKeyScopeGuard)
export class UsageController {
  constructor(
    @Inject(UsageIngestionService) private readonly ingestion: UsageIngestionService,
    @Inject(ConnectorMetricsService) private readonly metrics: ConnectorMetricsService,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  @Post("batch")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireMachineScope("usage:write")
  @ApiBody({ type: UsageBatchDto })
  @ApiAcceptedResponse({
    description:
      "Each event is durably accepted, identified as a retry, rejected, or reported as an immutable ID conflict.",
  })
  async ingestBatch(@Body() body: unknown) {
    const startedAt = performance.now();
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) {
      throw new ForbiddenException("An application-bound usage key is required");
    }
    const result = await this.ingestion.ingest(body, applicationId);
    this.metrics.recordIngestion({
      accepted: result.accepted,
      duplicates: result.duplicates,
      conflicts: result.conflicts,
      rejected: result.rejected,
      latencySeconds: (performance.now() - startedAt) / 1_000,
    });
    return result;
  }
}
