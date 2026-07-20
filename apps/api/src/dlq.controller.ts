import { Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { DlqService } from "./dlq.service.js";

@ApiTags("Jobs")
@ApiBearerAuth()
@Controller("dlq")
@UseGuards(ApiKeyScopeGuard)
export class DlqController {
  constructor(@Inject(DlqService) private readonly dlq: DlqService) {}

  @Get()
  @RequireMachineScope("jobs:read")
  list(@Query() query: Record<string, unknown>) {
    return this.dlq.list(query);
  }

  @Post("replay")
  @RequireMachineScope("jobs:write")
  replay(@Body() body: unknown) {
    return this.dlq.replay(body);
  }
}
