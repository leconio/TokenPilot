import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { SavedReportService } from "./saved-report.service.js";

@Controller("applications/:applicationSlug/reports")
@UseGuards(ApiKeyScopeGuard)
export class SavedReportController {
  constructor(@Inject(SavedReportService) private readonly reports: SavedReportService) {}

  @Get("saved")
  @RequireMachineScope("reports:read")
  list() {
    return this.reports.list();
  }

  @Post("saved")
  @RequireMachineScope("admin:write")
  create(@Body() body: unknown) {
    return this.reports.create(body);
  }

  @Patch("saved/:id")
  @RequireMachineScope("admin:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.reports.update(id, body);
  }

  @Delete("saved/:id")
  @RequireMachineScope("admin:write")
  remove(@Param("id") id: string) {
    return this.reports.remove(id);
  }

  @Get("dashboard")
  @RequireMachineScope("reports:read")
  dashboard() {
    return this.reports.listDashboard();
  }

  @Post("dashboard")
  @RequireMachineScope("admin:write")
  addDashboard(@Body() body: unknown) {
    return this.reports.addDashboard(body);
  }

  @Patch("dashboard/:id")
  @RequireMachineScope("admin:write")
  updateDashboard(@Param("id") id: string, @Body() body: unknown) {
    return this.reports.updateDashboard(id, body);
  }

  @Delete("dashboard/:id")
  @RequireMachineScope("admin:write")
  removeDashboard(@Param("id") id: string) {
    return this.reports.removeDashboard(id);
  }
}
