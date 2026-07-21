import { Body, Controller, Get, Inject, Param, Put, UseGuards } from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ModelPricingService } from "./model-pricing.service.js";

@Controller("applications/:applicationSlug/models/:id")
@UseGuards(ApiKeyScopeGuard)
export class ModelPricingController {
  constructor(@Inject(ModelPricingService) private readonly pricing: ModelPricingService) {}

  @Get("rates")
  @RequireMachineScope("pricing:read")
  get(@Param("id") id: string) {
    return this.pricing.get(id);
  }

  @Put("cost-rules")
  @RequireMachineScope("pricing:write")
  saveCostRules(@Param("id") id: string, @Body() body: unknown) {
    return this.pricing.saveCostRules(id, body);
  }

  @Put("aiu")
  @RequireMachineScope("pricing:write")
  saveAiu(@Param("id") id: string, @Body() body: unknown) {
    return this.pricing.saveAiu(id, body);
  }
}
