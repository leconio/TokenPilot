import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";

import { apiErrorSchema, type ApiError } from "@tokenpilot/contracts";

import { RateLimitExceededException } from "./rate-limit.js";

interface StatusError extends Error {
  readonly statusCode?: number;
}

const errorCodes: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  408: "REQUEST_TIMEOUT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
  504: "REQUEST_TIMEOUT",
};

const safeMessages: Readonly<Record<number, string>> = {
  400: "The request is invalid.",
  401: "Authentication is required.",
  403: "The credential does not permit this operation.",
  404: "The requested resource was not found.",
  408: "The request timed out.",
  413: "The request body exceeds the configured limit.",
  415: "The request encoding or media type is not supported.",
  429: "The request rate limit was exceeded.",
  500: "An internal error occurred.",
  503: "A required service is temporarily unavailable.",
  504: "The request timed out.",
};

const unsafeDiagnosticPattern =
  /(?:clickhouse|postgres(?:ql)?|prisma|redis|stack\s*trace|secret|password|authorization\s*header|select\s+.+\s+from|insert\s+into|update\s+.+\s+set|delete\s+from)/iu;

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = this.status(exception);
    const code = errorCodes[status] ?? "HTTP_ERROR";
    const response: ApiError = {
      schema_version: "2.0",
      error_id: ulid(),
      occurred_at: new Date().toISOString(),
      request_id: request.id,
      code,
      message: this.safeMessage(exception, status),
      retryable: status === 429 || status === 503 || status === 504,
      details: [],
    };
    request.log.warn(
      {
        event: "http.request.rejected",
        error_code: code,
        status,
        error_type: this.errorType(exception),
      },
      "request rejected",
    );
    if (status === 429) {
      reply.header(
        "Retry-After",
        String(exception instanceof RateLimitExceededException ? exception.retryAfterSeconds : 60),
      );
    }
    void reply.status(status).send(apiErrorSchema.parse(response));
  }

  private status(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception instanceof Error) {
      const status = (exception as StatusError).statusCode;
      if (status !== undefined && status >= 400 && status <= 599) return status;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private errorType(exception: unknown): string {
    return exception instanceof Error ? exception.name : "UnknownError";
  }

  private safeMessage(exception: unknown, status: number): string {
    if (
      exception instanceof HttpException &&
      status !== HttpStatus.UNAUTHORIZED &&
      status !== HttpStatus.FORBIDDEN &&
      status !== HttpStatus.INTERNAL_SERVER_ERROR
    ) {
      const message = exception.message.trim();
      if (
        message.length > 0 &&
        message.length <= 500 &&
        !hasUnsafeControlCharacter(message) &&
        !unsafeDiagnosticPattern.test(message)
      ) {
        return message;
      }
    }
    return safeMessages[status] ?? "The request failed.";
  }
}
