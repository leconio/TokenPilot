import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ModelService } from "./model.service.js";

@Controller("applications/:applicationSlug/models")
@UseGuards(ApiKeyScopeGuard)
export class ModelController {
  constructor(@Inject(ModelService) private readonly models: ModelService) {}

  @Get()
  @RequireMachineScope("model:read")
  list(@Query() query: Record<string, string | undefined>) {
    return this.models.list(query);
  }

  @Post()
  @RequireMachineScope("model:write")
  create(@Body() body: unknown) {
    return this.models.create(body);
  }

  @Get(":id")
  @RequireMachineScope("model:read")
  get(@Param("id") id: string) {
    return this.models.get(id);
  }

  @Get(":id/disable-impact")
  @RequireMachineScope("model:read")
  disableImpact(@Param("id") id: string) {
    return this.models.disableImpact(id);
  }

  @Patch(":id")
  @RequireMachineScope("model:write")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.models.update(id, body);
  }

  @Delete(":id")
  @RequireMachineScope("model:write")
  delete(@Param("id") id: string) {
    return this.models.delete(id);
  }
}
