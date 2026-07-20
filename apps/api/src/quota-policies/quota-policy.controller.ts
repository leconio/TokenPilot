import { Body, Controller, Delete, Get, Inject, Param, Put, UseGuards } from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { AiuQuotaPolicyService } from "./quota-policy.service.js";

@Controller("applications/:applicationSlug/quota-policies")
@UseGuards(ApiKeyScopeGuard)
export class AiuQuotaPolicyController {
  constructor(@Inject(AiuQuotaPolicyService) private readonly policies: AiuQuotaPolicyService) {}

  @Get()
  @RequireMachineScope("admin:read")
  list() {
    return this.policies.list();
  }

  @Put("application")
  @RequireMachineScope("admin:write")
  saveApplication(@Body() body: unknown) {
    return this.policies.saveApplication(body);
  }

  @Delete("application")
  @RequireMachineScope("admin:write")
  disableApplication(@Body() body: unknown) {
    return this.policies.disableApplication(body);
  }

  @Put("user-groups/:groupId")
  @RequireMachineScope("admin:write")
  saveUserGroup(@Param("groupId") groupId: string, @Body() body: unknown) {
    return this.policies.saveUserGroup(groupId, body);
  }

  @Delete("user-groups/:groupId")
  @RequireMachineScope("admin:write")
  disableUserGroup(@Param("groupId") groupId: string, @Body() body: unknown) {
    return this.policies.disableUserGroup(groupId, body);
  }
}
