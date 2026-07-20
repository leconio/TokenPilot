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
import { ConnectionService } from "./connection.service.js";

@Controller("applications/:applicationSlug/connections")
@UseGuards(ApiKeyScopeGuard)
export class ConnectionController {
  public constructor(@Inject(ConnectionService) private readonly connections: ConnectionService) {}

  @Get()
  @RequireMachineScope("model:read")
  public list() {
    return this.connections.list();
  }

  @Post()
  @RequireMachineScope("model:write")
  public create(@Body() body: unknown) {
    return this.connections.create(body);
  }

  @Get(":id")
  @RequireMachineScope("model:read")
  public get(@Param("id") id: string) {
    return this.connections.get(id);
  }

  @Patch(":id")
  @RequireMachineScope("model:write")
  public update(@Param("id") id: string, @Body() body: unknown) {
    return this.connections.update(id, body);
  }

  @Delete(":id")
  @RequireMachineScope("model:write")
  public delete(@Param("id") id: string) {
    return this.connections.delete(id);
  }

  @Post(":id/check")
  @RequireMachineScope("model:read")
  public check(@Param("id") id: string) {
    return this.connections.check(id);
  }
}
