import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { ApiKeyScopeGuard, RequireMachineScope } from "../auth.js";
import { RuntimeSnapshotService } from "./snapshot.service.js";
import { RuntimeUserReservationService } from "./user-reservation.service.js";

@ApiTags("Runtime")
@ApiBearerAuth()
@Controller("runtime")
@UseGuards(ApiKeyScopeGuard)
export class RuntimeSnapshotController {
  public constructor(
    @Inject(RuntimeSnapshotService) private readonly snapshots: RuntimeSnapshotService,
  ) {}

  @Get("snapshot")
  @RequireMachineScope("runtime:read")
  @ApiOperation({ summary: "Fetch the current trusted runtime snapshot" })
  @ApiOkResponse({ description: "Current ETag-addressed runtime configuration" })
  @ApiNotModifiedResponse({ description: "The caller already has the current ETag" })
  public async snapshot(
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.snapshots.get(ifNoneMatch);
    void reply.header("etag", `"${result.snapshot.etag}"`);
    void reply.header("cache-control", "private, no-cache");
    if (result.notModified) {
      void reply.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return result.snapshot;
  }
}

@ApiTags("Runtime application users")
@ApiBearerAuth()
@Controller("runtime/users/aiu/reservations")
@UseGuards(ApiKeyScopeGuard)
export class RuntimeUserReservationsController {
  public constructor(
    @Inject(RuntimeUserReservationService)
    private readonly reservations: RuntimeUserReservationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireMachineScope("runtime:write")
  @ApiOperation({ summary: "Check an application user and reserve AIU before a model call" })
  public create(@Body() body: unknown) {
    return this.reservations.create(body);
  }

  @Post(":id/settle")
  @HttpCode(HttpStatus.OK)
  @RequireMachineScope("runtime:write")
  @ApiOperation({ summary: "Settle an application user's AIU reservation" })
  public settle(@Param("id") id: string, @Body() body: unknown) {
    return this.reservations.settle(id, body);
  }

  @Post(":id/release")
  @HttpCode(HttpStatus.OK)
  @RequireMachineScope("runtime:write")
  @ApiOperation({ summary: "Release an unused application user AIU reservation" })
  public release(@Param("id") id: string, @Body() body: unknown) {
    return this.reservations.release(id, body);
  }
}
