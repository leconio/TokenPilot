import type { OpenApiSchema, OperationContract } from "../types.js";
import {
  array,
  body,
  DATE_TIME,
  id,
  nullable,
  object,
  pathString,
  query,
  success,
  UUID,
} from "../schema-helpers.js";

const application = () => pathString("applicationSlug", 120);
const integerString: OpenApiSchema = { type: "string", pattern: "^-?(?:0|[1-9][0-9]*)$" };
const nonnegativeIntegerString: OpenApiSchema = {
  type: "string",
  pattern: "^(?:0|[1-9][0-9]*)$",
};
const propertyValue: OpenApiSchema = {
  oneOf: [
    { type: "string", maxLength: 2_048 },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: { type: "string", maxLength: 256 } },
  ],
};
const quota = object(
  [
    "limit_aiu_micros",
    "used_aiu_micros",
    "reserved_aiu_micros",
    "remaining_aiu_micros",
    "hard_limit",
    "period",
    "period_start",
    "period_end",
  ],
  {
    limit_aiu_micros: nonnegativeIntegerString,
    used_aiu_micros: nonnegativeIntegerString,
    reserved_aiu_micros: nonnegativeIntegerString,
    remaining_aiu_micros: integerString,
    hard_limit: { type: "boolean" },
    period: { type: "string", enum: ["day", "week", "month", "fixed", "lifetime"] },
    period_start: nullable(DATE_TIME),
    period_end: nullable(DATE_TIME),
  },
);
const applicationUser = object(
  [
    "id",
    "user_id",
    "display_user",
    "tags",
    "properties",
    "status",
    "blocked_reason",
    "first_seen_at",
    "last_seen_at",
    "usage",
    "quota",
  ],
  {
    id: UUID,
    user_id: { type: "string", minLength: 1, maxLength: 256 },
    display_user: nullable({ type: "string", minLength: 1, maxLength: 256 }),
    tags: array({ type: "string", minLength: 1, maxLength: 64 }),
    properties: { type: "object", additionalProperties: propertyValue },
    status: { type: "string", enum: ["active", "blocked"] },
    blocked_reason: nullable({ type: "string", maxLength: 500 }),
    first_seen_at: DATE_TIME,
    last_seen_at: DATE_TIME,
    usage: object(["calls", "tokens", "aiu_micros"], {
      calls: { type: "integer", minimum: 0 },
      tokens: nonnegativeIntegerString,
      aiu_micros: nonnegativeIntegerString,
    }),
    quota,
  },
);
const quotaPolicy = object(
  [
    "id",
    "scope",
    "user_id",
    "user_group_id",
    "subject_name",
    "limit_aiu_micros",
    "hard_limit",
    "period",
    "starts_at",
    "ends_at",
    "priority",
    "enabled",
    "updated_at",
  ],
  {
    id: UUID,
    scope: { type: "string", enum: ["application", "user_group", "user"] },
    user_id: nullable(UUID),
    user_group_id: nullable(UUID),
    subject_name: nullable({ type: "string", maxLength: 256 }),
    limit_aiu_micros: nonnegativeIntegerString,
    hard_limit: { type: "boolean" },
    period: { type: "string", enum: ["day", "week", "month", "fixed", "lifetime"] },
    starts_at: nullable(DATE_TIME),
    ends_at: nullable(DATE_TIME),
    priority: { type: "integer", minimum: 0, maximum: 10_000 },
    enabled: { type: "boolean" },
    updated_at: DATE_TIME,
  },
);
const quotaPolicyInput = object(["limit"], {
  limit: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$" },
  hard_limit: { type: "boolean" },
  period: { type: "string", enum: ["day", "week", "month", "fixed", "lifetime"] },
  starts_at: DATE_TIME,
  ends_at: DATE_TIME,
  priority: { type: "integer", minimum: 0, maximum: 10_000 },
  reason: { type: "string", minLength: 1, maxLength: 500 },
});
const disableQuotaPolicyInput = object([], {
  reason: { type: "string", minLength: 1, maxLength: 500 },
});

export const USER_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /applications/{applicationSlug}/quota-policies": {
    parameters: [application()],
    success: success(
      "200",
      object(["policies"], { policies: array(quotaPolicy) }),
      "Application, user-group, and user AIU quota rules.",
    ),
  },
  "PUT /applications/{applicationSlug}/quota-policies/application": {
    parameters: [application()],
    requestBody: body(quotaPolicyInput),
    success: success("200", quotaPolicy, "Application default AIU quota rule saved."),
  },
  "DELETE /applications/{applicationSlug}/quota-policies/application": {
    parameters: [application()],
    requestBody: body(disableQuotaPolicyInput),
    success: success("200", quotaPolicy, "Application default AIU quota rule disabled."),
  },
  "PUT /applications/{applicationSlug}/quota-policies/user-groups/{groupId}": {
    parameters: [application(), id("groupId")],
    requestBody: body(quotaPolicyInput),
    success: success("200", quotaPolicy, "User-group AIU quota rule saved."),
  },
  "DELETE /applications/{applicationSlug}/quota-policies/user-groups/{groupId}": {
    parameters: [application(), id("groupId")],
    requestBody: body(disableQuotaPolicyInput),
    success: success("200", quotaPolicy, "User-group AIU quota rule disabled."),
  },
  "GET /applications/{applicationSlug}/users": {
    parameters: [
      application(),
      query("page", { type: "integer", minimum: 1 }),
      query("limit", { type: "integer", minimum: 1, maximum: 200 }),
      query("search", { type: "string", maxLength: 256 }),
      query("status", { type: "string", enum: ["active", "blocked"] }),
      query("tag", { type: "string", minLength: 1, maxLength: 64 }),
      query("group_id", UUID),
    ],
    success: success(
      "200",
      object(["users", "page", "page_size", "total"], {
        users: array(applicationUser),
        page: { type: "integer", minimum: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 200 },
        total: { type: "integer", minimum: 0 },
      }),
      "Users reported by this application or added by an administrator.",
    ),
  },
  "POST /applications/{applicationSlug}/users": {
    parameters: [application()],
    requestBody: body(
      object(["user_id"], {
        user_id: { type: "string", minLength: 1, maxLength: 256 },
        display_user: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Recommended human-readable user name.",
        },
        tags: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string" } },
        properties: { type: "object", additionalProperties: propertyValue },
      }),
    ),
    success: success("201", applicationUser, "Application user created."),
  },
  "GET /applications/{applicationSlug}/users/summary": {
    parameters: [application()],
    success: success(
      "200",
      object(
        [
          "total_users",
          "blocked_users",
          "limit_aiu_micros",
          "used_aiu_micros",
          "reserved_aiu_micros",
          "remaining_aiu_micros",
        ],
        {
          total_users: { type: "integer", minimum: 0 },
          blocked_users: { type: "integer", minimum: 0 },
          limit_aiu_micros: nonnegativeIntegerString,
          used_aiu_micros: nonnegativeIntegerString,
          reserved_aiu_micros: nonnegativeIntegerString,
          remaining_aiu_micros: integerString,
        },
      ),
      "Application user and AIU quota totals.",
    ),
  },
  "GET /applications/{applicationSlug}/users/{id}": {
    parameters: [application(), id("id")],
    success: success("200", applicationUser, "Application user."),
  },
  "PATCH /applications/{applicationSlug}/users/{id}": {
    parameters: [application(), id("id")],
    requestBody: body(
      object([], {
        display_user: nullable({ type: "string", minLength: 1, maxLength: 256 }),
        tags: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string" } },
        blocked: { type: "boolean" },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      }),
    ),
    success: success("200", applicationUser, "Application user updated."),
  },
  "PUT /applications/{applicationSlug}/users/{id}/quota": {
    parameters: [application(), id("id")],
    requestBody: body(
      object(["limit"], {
        limit: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,6})?$" },
        hard_limit: { type: "boolean" },
        period: { type: "string", enum: ["day", "week", "month", "fixed", "lifetime"] },
        starts_at: DATE_TIME,
        ends_at: DATE_TIME,
      }),
    ),
    success: success("200", applicationUser, "Application user AIU quota saved."),
  },
  "POST /applications/{applicationSlug}/users/{id}/quota/reset": {
    parameters: [application(), id("id")],
    requestBody: body(
      object(["reason"], { reason: { type: "string", minLength: 1, maxLength: 500 } }),
    ),
    success: success("201", applicationUser, "Application user AIU usage reset."),
  },
  "GET /applications/{applicationSlug}/users/{id}/aiu-ledger": {
    parameters: [
      application(),
      id("id"),
      query("limit", { type: "integer", minimum: 1, maximum: 200 }),
    ],
    success: success(
      "200",
      object(["entries"], { entries: array({ type: "object", additionalProperties: true }) }),
      "Application user AIU history.",
    ),
  },
};
