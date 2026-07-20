import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { ApplicationMembersService } from "./application-members.service.js";
import { ApplicationService } from "./application.service.js";

@Controller("applications")
@UseGuards(ApiKeyScopeGuard)
export class ApplicationController {
  constructor(
    @Inject(ApplicationService) private readonly applications: ApplicationService,
    @Inject(ApplicationMembersService) private readonly members: ApplicationMembersService,
  ) {}

  @Get()
  @RequireMachineScope("admin:read")
  list(@Req() request: FastifyRequest) {
    return this.applications.list(request);
  }

  @Post()
  @RequireMachineScope("admin:write")
  create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.applications.create(request, body);
  }

  @Get("manage")
  @RequireMachineScope("admin:read")
  listManaged(@Req() request: FastifyRequest) {
    return this.applications.listManaged(request);
  }

  @Patch("manage/:slug")
  @RequireMachineScope("admin:write")
  updateManaged(
    @Req() request: FastifyRequest,
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    return this.applications.update(request, slug, body);
  }

  @Get(":applicationSlug")
  @RequireMachineScope("admin:read")
  get(@Req() request: FastifyRequest, @Param("applicationSlug") slug: string) {
    return this.applications.get(request, slug);
  }

  @Get(":applicationSlug/capabilities")
  @RequireMachineScope("admin:read")
  capabilities(@Req() request: FastifyRequest, @Param("applicationSlug") slug: string) {
    return this.applications.capabilities(request, slug);
  }

  @Patch(":applicationSlug")
  @RequireMachineScope("admin:write")
  update(
    @Req() request: FastifyRequest,
    @Param("applicationSlug") slug: string,
    @Body() body: unknown,
  ) {
    return this.applications.update(request, slug, body);
  }

  @Post(":applicationSlug/archive")
  @RequireMachineScope("admin:write")
  archive(
    @Req() request: FastifyRequest,
    @Param("applicationSlug") slug: string,
    @Body() body: unknown,
  ) {
    return this.applications.archive(request, slug, body);
  }

  @Get(":applicationSlug/members")
  @RequireMachineScope("admin:read")
  listMembers(@Req() request: FastifyRequest, @Param("applicationSlug") slug: string) {
    return this.members.list(request, slug);
  }

  @Post(":applicationSlug/members")
  @RequireMachineScope("admin:write")
  addMember(
    @Req() request: FastifyRequest,
    @Param("applicationSlug") slug: string,
    @Body() body: unknown,
  ) {
    return this.members.create(request, slug, body);
  }

  @Patch(":applicationSlug/members/:userId")
  @RequireMachineScope("admin:write")
  updateMember(
    @Req() request: FastifyRequest,
    @Param("applicationSlug") slug: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.members.update(request, slug, userId, body);
  }

  @Delete(":applicationSlug/members/:userId")
  @RequireMachineScope("admin:write")
  removeMember(
    @Req() request: FastifyRequest,
    @Param("applicationSlug") slug: string,
    @Param("userId") userId: string,
  ) {
    return this.members.remove(request, slug, userId);
  }
}
