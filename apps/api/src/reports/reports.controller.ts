import { Controller, Get, Inject, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ReportsService, type ReportKind } from "./reports.service.js";

@ApiTags("Reports")
@ApiBearerAuth()
@Controller("applications/:applicationSlug/reports")
@UseGuards(ApiKeyScopeGuard)
export class CurrentReportsController {
  public constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get("overview")
  @RequireMachineScope("reports:read")
  @ApiOperation({ summary: "Application analytics overview with freshness evidence" })
  public overview(@Query() query: Record<string, unknown>) {
    return this.run("overview", query);
  }

  @Get("usage")
  @RequireMachineScope("reports:read")
  public usage(@Query() query: Record<string, unknown>) {
    return this.run("usage", query);
  }

  @Get("activity")
  @RequireMachineScope("reports:read")
  public activity(@Query() query: Record<string, unknown>) {
    return this.run("activity", query);
  }

  @Get("usage/export")
  @RequireMachineScope("usage:read")
  public async usageExport(@Query() query: Record<string, unknown>): Promise<StreamableFile> {
    const stream = await this.reports.exportUsage(query);
    return new StreamableFile(stream, {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="tokenpilot-usage.csv"',
    });
  }

  @Get("provider-cost")
  @RequireMachineScope("reports:read")
  public providerCost(@Query() query: Record<string, unknown>) {
    return this.run("provider-cost", query);
  }

  @Get("aiu")
  @RequireMachineScope("reports:read")
  public aiu(@Query() query: Record<string, unknown>) {
    return this.run("aiu", query);
  }

  @Get("cache")
  @RequireMachineScope("reports:read")
  public cache(@Query() query: Record<string, unknown>) {
    return this.run("cache", query);
  }

  @Get("fallback")
  @RequireMachineScope("reports:read")
  public fallback(@Query() query: Record<string, unknown>) {
    return this.run("fallback", query);
  }

  @Get("dimensions")
  @RequireMachineScope("reports:read")
  public dimensions(@Query() query: Record<string, unknown>) {
    return this.run("dimensions", query);
  }

  @Get("pipeline-health")
  @RequireMachineScope("reports:read")
  public pipelineHealth(@Query() query: Record<string, unknown>) {
    return this.run("pipeline-health", query);
  }

  private run(kind: ReportKind, query: Record<string, unknown>) {
    return this.reports.report(kind, query);
  }
}
