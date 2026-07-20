import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiTags } from "@nestjs/swagger";

import { RuntimeConfigurationAcknowledgementDto } from "@tokenpilot/contracts";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { RuntimeConfigurationAcknowledgementService } from "./runtime-acknowledgement.service.js";

@ApiTags("Runtime configuration")
@ApiBearerAuth()
@Controller("runtime/configuration-acknowledgements")
@UseGuards(ApiKeyScopeGuard)
export class RuntimeConfigurationAcknowledgementController {
  public constructor(
    @Inject(RuntimeConfigurationAcknowledgementService)
    private readonly acknowledgements: RuntimeConfigurationAcknowledgementService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireMachineScope("runtime:ack")
  @ApiBody({ type: RuntimeConfigurationAcknowledgementDto })
  @ApiAcceptedResponse({ schema: { example: { status: "accepted", duplicate: false } } })
  public acknowledge(@Body() body: unknown) {
    return this.acknowledgements.acknowledge(body);
  }
}
