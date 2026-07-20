import { describe, expect, it } from "vitest";

import {
  comboboxCommandFilter,
  comboboxCustomValue,
  type ComboboxOption,
} from "../components/ui/combobox-utils";

const options: readonly ComboboxOption[] = [
  { value: "subject_demo_1", label: "演示用户", keywords: "customer-42" },
  { value: "subject_disabled", label: "停用用户", disabled: true },
];

describe("shadcn combobox matching", () => {
  it("searches display labels, values, and additional keywords", () => {
    expect(comboboxCommandFilter(options[0]!.value, "演示", [options[0]!.label])).toBe(1);
    expect(comboboxCommandFilter(options[0]!.value, "SUBJECT_DEMO", [])).toBe(1);
    expect(comboboxCommandFilter(options[0]!.value, "customer-42", [options[0]!.keywords!])).toBe(
      1,
    );
    expect(comboboxCommandFilter(options[0]!.value, "没有", [options[0]!.label])).toBe(0);
  });

  it("offers a trimmed custom value without duplicating an existing label or value", () => {
    expect(comboboxCustomValue("  新功能  ", options, true)).toBe("新功能");
    expect(comboboxCustomValue("演示用户", options, true)).toBeUndefined();
    expect(comboboxCustomValue("SUBJECT_DEMO_1", options, true)).toBeUndefined();
    expect(comboboxCustomValue("新功能", options, false)).toBeUndefined();
    expect(comboboxCustomValue("   ", options, true)).toBeUndefined();
  });
});
