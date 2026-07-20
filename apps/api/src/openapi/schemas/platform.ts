import { INSTANCE_FEATURE_FLAG_NAMES } from "@tokenpilot/shared";

import type { ContractParameter } from "../types.js";
import {
  array,
  AUDIT_REASON,
  DATE_TIME,
  header,
  nullable,
  object,
  UUID,
} from "../schema-helpers.js";

export const APPLICATION_FEATURE_FLAGS = object(INSTANCE_FEATURE_FLAG_NAMES, {
  ...Object.fromEntries(INSTANCE_FEATURE_FLAG_NAMES.map((name) => [name, { type: "boolean" }])),
});
export const APPLICATION_CAPABILITIES = array({
  type: "string",
  enum: INSTANCE_FEATURE_FLAG_NAMES,
});
export const SERVICE_KEY_CREATE = object(["name", "scopes", "reason"], {
  name: { type: "string", minLength: 1, maxLength: 120 },
  scopes: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    items: { type: "string", pattern: "^[a-z]+:[a-z]+$" },
  },
  expires_at: nullable(DATE_TIME),
  reason: AUDIT_REASON,
});
export const WEB_IDENTITY = object(["sessionId", "userId", "name", "email"], {
  sessionId: UUID,
  userId: { type: "string" },
  name: { type: "string" },
  email: { type: "string", format: "email" },
});
export const WEB_AUTH_HEADERS: readonly ContractParameter[] = [
  header(
    "Origin",
    { type: "string", format: "uri" },
    false,
    "Browser origin, when present, must equal WEB_BASE_URL.",
  ),
  header("Sec-Fetch-Site", { type: "string", enum: ["same-origin", "same-site", "none"] }),
];
export const CSRF_HEADERS: readonly ContractParameter[] = [
  header("x-csrf-token", { type: "string", minLength: 16 }, true, "Must match the cp_csrf cookie."),
  ...WEB_AUTH_HEADERS,
];

export const WEB_SESSION_SECURITY = [{ webSession: [] }] as const;
