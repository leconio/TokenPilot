import { HttpException, HttpStatus } from "@nestjs/common";

export class RateLimitExceededException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super("Request rate limit exceeded", HttpStatus.TOO_MANY_REQUESTS);
  }
}
