import { describe, expect, it } from "vitest";

import { hasCapability, isCapabilityVisible } from "../lib/capabilities.js";

describe("console capability visibility", () => {
  it("keeps core navigation visible without a page capability", () => {
    expect(isCapabilityVisible(undefined, { capabilities: [] })).toBe(true);
  });

  it("hides capability navigation instead of rendering a disabled control", () => {
    expect(isCapabilityVisible("aiu", { capabilities: ["usage"] })).toBe(false);
    expect(isCapabilityVisible("aiu", { capabilities: ["aiu"] })).toBe(true);
  });

  it("uses only the dedicated endpoint's enabled capability list", () => {
    expect(hasCapability(undefined, "quota")).toBe(false);
    expect(hasCapability({ capabilities: [], feature_flags: { aiu: true } }, "aiu")).toBe(false);
    expect(hasCapability({ capabilities: ["quota"] }, "quota")).toBe(true);
  });
});
