import { BadRequestException, ForbiddenException, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiExceptionFilter } from "../src/api-exception.filter.js";

function host() {
  const send = vi.fn();
  const reply = {
    header: vi.fn(),
    status: vi.fn().mockReturnValue({ send }),
  };
  const request = { id: "request-1", log: { warn: vi.fn() } };
  const value = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { host: value, send };
}

describe("ApiExceptionFilter business messages", () => {
  it("keeps an explicit Chinese business error for the Web error state", () => {
    const value = host();
    new ApiExceptionFilter().catch(
      new BadRequestException("字段 plan 已停用或不可用于报表"),
      value.host,
    );

    expect(value.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "字段 plan 已停用或不可用于报表" }),
    );
  });

  it("does not expose an untrusted English diagnostic", () => {
    const value = host();
    new ApiExceptionFilter().catch(
      new BadRequestException("ClickHouse query contains secret details"),
      value.host,
    );

    expect(value.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The request is invalid." }),
    );
  });

  it("keeps a controlled English business error for bilingual clients", () => {
    const value = host();
    new ApiExceptionFilter().catch(
      new BadRequestException("Field plan is not available for search"),
      value.host,
    );

    expect(value.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Field plan is not available for search" }),
    );
  });

  it("keeps authentication and authorization failures generic", () => {
    const value = host();
    new ApiExceptionFilter().catch(
      new ForbiddenException("The application secret is missing an admin scope"),
      value.host,
    );

    expect(value.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The credential does not permit this operation." }),
    );
  });
});
