import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { WebAuthService } from "./web-auth.service.js";

@Controller("web")
export class WebAuthController {
  constructor(@Inject(WebAuthService) private readonly auth: WebAuthService) {}

  @Get("setup/status")
  setupStatus() {
    return this.auth.setupStatus();
  }

  @Post("setup/initialize")
  async initialize(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.auth.assertPreAuthOrigin(request.headers.origin, request.headers["sec-fetch-site"]);
    const initialized = await this.auth.initialize(body, request.ip, request.headers["user-agent"]);
    void reply.header(
      "set-cookie",
      this.auth.cookieHeaders(
        initialized.session.token,
        initialized.session.csrf,
        initialized.session.expiresAt,
      ),
    );
    return {
      initialized: initialized.initialized,
      user: initialized.user,
      application: initialized.application,
      access_key: initialized.access_key,
      expires_at: initialized.session.expiresAt.toISOString(),
      csrf_token: initialized.session.csrf,
    };
  }

  @Post("session/login")
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.auth.assertPreAuthOrigin(request.headers.origin, request.headers["sec-fetch-site"]);
    const result = await this.auth.login(body, request.ip, request.headers["user-agent"]);
    void reply.header(
      "set-cookie",
      this.auth.cookieHeaders(result.token, result.csrf, result.expiresAt),
    );
    return {
      user: result.identity,
      expires_at: result.expiresAt.toISOString(),
      csrf_token: result.csrf,
    };
  }

  @Get("session")
  async session(@Req() request: FastifyRequest) {
    const identity = await this.auth.authenticate(request.headers.cookie);
    if (identity === null) throw new UnauthorizedException("A web session is required");
    return { user: identity };
  }

  @Post("session/logout")
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const identity = await this.auth.authenticate(request.headers.cookie);
    if (identity === null) throw new UnauthorizedException("A web session is required");
    this.auth.assertCsrf(
      request.headers.cookie,
      request.headers["x-csrf-token"],
      request.headers.origin,
      request.headers["sec-fetch-site"],
    );
    await this.auth.logout(request.headers.cookie);
    void reply.header("set-cookie", this.auth.clearCookieHeaders());
    return { logged_out: true };
  }
}
