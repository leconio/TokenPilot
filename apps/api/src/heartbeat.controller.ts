import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from "@nestjs/swagger";

import { ConnectorHeartbeatDto } from "@tokenpilot/contracts";

import { ApiKeyScopeGuard, RequireMachineScope } from "./auth.js";
import { HeartbeatService, type HeartbeatRequestHeaders } from "./heartbeat.service.js";

@ApiTags("Connectors")
@ApiBearerAuth()
@Controller("connectors")
@UseGuards(ApiKeyScopeGuard)
export class HeartbeatController {
  constructor(@Inject(HeartbeatService) private readonly heartbeat: HeartbeatService) {}

  @Post("heartbeat")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireMachineScope("connector:heartbeat")
  @ApiBody({ type: ConnectorHeartbeatDto })
  @ApiHeader({
    name: "X-TokenPilot-Usage-Schemas",
    required: false,
    schema: { type: "string", enum: ["2.0"] },
  })
  @ApiHeader({
    name: "X-TokenPilot-Trusted-Context",
    required: false,
    schema: { type: "string", enum: ["signed-http-context"] },
  })
  @ApiHeader({
    name: "X-TokenPilot-Privacy-Mode",
    required: false,
    schema: { type: "string", enum: ["content-free"] },
  })
  @ApiAcceptedResponse({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "heartbeat_id", "received_at", "snapshot_updated"],
      properties: {
        status: { type: "string", enum: ["accepted", "duplicate"] },
        heartbeat_id: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
        received_at: { type: "string", format: "date-time" },
        snapshot_updated: { type: "boolean" },
      },
      example: {
        status: "accepted",
        heartbeat_id: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
        received_at: "2026-07-16T08:00:00.000Z",
        snapshot_updated: true,
      },
    },
  })
  record(@Body() body: unknown, @Headers() headers: HeartbeatRequestHeaders) {
    return this.heartbeat.record(body, headers);
  }
}
