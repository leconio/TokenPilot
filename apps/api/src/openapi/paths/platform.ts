import type { OperationContract } from "../types.js";
import {
  array,
  body,
  CURRENCY,
  DATE_TIME,
  JSON_VALUE,
  NONNEGATIVE_DECIMAL,
  NULLABLE_STRING,
  nullable,
  object,
  pathString,
  query,
  success,
  UUID,
} from "../schema-helpers.js";
import { APPLICATION_CAPABILITIES, APPLICATION_FEATURE_FLAGS } from "../schemas/platform.js";

const applicationSlug = () => pathString("applicationSlug", 120);
const permission = { type: "string", pattern: "^[a-z]+:[a-z]+$" } as const;
const role = { type: "string", enum: ["owner", "admin", "analyst", "viewer"] } as const;
const application = object(
  [
    "id",
    "name",
    "slug",
    "status",
    "timezone",
    "base_currency",
    "archived_at",
    "role",
    "permissions",
  ],
  {
    id: UUID,
    name: { type: "string", minLength: 1, maxLength: 120 },
    slug: { type: "string", minLength: 1, maxLength: 120 },
    status: { type: "string", enum: ["active", "disabled"] },
    timezone: { type: "string", minLength: 1, maxLength: 128 },
    base_currency: CURRENCY,
    archived_at: nullable(DATE_TIME),
    role,
    permissions: array(permission),
    member_count: { type: "integer", minimum: 0 },
  },
);
const member = object(["user_id", "name", "email", "role", "permissions", "created_at"], {
  user_id: { type: "string", minLength: 1 },
  name: { type: "string", minLength: 1 },
  email: { type: "string", format: "email" },
  role,
  permissions: array(permission),
  created_at: DATE_TIME,
});
const applicationChanges = object([], {
  name: { type: "string", minLength: 1, maxLength: 120 },
  timezone: { type: "string", minLength: 1, maxLength: 128 },
  base_currency: CURRENCY,
  status: { type: "string", enum: ["active", "disabled"] },
});

export const PLATFORM_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /applications": {
    success: success(
      "200",
      object(["applications"], { applications: array(application) }),
      "Applications available to the signed-in user.",
    ),
  },
  "POST /applications": {
    requestBody: body(object(["name"], { name: { type: "string", minLength: 1, maxLength: 120 } })),
    success: success("201", application, "Application created."),
  },
  "GET /applications/{applicationSlug}": {
    parameters: [applicationSlug()],
    success: success("200", application, "Application details."),
  },
  "PATCH /applications/{applicationSlug}": {
    parameters: [applicationSlug()],
    requestBody: body(applicationChanges),
    success: success("200", application, "Application updated."),
  },
  "GET /applications/manage": {
    success: success(
      "200",
      object(["applications"], { applications: array(application) }),
      "Active, disabled, and archived applications available to the signed-in user.",
    ),
  },
  "PATCH /applications/manage/{slug}": {
    parameters: [pathString("slug", 120)],
    requestBody: body(applicationChanges),
    success: success("200", application, "Active or disabled application updated."),
  },
  "POST /applications/{applicationSlug}/archive": {
    parameters: [applicationSlug()],
    requestBody: body(
      object(["confirmation_name", "reason"], {
        confirmation_name: { type: "string", minLength: 1, maxLength: 120 },
        reason: { type: "string", minLength: 5, maxLength: 500 },
      }),
    ),
    success: success(
      "201",
      object(["archived", "status", "historical_data_retained"], {
        archived: { type: "boolean", enum: [true] },
        status: { type: "string", enum: ["disabled"] },
        historical_data_retained: { type: "boolean", enum: [true] },
      }),
      "Application archived while all historical data and audit evidence are retained.",
    ),
  },
  "GET /applications/{applicationSlug}/members": {
    parameters: [applicationSlug()],
    success: success(
      "200",
      object(["members"], { members: array(member) }),
      "Application members visible to the signed-in member.",
    ),
  },
  "POST /applications/{applicationSlug}/members": {
    parameters: [applicationSlug()],
    requestBody: body(
      object(["email"], {
        email: { type: "string", format: "email", maxLength: 320 },
        role,
        permissions: array(permission),
      }),
    ),
    success: success("201", member, "Application member added by an owner."),
  },
  "PATCH /applications/{applicationSlug}/members/{userId}": {
    parameters: [applicationSlug(), pathString("userId")],
    requestBody: body(object([], { role, permissions: array(permission) })),
    success: success("200", member, "Application member role and permissions updated."),
  },
  "DELETE /applications/{applicationSlug}/members/{userId}": {
    parameters: [applicationSlug(), pathString("userId")],
    success: success(
      "200",
      object(["removed"], { removed: { type: "boolean", enum: [true] } }),
      "Application member removed while audit evidence is retained.",
    ),
  },
  "GET /applications/{applicationSlug}/capabilities": {
    parameters: [applicationSlug()],
    success: success(
      "200",
      object(["feature_flags", "capabilities", "permissions"], {
        feature_flags: APPLICATION_FEATURE_FLAGS,
        capabilities: APPLICATION_CAPABILITIES,
        permissions: array(permission),
      }),
      "Application features and signed-in user permissions.",
    ),
  },
  "GET /applications/{applicationSlug}/connectors": {
    parameters: [applicationSlug()],
    success: success(
      "200",
      object(["connectors"], {
        connectors: array(
          object(
            [
              "id",
              "instance_id",
              "name",
              "type",
              "version",
              "status",
              "last_heartbeat_at",
              "buffer_depth",
              "oldest_event_age_seconds",
              "metadata",
            ],
            {
              id: UUID,
              instance_id: { type: "string" },
              name: { type: "string" },
              type: { type: "string" },
              version: { type: "string" },
              status: { type: "string" },
              last_heartbeat_at: DATE_TIME,
              buffer_depth: { type: "integer", minimum: 0 },
              oldest_event_age_seconds: nullable(NONNEGATIVE_DECIMAL),
              metadata: { type: "object", additionalProperties: true },
            },
          ),
        ),
      }),
      "Application connector health.",
    ),
  },
  "GET /applications/{applicationSlug}/audit": {
    parameters: [
      applicationSlug(),
      query("action", { type: "string", minLength: 1, maxLength: 120 }),
      query("limit", { type: "integer", minimum: 1, maximum: 200 }),
    ],
    success: success(
      "200",
      object(["entries"], {
        entries: array(
          object(
            [
              "id",
              "actor_id",
              "action",
              "object_type",
              "object_id",
              "before",
              "after",
              "reason",
              "created_at",
            ],
            {
              id: UUID,
              actor_id: NULLABLE_STRING,
              action: { type: "string" },
              object_type: { type: "string" },
              object_id: { type: "string" },
              before: JSON_VALUE,
              after: JSON_VALUE,
              reason: NULLABLE_STRING,
              created_at: DATE_TIME,
            },
          ),
        ),
      }),
      "Application audit entries.",
    ),
  },
  "GET /applications/{applicationSlug}/settings": {
    parameters: [applicationSlug()],
    success: success(
      "200",
      object(
        [
          "app_name",
          "instance_id",
          "timezone",
          "base_currency",
          "raw_event_retention_days",
          "privacy",
          "service_key_count",
          "active_web_sessions",
        ],
        {
          app_name: { type: "string", minLength: 1, maxLength: 120 },
          instance_id: { type: "string" },
          timezone: { type: "string" },
          base_currency: CURRENCY,
          raw_event_retention_days: { type: "integer", minimum: 0 },
          privacy: object(["store_prompt_content", "store_response_content"], {
            store_prompt_content: { type: "boolean", enum: [false] },
            store_response_content: { type: "boolean", enum: [false] },
          }),
          service_key_count: { type: "integer", minimum: 0 },
          active_web_sessions: { type: "integer", minimum: 0 },
        },
      ),
      "Application settings without secrets.",
    ),
  },
};
