import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ApplicationUserGroupActionsService } from "./user-group-actions.service.js";
import { ApplicationUserGroupService } from "./user-group.service.js";

@Controller("applications/:applicationSlug/user-groups")
@UseGuards(ApiKeyScopeGuard)
export class ApplicationUserGroupController {
  constructor(
    @Inject(ApplicationUserGroupService) private readonly groups: ApplicationUserGroupService,
    @Inject(ApplicationUserGroupActionsService)
    private readonly actions: ApplicationUserGroupActionsService,
  ) {}

  @Get()
  @RequireMachineScope("admin:read")
  list() {
    return this.groups.list();
  }

  @Post()
  @RequireMachineScope("admin:write")
  create(@Body() body: unknown) {
    return this.groups.create(body);
  }

  @Post("preview")
  @RequireMachineScope("admin:read")
  preview(@Body() body: unknown) {
    return this.groups.preview(body);
  }

  @Get(":id")
  @RequireMachineScope("admin:read")
  get(@Param("id") id: string) {
    return this.groups.get(id);
  }

  @Patch(":id")
  @RequireMachineScope("admin:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.groups.update(id, body);
  }

  @Post(":id/evaluate")
  @RequireMachineScope("admin:write")
  evaluate(@Param("id") id: string) {
    return this.groups.evaluate(id);
  }

  @Get(":id/members")
  @RequireMachineScope("admin:read")
  members(@Param("id") id: string, @Query("evaluation_id") evaluationId?: string) {
    return this.groups.members(id, evaluationId);
  }

  @Post(":id/actions")
  @RequireMachineScope("admin:write")
  runAction(@Param("id") id: string, @Body() body: unknown) {
    return this.actions.run(id, body);
  }
}
