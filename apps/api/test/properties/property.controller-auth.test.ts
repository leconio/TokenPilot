import { describe, expect, it } from "vitest";

import { PropertyController } from "../../src/properties/property.controller.js";

const REQUIRED_SCOPE = "required-machine-scope";

function requiredScope(method: "list" | "create" | "update"): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(PropertyController.prototype, method);
  if (descriptor?.value === undefined) throw new Error(`Missing ${method} controller method`);
  return Reflect.getMetadata(REQUIRED_SCOPE, descriptor.value);
}

describe("PropertyController authorization", () => {
  it("treats typed property definitions as application configuration", () => {
    expect(requiredScope("list")).toBe("configuration:read");
    expect(requiredScope("create")).toBe("configuration:write");
    expect(requiredScope("update")).toBe("configuration:write");
  });
});
