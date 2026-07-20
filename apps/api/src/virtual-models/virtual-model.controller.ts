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
import { VirtualModelService } from "./virtual-model.service.js";

@Controller("applications/:applicationSlug/virtual-models")
@UseGuards(ApiKeyScopeGuard)
export class VirtualModelController {
  constructor(@Inject(VirtualModelService) private readonly virtualModels: VirtualModelService) {}

  @Get()
  @RequireMachineScope("configuration:read")
  list() {
    return this.virtualModels.list();
  }

  @Post()
  @RequireMachineScope("configuration:write")
  create(@Body() body: unknown) {
    return this.virtualModels.create(body);
  }

  @Patch(":id")
  @RequireMachineScope("configuration:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.virtualModels.update(id, body);
  }

  @Post(":id/routes")
  @RequireMachineScope("configuration:write")
  addTarget(@Param("id") id: string, @Body() body: unknown) {
    return this.virtualModels.addTarget(id, body);
  }

  @Post(":id/routes/reorder")
  @RequireMachineScope("configuration:write")
  reorderTargets(@Param("id") id: string, @Body() body: unknown) {
    return this.virtualModels.reorderTargets(id, body);
  }

  @Patch(":id/routes/:targetId")
  @RequireMachineScope("configuration:write")
  updateTarget(
    @Param("id") id: string,
    @Param("targetId") targetId: string,
    @Body() body: unknown,
  ) {
    return this.virtualModels.updateTarget(id, targetId, body);
  }

  @Post(":id/rules")
  @RequireMachineScope("configuration:write")
  addRule(@Param("id") id: string, @Body() body: unknown) {
    return this.virtualModels.addRule(id, body);
  }

  @Patch(":id/rules/:ruleId")
  @RequireMachineScope("configuration:write")
  updateRule(@Param("id") id: string, @Param("ruleId") ruleId: string, @Body() body: unknown) {
    return this.virtualModels.updateRule(id, ruleId, body);
  }

  @Delete(":id/rules/:ruleId")
  @RequireMachineScope("configuration:write")
  removeRule(@Param("id") id: string, @Param("ruleId") ruleId: string) {
    return this.virtualModels.removeRule(id, ruleId);
  }

  @Post(":id/simulate")
  @RequireMachineScope("configuration:read")
  simulate(@Param("id") id: string, @Body() body: unknown) {
    return this.virtualModels.simulate(id, body);
  }
}
