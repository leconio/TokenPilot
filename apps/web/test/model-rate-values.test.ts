import { describe, expect, it } from "vitest";

import { editableRates, emptyEditableRates, rateRequestBody } from "../features/models/rate-values";

describe("model rate forms", () => {
  it("keeps every AIU usage field available", () => {
    expect(emptyEditableRates()).toMatchObject({
      input_per_million: "",
      output_per_million: "",
      input_image: "",
      output_audio_second: "",
      embedding_per_million: "",
      custom_units: [],
    });
  });

  it("round-trips multimodal and custom-unit rates without losing unit sizes", () => {
    const value = editableRates({
      input_image: "0.01",
      input_video_second: "0.2",
      custom_units: [{ unit_key: "tool_call", unit_size: "100", rate: "1.5" }],
    });
    expect(rateRequestBody(value)).toMatchObject({
      input_image: "0.01",
      input_video_second: "0.2",
      custom_units: [{ unit_key: "tool_call", unit_size: "100", rate: "1.5" }],
    });
  });

  it("serializes only AIU fields", () => {
    const value = emptyEditableRates();
    value.input_per_million = "1";
    const body = rateRequestBody(value);
    expect(body).not.toHaveProperty("request");
    expect(body).toMatchObject({ input_per_million: "1", custom_units: [] });
  });
});
