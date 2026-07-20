import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { HeartbeatController } from "../src/heartbeat.controller.js";
import { UsageController } from "../src/usage.controller.js";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function methodMetadata(controller: object, method: string, metadata: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(controller), method);
  if (descriptor?.value === undefined) throw new Error(`Missing ${method} controller method`);
  return Reflect.getMetadata(metadata, descriptor.value);
}

describe("canonical machine ingress routes", () => {
  it("exposes only the unversioned usage batch endpoint", () => {
    const controller = new UsageController(
      { ingest: () => undefined } as never,
      { recordIngestion: () => undefined } as never,
      { current: () => ({ applicationId: "application" }) } as never,
    );
    expect(Reflect.getMetadata(PATH_METADATA, UsageController)).toBe("usage-events");
    expect(methodMetadata(controller, "ingestBatch", PATH_METADATA)).toBe("batch");
    expect(methodMetadata(controller, "ingestBatch", METHOD_METADATA)).toBe(RequestMethod.POST);
  });

  it("exposes only the unversioned connector heartbeat endpoint", () => {
    const controller = new HeartbeatController({ record: () => undefined } as never);
    expect(Reflect.getMetadata(PATH_METADATA, HeartbeatController)).toBe("connectors");
    expect(methodMetadata(controller, "record", PATH_METADATA)).toBe("heartbeat");
    expect(methodMetadata(controller, "record", METHOD_METADATA)).toBe(RequestMethod.POST);
  });
});
