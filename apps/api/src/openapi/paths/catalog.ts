import type { OperationContract } from "../types.js";
import {
  array,
  body,
  DATE_TIME,
  id,
  nullable,
  object,
  pathString,
  query,
  ref,
  success,
  UUID,
} from "../schema-helpers.js";

const application = () => pathString("applicationSlug", 120);
const connectionSummary = object(["id", "name", "driver", "enabled", "status"], {
  id: UUID,
  name: { type: "string", minLength: 1, maxLength: 120 },
  driver: { type: "string", enum: ["litellm", "openai_compatible", "anthropic"] },
  enabled: { type: "boolean" },
  status: { type: "string", enum: ["unverified", "available", "degraded", "offline"] },
});
const publicConnectionConfig = object([], {
  timeout_ms: { type: "integer", minimum: 1, maximum: 600_000 },
  max_retries: { type: "integer", minimum: 0, maximum: 10 },
  api_version: { type: "string", minLength: 1, maxLength: 64 },
});
const connection = object(
  [
    "id",
    "name",
    "driver",
    "base_url",
    "credential_ref",
    "public_config",
    "enabled",
    "status",
    "model_count",
    "created_at",
    "updated_at",
  ],
  {
    ...connectionSummary.properties,
    base_url: nullable({ type: "string", format: "uri", maxLength: 2_048 }),
    credential_ref: nullable({ type: "string", minLength: 1, maxLength: 256 }),
    public_config: publicConnectionConfig,
    connector_instance: nullable({ type: "object", additionalProperties: true }),
    last_seen_at: nullable(DATE_TIME),
    model_count: { type: "integer", minimum: 0 },
    created_at: DATE_TIME,
    updated_at: DATE_TIME,
  },
);
const connectionInputProperties = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  driver: { type: "string", enum: ["litellm", "openai_compatible", "anthropic"] },
  base_url: nullable({ type: "string", format: "uri", maxLength: 2_048 }),
  credential_ref: nullable({ type: "string", minLength: 1, maxLength: 256 }),
  public_config: publicConnectionConfig,
  connector_instance_id: nullable(UUID),
} as const;
const model = object(
  [
    "id",
    "name",
    "connection",
    "request_model",
    "provider",
    "task_type",
    "capabilities",
    "enabled",
    "created_at",
    "updated_at",
  ],
  {
    id: UUID,
    name: { type: "string", minLength: 1, maxLength: 120 },
    connection: connectionSummary,
    request_model: { type: "string", minLength: 1, maxLength: 256 },
    provider: { type: "string", minLength: 1, maxLength: 120 },
    task_type: { type: "string", enum: ["chat", "embedding", "image", "audio"] },
    capabilities: array({ type: "string" }),
    notes: nullable({ type: "string", maxLength: 2_000 }),
    enabled: { type: "boolean" },
    created_at: DATE_TIME,
    updated_at: DATE_TIME,
  },
);
const modelInputProperties = {
  name: { type: "string", minLength: 1, maxLength: 120 },
  connection_id: UUID,
  request_model: { type: "string", minLength: 1, maxLength: 256 },
  provider: { type: "string", minLength: 1, maxLength: 120 },
  task_type: { type: "string", enum: ["chat", "embedding", "image", "audio"] },
  capabilities: array({ type: "string" }),
  notes: nullable({ type: "string", maxLength: 2_000 }),
} as const;
const modelInput = object(
  ["name", "connection_id", "request_model", "provider", "task_type"],
  modelInputProperties,
);
const virtualModel = object(
  ["id", "name", "display_name", "task_type", "enabled", "targets", "rules"],
  {
    id: UUID,
    name: { type: "string", minLength: 1, maxLength: 120 },
    display_name: { type: "string", minLength: 1, maxLength: 120 },
    task_type: { type: "string", enum: ["chat", "embedding", "image", "audio"] },
    description: nullable({ type: "string", maxLength: 2_000 }),
    default_model_id: nullable(UUID),
    enabled: { type: "boolean" },
    targets: array({ type: "object", additionalProperties: true }),
    rules: array({ type: "object", additionalProperties: true }),
  },
);
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
  "GET /applications/{applicationSlug}/connections": {
    parameters: [application()],
    success: success(
      "200",
      object(["connections"], { connections: array(connection) }),
      "Application call connections.",
    ),
  },
  "POST /applications/{applicationSlug}/connections": {
    parameters: [application()],
    requestBody: body(object(["name", "driver"], connectionInputProperties)),
    success: success("201", connection, "Call connection created."),
  },
  "GET /applications/{applicationSlug}/connections/{id}": {
    parameters: [application(), id("id")],
    success: success("200", connection, "Application call connection."),
  },
  "PATCH /applications/{applicationSlug}/connections/{id}": {
    parameters: [application(), id("id")],
    requestBody: body(object([], { ...connectionInputProperties, enabled: { type: "boolean" } })),
    success: success("200", connection, "Call connection updated."),
  },
  "DELETE /applications/{applicationSlug}/connections/{id}": {
    parameters: [application(), id("id")],
    success: success(
      "200",
      object(["deleted"], { deleted: { type: "boolean", enum: [true] } }),
      "Call connection deleted.",
    ),
  },
  "POST /applications/{applicationSlug}/connections/{id}/check": {
    parameters: [application(), id("id")],
    success: success(
      "201",
      object(["valid", "status", "message"], {
        valid: { type: "boolean" },
        status: { type: "string", enum: ["unverified", "available", "degraded", "offline"] },
        message: { type: "string", minLength: 1, maxLength: 500 },
      }),
      "Connection settings checked without receiving provider credentials.",
    ),
  },
  "GET /applications/{applicationSlug}/models": {
    parameters: [
      application(),
      query("provider", { type: "string", minLength: 1, maxLength: 120 }),
      query("connection_id", UUID),
      query("task_type", { type: "string", enum: ["chat", "embedding", "image", "audio"] }),
      query("enabled", { type: "string", enum: ["true", "false"] }),
      query("cursor", UUID),
      query("limit", { type: "integer", minimum: 1, maximum: 100 }),
    ],
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
    requestBody: body(object([], { ...modelInputProperties, enabled: { type: "boolean" } })),
    success: success("200", model, "Model updated."),
  },
  "DELETE /applications/{applicationSlug}/models/{id}": {
    parameters: [application(), id("id")],
    success: success(
      "200",
      object(["deleted"], { deleted: { type: "boolean", enum: [true] } }),
      "Model deleted after reference checks.",
    ),
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
  "GET /applications/{applicationSlug}/virtual-models/{id}": {
    parameters: [application(), id("id")],
    success: success("200", virtualModel, "Virtual model and its route configuration."),
  },
  "PATCH /applications/{applicationSlug}/virtual-models/{id}": {
    parameters: [application(), id("id")],
    requestBody: body({ type: "object", additionalProperties: true }),
    success: success("200", virtualModel, "Virtual model updated."),
  },
  "DELETE /applications/{applicationSlug}/virtual-models/{id}": {
    parameters: [application(), id("id")],
    success: success(
      "200",
      object(["deleted"], { deleted: { type: "boolean", enum: [true] } }),
      "Virtual model deleted.",
    ),
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
  "PATCH /applications/{applicationSlug}/virtual-models/{id}/routes/{targetId}": {
    parameters: [application(), id("id"), id("targetId")],
    requestBody: body(object(["weight"], { weight: { type: "number", exclusiveMinimum: 0 } })),
    success: success("200", virtualModel, "Route weight updated."),
  },
  "DELETE /applications/{applicationSlug}/virtual-models/{id}/routes/{targetId}": {
    parameters: [application(), id("id"), id("targetId")],
    success: success("200", virtualModel, "Route target removed."),
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
