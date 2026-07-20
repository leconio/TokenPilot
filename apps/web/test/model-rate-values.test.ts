import { describe, expect, it } from "vitest";

import { editableRates, emptyEditableRates, rateRequestBody } from "../features/models/rate-values";

describe("model rate forms", () => {
  it("keeps only request, input, and output visible defaults while retaining every rate field", () => {
    expect(emptyEditableRates()).toMatchObject({
      request: "",
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
    expect(rateRequestBody(value, "cost")).toMatchObject({
      input_image: "0.01",
      input_video_second: "0.2",
      custom_units: [{ unit_key: "tool_call", unit_size: "100", rate: "1.5" }],
    });
  });

  it("never sends a request AIU rate", () => {
    const value = emptyEditableRates();
    value.request = "12";
    value.input_per_million = "1";
    const body = rateRequestBody(value, "aiu");
    expect(body).not.toHaveProperty("request");
    expect(body).toMatchObject({ input_per_million: "1", custom_units: [] });
  });
});
