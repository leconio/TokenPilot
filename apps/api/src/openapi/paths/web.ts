import type { OperationContract } from "../types.js";
import { body, CURRENCY, DATE_TIME, object, success } from "../schema-helpers.js";
import {
  CSRF_HEADERS,
  WEB_AUTH_HEADERS,
  WEB_IDENTITY,
  WEB_SESSION_SECURITY,
} from "../schemas/platform.js";

export const WEB_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  "GET /web/setup/status": {
    success: success(
      "200",
      object(["setup_required", "defaults"], {
        setup_required: { type: "boolean" },
        defaults: object(["timezone", "base_currency"], {
          timezone: { type: "string" },
          base_currency: CURRENCY,
        }),
      }),
      "Initial setup status.",
    ),
  },
  "POST /web/setup/initialize": {
    parameters: WEB_AUTH_HEADERS,
    requestBody: body(
      object(["name", "email", "password", "application_name"], {
        name: { type: "string", minLength: 1, maxLength: 120 },
        email: { type: "string", format: "email", maxLength: 320 },
        password: { type: "string", minLength: 12, maxLength: 256, writeOnly: true },
        application_name: { type: "string", minLength: 1, maxLength: 120 },
      }),
    ),
    success: success(
      "201",
      object(["initialized", "user", "application", "expires_at", "csrf_token"], {
        initialized: { type: "boolean", enum: [true] },
        user: object(["id", "name", "email"], {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
        }),
        application: object(["id", "name", "slug"], {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
        }),
        expires_at: DATE_TIME,
        csrf_token: { type: "string", readOnly: true },
      }),
      "Instance initialized and Web session created.",
      "application/json",
      {
        "Set-Cookie": {
          description: "cp_session HttpOnly cookie and readable cp_csrf cookie.",
          schema: { type: "string" },
        },
      },
    ),
  },
  "POST /web/session/login": {
    parameters: WEB_AUTH_HEADERS,
    requestBody: body(
      object(["email", "password"], {
        email: { type: "string", format: "email", maxLength: 320 },
        password: { type: "string", minLength: 1, maxLength: 256, writeOnly: true },
      }),
    ),
    success: success(
      "201",
      object(["user", "expires_at", "csrf_token"], {
        user: WEB_IDENTITY,
        expires_at: DATE_TIME,
        csrf_token: { type: "string", readOnly: true },
      }),
      "Web session created.",
      "application/json",
      {
        "Set-Cookie": {
          description: "cp_session HttpOnly cookie and readable cp_csrf cookie.",
          schema: { type: "string" },
        },
      },
    ),
  },
  "GET /web/session": {
    security: WEB_SESSION_SECURITY,
    success: success(
      "200",
      object(["user"], { user: WEB_IDENTITY }),
      "Current Web session identity.",
    ),
  },
  "POST /web/session/logout": {
    security: WEB_SESSION_SECURITY,
    parameters: CSRF_HEADERS,
    success: success(
      "201",
      object(["logged_out"], { logged_out: { type: "boolean", enum: [true] } }),
      "Web session revoked.",
      "application/json",
      {
        "Set-Cookie": {
          description: "Clears cp_session and cp_csrf cookies.",
          schema: { type: "string" },
        },
      },
    ),
  },
};
