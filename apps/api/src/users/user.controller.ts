import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ApplicationUserService } from "./user.service.js";

@Controller("applications/:applicationSlug/users")
@UseGuards(ApiKeyScopeGuard)
export class ApplicationUserController {
  constructor(@Inject(ApplicationUserService) private readonly users: ApplicationUserService) {}

  @Get()
  @RequireMachineScope("admin:read")
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Post()
  @RequireMachineScope("admin:write")
  create(@Body() body: unknown) {
    return this.users.create(body);
  }

  @Get("summary")
  @RequireMachineScope("admin:read")
  summary() {
    return this.users.summary();
  }

  @Get(":id")
  @RequireMachineScope("admin:read")
  get(@Param("id") id: string) {
    return this.users.get(id);
  }

  @Get(":id/analytics")
  @RequireMachineScope("admin:read")
  analytics(@Param("id") id: string, @Query() query: Record<string, unknown>) {
    return this.users.analytics(id, query);
  }

  @Patch(":id")
  @RequireMachineScope("admin:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.users.update(id, body);
  }

  @Put(":id/quota")
  @RequireMachineScope("admin:write")
  saveQuota(@Param("id") id: string, @Body() body: unknown) {
    return this.users.saveQuota(id, body);
  }

  @Post(":id/quota/reset")
  @RequireMachineScope("admin:write")
  resetQuota(@Param("id") id: string, @Body() body: unknown) {
    return this.users.resetQuota(id, body);
  }

  @Get(":id/aiu-ledger")
  @RequireMachineScope("admin:read")
  ledger(@Param("id") id: string, @Query("limit") limit?: string) {
    return this.users.ledger(id, limit === undefined ? 100 : Number(limit));
  }
}
