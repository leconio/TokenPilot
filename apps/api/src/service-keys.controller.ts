import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { ServiceKeysService } from "./service-keys.service.js";

@ApiTags("Service API Keys")
@ApiBearerAuth()
@Controller("applications/:applicationSlug/service-api-keys")
@UseGuards(ApiKeyScopeGuard)
export class ServiceKeysController {
  constructor(@Inject(ServiceKeysService) private readonly keys: ServiceKeysService) {}

  @Get()
  @RequireMachineScope("admin:read")
  async list(): Promise<unknown> {
    return this.keys.list();
  }

  @Post()
  @RequireMachineScope("admin:write")
  @ApiOperation({ summary: "Create a scoped key; raw key is returned exactly once" })
  create(@Body() body: unknown) {
    return this.keys.create(body);
  }

  @Delete(":id")
  @RequireMachineScope("admin:write")
  revoke(@Param("id") id: string, @Body() body: unknown) {
    return this.keys.revoke(id, body);
  }
}
