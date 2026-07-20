import type { OperationContract } from "../types.js";
import {
  array,
  body,
  DATE_TIME,
  id,
  nullable,
  object,
  pathString,
  ref,
  success,
  UUID,
} from "../schema-helpers.js";

const application = () => pathString("applicationSlug", 120);
const model = object(["id", "name", "litellm_tag", "enabled", "created_at", "updated_at"], {
  id: UUID,
  name: { type: "string", minLength: 1, maxLength: 120 },
  litellm_tag: { type: "string", minLength: 1, maxLength: 256 },
  provider: nullable({ type: "string", maxLength: 120 }),
  capabilities: array({ type: "string" }),
  notes: nullable({ type: "string", maxLength: 2_000 }),
  enabled: { type: "boolean" },
  created_at: DATE_TIME,
  updated_at: DATE_TIME,
});
const modelInput = object(["name", "litellm_tag"], {
  name: { type: "string", minLength: 1, maxLength: 120 },
  litellm_tag: { type: "string", minLength: 1, maxLength: 256 },
  provider: nullable({ type: "string", maxLength: 120 }),
  capabilities: array({ type: "string" }),
  notes: nullable({ type: "string", maxLength: 2_000 }),
});
const virtualModel = object(["id", "name", "display_name", "enabled", "targets", "rules"], {
  id: UUID,
  name: { type: "string", minLength: 1, maxLength: 120 },
  display_name: { type: "string", minLength: 1, maxLength: 120 },
  description: nullable({ type: "string", maxLength: 2_000 }),
  default_model_id: nullable(UUID),
  enabled: { type: "boolean" },
  targets: array({ type: "object", additionalProperties: true }),
  rules: array({ type: "object", additionalProperties: true }),
});
const rates = object(["model", "cost", "aiu"], {
  model,
  cost: nullable({ type: "object", additionalProperties: true }),
  aiu: nullable({ type: "object", additionalProperties: true }),
});
const pricingInput = object([], {
  request: nullable({ type: "string" }),
  input_per_million: nullable({ type: "string" }),
  cache_read_per_million: nullable({ type: "string" }),
  cache_write_per_million: nullable({ type: "string" }),
  output_per_million: nullable({ type: "string" }),
  reasoning_per_million: nullable({ type: "string" }),
});

export const CATALOG_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /applications/{applicationSlug}/models": {
    parameters: [application()],
    success: success("200", object(["models"], { models: array(model) }), "Application models."),
  },
  "POST /applications/{applicationSlug}/models": {
    parameters: [application()],
    requestBody: body(modelInput),
    success: success("201", model, "Model created."),
  },
  "GET /applications/{applicationSlug}/models/{id}": {
    parameters: [application(), id("id")],
    success: success("200", model, "Application model."),
  },
  "PATCH /applications/{applicationSlug}/models/{id}": {
    parameters: [application(), id("id")],
    requestBody: body(modelInput),
    success: success("200", model, "Model updated."),
  },
  "GET /applications/{applicationSlug}/models/{id}/rates": {
    parameters: [application(), id("id")],
    success: success("200", rates, "Current model cost and AIU rates."),
  },
  "PUT /applications/{applicationSlug}/models/{id}/cost": {
    parameters: [application(), id("id")],
    requestBody: body(pricingInput),
    success: success("200", rates, "Model cost published."),
  },
  "PUT /applications/{applicationSlug}/models/{id}/aiu": {
    parameters: [application(), id("id")],
    requestBody: body(pricingInput),
    success: success("200", rates, "Model AIU rates published."),
  },
  "GET /applications/{applicationSlug}/virtual-models": {
    parameters: [application()],
    success: success(
      "200",
      object(["virtual_models"], { virtual_models: array(virtualModel) }),
      "Application virtual models.",
    ),
  },
  "POST /applications/{applicationSlug}/virtual-models": {
    parameters: [application()],
    requestBody: body(
      object(["name"], {
        name: { type: "string", minLength: 1, maxLength: 120 },
        display_name: { type: "string", minLength: 1, maxLength: 120 },
        default_model_id: nullable(UUID),
      }),
    ),
    success: success("201", virtualModel, "Virtual model created."),
  },
  "PATCH /applications/{applicationSlug}/virtual-models/{id}": {
    parameters: [application(), id("id")],
    requestBody: body({ type: "object", additionalProperties: true }),
    success: success("200", virtualModel, "Virtual model updated."),
  },
  "POST /applications/{applicationSlug}/virtual-models/{id}/routes": {
    parameters: [application(), id("id")],
    requestBody: body(object(["model_id"], { model_id: UUID })),
    success: success("201", virtualModel, "Virtual model route added."),
  },
  "POST /applications/{applicationSlug}/virtual-models/{id}/routes/reorder": {
    parameters: [application(), id("id")],
    requestBody: body(object(["ordered_target_ids"], { ordered_target_ids: array(UUID) })),
    success: success("201", virtualModel, "Virtual model routes reordered."),
  },
  "POST /applications/{applicationSlug}/virtual-models/{id}/rules": {
    parameters: [application(), id("id")],
    requestBody: body({ type: "object", additionalProperties: true }),
    success: success("201", virtualModel, "Routing condition added."),
  },
  "PATCH /applications/{applicationSlug}/virtual-models/{id}/rules/{ruleId}": {
    parameters: [application(), id("id"), id("ruleId")],
    requestBody: body({ type: "object", additionalProperties: true }),
    success: success("200", virtualModel, "Routing condition updated."),
  },
  "DELETE /applications/{applicationSlug}/virtual-models/{id}/rules/{ruleId}": {
    parameters: [application(), id("id"), id("ruleId")],
    success: success("200", virtualModel, "Routing condition removed."),
  },
  "POST /applications/{applicationSlug}/virtual-models/{id}/simulate": {
    parameters: [application(), id("id")],
    requestBody: body(object(["instant"], { instant: DATE_TIME })),
    success: success(
      "201",
      { type: "object", additionalProperties: true },
      "Routing simulation result.",
    ),
  },
  "GET /applications/{applicationSlug}/runtime-configurations": {
    parameters: [application()],
    success: success(
      "200",
      object(["versions"], {
        versions: array({ type: "object", additionalProperties: true }),
      }),
      "Published runtime configurations and application states.",
    ),
  },
  "POST /applications/{applicationSlug}/runtime-configurations/publish": {
    parameters: [application()],
    success: success(
      "201",
      { type: "object", additionalProperties: true },
      "Runtime configuration published.",
    ),
  },
  "POST /applications/{applicationSlug}/runtime-configurations/{version}/restore": {
    parameters: [
      application(),
      {
        name: "version",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      },
    ],
    success: success(
      "201",
      { type: "object", additionalProperties: true },
      "Historical routing restored as a new runtime configuration.",
    ),
  },
  "POST /runtime/configuration-acknowledgements": {
    requestBody: body(ref("RuntimeConfigurationAcknowledgementDto")),
    success: success(
      "202",
      object(["status", "duplicate"], {
        status: { type: "string", enum: ["accepted"] },
        duplicate: { type: "boolean" },
      }),
      "Runtime configuration acknowledgement accepted.",
    ),
  },
};
