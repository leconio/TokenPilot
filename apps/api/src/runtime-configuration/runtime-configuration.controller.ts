import { Controller, Get, Inject, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { RuntimeConfigurationRestoreService } from "./runtime-configuration-restore.service.js";
import { RuntimeConfigurationService } from "./runtime-configuration.service.js";

@Controller("applications/:applicationSlug/runtime-configurations")
@UseGuards(ApiKeyScopeGuard)
export class RuntimeConfigurationController {
  constructor(
    @Inject(RuntimeConfigurationService)
    private readonly configurations: RuntimeConfigurationService,
    @Inject(RuntimeConfigurationRestoreService)
    private readonly restoreService: RuntimeConfigurationRestoreService,
  ) {}

  @Get()
  @RequireMachineScope("configuration:read")
  list() {
    return this.configurations.list();
  }

  @Post("publish")
  @RequireMachineScope("configuration:write")
  publish() {
    return this.configurations.publish();
  }

  @Post(":version/restore")
  @RequireMachineScope("configuration:write")
  restore(@Param("version", ParseIntPipe) version: number) {
    return this.restoreService.restore(version);
  }
}
