import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { LogController, type FastifyServerOptions } from "fastify";
import { ulid } from "ulid";

import { ApiErrorDto } from "@tokenpilot/contracts";

import { shouldSendStrictTransportSecurity, type ApiConfiguration } from "./api-config.js";
import { AuditContextService } from "./audit-context.js";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { ApiModule } from "./api.module.js";
import { installPrivacySafeJsonParser } from "./body-parser.js";
import { createApiInfrastructure, type ApiInfrastructure } from "./infrastructure.js";
import { ConnectorMetricsService } from "./metrics.controller.js";
import { completeOpenApiDocument } from "./openapi-contract.js";
import { redactLogArguments } from "./security.js";

export interface CreateApiApplicationOptions {
  readonly infrastructure?: ApiInfrastructure;
  readonly logger?: boolean;
}

function traceIdFromTraceparent(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined) return null;
  return /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}(?:-|$)/iu.exec(header)?.[1] ?? null;
}

export async function createApiApplication(
  configuration: ApiConfiguration,
  options: CreateApiApplicationOptions = {},
): Promise<NestFastifyApplication> {
  const logger = options.logger ?? false;
  const fastifyOptions: FastifyServerOptions = {
    bodyLimit: configuration.maxCompressedBytes,
    handlerTimeout: configuration.requestTimeoutMs,
    requestIdHeader: "x-request-id",
    logController: new LogController({
      requestIdLogLabel: "request_id",
      disableRequestLogging: true,
    }),
    genReqId: () => ulid(),
    logger: logger
      ? {
          level: configuration.logLevel,
          base: {
            component: "api",
            event: "api.process",
            event_id: null,
            job_id: null,
            trace_id: null,
            error_code: null,
            duration_ms: null,
          },
          messageKey: "message",
          formatters: { level: (label: string) => ({ level: label }) },
          timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
          hooks: {
            logMethod(arguments_, method) {
              method.apply(this, redactLogArguments(arguments_) as Parameters<typeof method>);
            },
          },
          redact: {
            paths: [
              "req.headers",
              "req.body",
              "request.headers",
              "request.body",
              "res.headers.set-cookie",
              "response.headers.set-cookie",
              "authorization",
              "cookie",
              "set-cookie",
              "password",
              "token",
              "secret",
              "*.authorization",
              "*.cookie",
              "*.password",
              "*.token",
              "*.secret",
              "*.*.authorization",
              "*.*.cookie",
              "*.*.password",
              "*.*.token",
              "*.*.secret",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
  };
  const adapter = new FastifyAdapter(fastifyOptions);
  const infrastructure = options.infrastructure ?? createApiInfrastructure(configuration);
  const application = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(configuration, infrastructure),
    adapter,
    { logger: false, bodyParser: false },
  );
  installPrivacySafeJsonParser(adapter.getInstance(), configuration);
  const metrics = application.get(ConnectorMetricsService);
  const auditContext = application.get(AuditContextService);
  const requestStarts = new WeakMap<object, bigint>();
  adapter.getInstance().addHook("onRequest", (request, _reply, done) => {
    auditContext.run(request.ip, () => {
      requestStarts.set(request, process.hrtime.bigint());
      request.log.info(
        {
          event: "http.request.started",
          trace_id: traceIdFromTraceparent(request.headers.traceparent),
          method: request.method,
          route: request.routeOptions.url ?? "unmatched",
        },
        "request started",
      );
      done();
    });
  });
  adapter.getInstance().addHook("onResponse", (request, reply, done) => {
    const started = requestStarts.get(request);
    if (started !== undefined) {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      metrics.observeHttp(
        request.method,
        request.routeOptions.url ?? "unmatched",
        reply.statusCode,
        durationMs / 1000,
      );
      request.log.info(
        {
          event: "http.request.completed",
          trace_id: traceIdFromTraceparent(request.headers.traceparent),
          error_code: reply.statusCode >= 400 ? `HTTP_${reply.statusCode}` : null,
          duration_ms: durationMs,
          method: request.method,
          route: request.routeOptions.url ?? "unmatched",
          status: reply.statusCode,
        },
        "request completed",
      );
    }
    done();
  });
  adapter.getInstance().addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("x-frame-options", "DENY");
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    void reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (shouldSendStrictTransportSecurity(configuration)) {
      void reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    done(null, payload);
  });
  application.useGlobalFilters(new ApiExceptionFilter());

  const swaggerConfiguration = new DocumentBuilder()
    .setTitle("TokenPilot API")
    .setVersion("0.2.0")
    .addBearerAuth()
    .addCookieAuth(
      "cp_session",
      {
        type: "apiKey",
        in: "cookie",
        name: "cp_session",
        description:
          "HttpOnly SameSite=Strict Web Console session cookie. Mutating Web session operations additionally require x-csrf-token.",
      },
      "webSession",
    )
    .build();
  const openApiDocument = completeOpenApiDocument(
    SwaggerModule.createDocument(application, swaggerConfiguration, {
      extraModels: [ApiErrorDto],
    }),
  );
  SwaggerModule.setup("openapi", application, openApiDocument);
  await application.init();
  await adapter.getInstance().ready();
  return application;
}
