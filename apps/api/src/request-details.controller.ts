import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { RequestDetailsService } from "./request-details.service.js";

@ApiTags("Requests")
@ApiBearerAuth()
@Controller("applications/:applicationSlug/requests")
@UseGuards(ApiKeyScopeGuard)
export class RequestDetailsController {
  constructor(@Inject(RequestDetailsService) private readonly requests: RequestDetailsService) {}

  @Get(":requestId")
  @RequireMachineScope("usage:read")
  @ApiOperation({ summary: "Explain a request inside the current application" })
  @ApiOkResponse({ description: "A content-free request, model cost, and AIU explanation" })
  find(@Param("requestId") requestId: string) {
    return this.requests.find(requestId);
  }
}
