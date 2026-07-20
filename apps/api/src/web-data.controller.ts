import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { WebDataService } from "./web-data.service.js";

@ApiTags("Web Console")
@ApiBearerAuth()
@Controller()
@UseGuards(ApiKeyScopeGuard)
export class WebDataController {
  constructor(@Inject(WebDataService) private readonly data: WebDataService) {}

  @Get("applications/:applicationSlug/connectors")
  @RequireMachineScope("admin:read")
  connectors() {
    return this.data.connectors();
  }

  @Get("applications/:applicationSlug/audit")
  @RequireMachineScope("admin:read")
  audit(@Query() query: Record<string, unknown>) {
    return this.data.audit(query);
  }

  @Get("applications/:applicationSlug/settings")
  @RequireMachineScope("admin:read")
  settings() {
    return this.data.settings();
  }
}
