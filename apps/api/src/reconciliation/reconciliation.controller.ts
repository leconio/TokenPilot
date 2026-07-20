import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ReconciliationService } from "./reconciliation.service.js";

@ApiTags("Reconciliation")
@ApiBearerAuth()
@Controller("applications/:applicationSlug/reconciliation")
@UseGuards(ApiKeyScopeGuard)
export class ReconciliationController {
  constructor(
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  @Get("runs")
  @RequireMachineScope("reconciliation:read")
  listRuns(@Query() query: Record<string, unknown>) {
    return this.reconciliation.listRuns(query);
  }

  @Post("runs")
  @RequireMachineScope("reconciliation:write")
  @ApiOperation({ summary: "Queue an authoritative PostgreSQL-to-ClickHouse comparison" })
  createRun(@Body() body: unknown) {
    return this.reconciliation.createRun(body);
  }

  @Get("runs/:id")
  @RequireMachineScope("reconciliation:read")
  getRun(@Param("id") id: string) {
    return this.reconciliation.getRun(id);
  }

  @Get("runs/:id/diffs")
  @RequireMachineScope("reconciliation:read")
  listRunDiffs(@Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.reconciliation.listDiffs(query, id);
  }

  @Get("runs/:id/export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @RequireMachineScope("reconciliation:read")
  exportRun(@Param("id") id: string) {
    return this.reconciliation.exportRun(id);
  }

  @Get("diffs")
  @RequireMachineScope("reconciliation:read")
  listDiffs(@Query() query: Record<string, unknown>) {
    return this.reconciliation.listDiffs(query);
  }

  @Post("diffs/:id/replay")
  @RequireMachineScope("reconciliation:write")
  replayDiff(@Param("id") id: string, @Body() body: unknown) {
    return this.reconciliation.replayDiff(id, body);
  }

  @Post("diffs/:id/resolve")
  @RequireMachineScope("reconciliation:write")
  resolveDiff(@Param("id") id: string, @Body() body: unknown) {
    return this.reconciliation.resolveDiff(id, body);
  }

  @Post("rebuild-clickhouse")
  @RequireMachineScope("reconciliation:write")
  rebuildClickHouse(@Body() body: unknown) {
    return this.reconciliation.rebuildClickHouse(body);
  }
}
