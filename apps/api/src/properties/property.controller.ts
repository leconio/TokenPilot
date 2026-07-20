import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { PropertyService } from "./property.service.js";

@Controller("applications/:applicationSlug/properties")
@UseGuards(ApiKeyScopeGuard)
export class PropertyController {
  constructor(@Inject(PropertyService) private readonly properties: PropertyService) {}

  @Get()
  @RequireMachineScope("configuration:read")
  list() {
    return this.properties.list();
  }

  @Post()
  @RequireMachineScope("configuration:write")
  create(@Body() body: unknown) {
    return this.properties.create(body);
  }

  @Patch(":id")
  @RequireMachineScope("configuration:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.properties.update(id, body);
  }
}
