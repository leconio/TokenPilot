import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { JobsService } from "./jobs.service.js";

@ApiTags("Jobs")
@ApiBearerAuth()
@Controller("applications/:applicationSlug")
@UseGuards(ApiKeyScopeGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post("exports")
  @RequireMachineScope("jobs:write")
  createExport(@Body() body: unknown) {
    return this.jobs.createExport(body);
  }

  @Get("jobs/:id")
  @RequireMachineScope("jobs:read")
  find(@Param("id") id: string) {
    return this.jobs.find(id);
  }
}
