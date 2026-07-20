import type { Route } from "@playwright/test";

import { json, objectBody, problem, reportEnvelope } from "./control-plane-mock-http";
import { mockNow, type MockModel, type MockUser } from "./control-plane-mock-state";

interface ReportState {
  readonly models: Map<string, MockModel[]>;
  readonly users: Map<string, MockUser[]>;
}

export function handleMockReport(
  route: Route,
  method: string,
  slug: string,
  suffix: string,
  value: unknown,
  state: ReportState,
) {
  if (suffix === "/reports/saved" && method === "GET") return json(route, { reports: [] });
  if (suffix === "/reports/saved" && method === "POST")
    return json(route, { id: "report-1", ...objectBody(value), updated_at: mockNow }, 201);
  if (suffix === "/reports/dashboard" && method === "GET") return json(route, { cards: [] });
  if (suffix.startsWith("/reports/dashboard/") && method === "DELETE")
    return json(route, { deleted: true });
  if (suffix.startsWith("/reports/saved/") && method === "DELETE")
    return json(route, { deleted: true });
  if (suffix === "/reports/overview")
    return json(
      route,
      reportEnvelope(mockNow, {
        provider_cost: { value: slug === "support" ? "1.25" : "2.50", currency: "USD" },
        requests: 3,
        unpriced_events: 0,
        unmapped_events: 0,
        aiu: { micros: "2500000", display: "2.5" },
      }),
    );
  if (suffix === "/reports/aiu")
    return json(
      route,
      reportEnvelope(mockNow, {
        total: { micros: "2500000" },
        unrated_events: 0,
        unmapped_events: 0,
        groups: [
          {
            dimension: "request_model",
            key: state.models.get(slug)?.[0]?.request_model ?? "",
            aiu_micros: "2500000",
          },
        ],
        total_groups: 1,
        next_cursor: null,
      }),
    );
  if (suffix === "/reports/provider-cost")
    return json(
      route,
      reportEnvelope(mockNow, {
        total: { value: "1.25", currency: "USD" },
        totals: [{ value: "1.25", currency: "USD" }],
        failed_attempt_cost: { value: "0", currency: "USD" },
        fallback_extra_cost: { value: "0", currency: "USD" },
        unpriced_events: 0,
        groups: [
          {
            dimension: "request_model",
            key: state.models.get(slug)?.[0]?.request_model ?? "",
            currency: "USD",
            amount: "1.25",
          },
        ],
        total_groups: 1,
        next_cursor: null,
      }),
    );
  if (suffix === "/reports/usage")
    return json(
      route,
      reportEnvelope(mockNow, {
        items:
          state.users.get(slug)?.map((user, index) => ({
            event_id: `event-${slug}-${index}`,
            request_id: `request-${index}`,
            event_time: mockNow,
            user_id: user.user_id,
            display_user: user.display_user,
            virtual_model: "assistant",
            model_id: state.models.get(slug)?.[0]?.id ?? null,
            request_model: state.models.get(slug)?.[0]?.request_model ?? "unknown",
            provider: "openai",
            status: "success",
            route_reason: "default",
            provider_cost_status: "official",
            provider_cost_amount: "1.25",
            provider_cost_currency: "USD",
            aiu_status: "official",
            aiu_micros: "2500000",
            event_properties: {},
            user_properties: {},
          })) ?? [],
        page_size: 25,
        total: state.users.get(slug)?.length ?? 0,
        next_cursor: null,
      }),
    );
  if (suffix === "/reports/pipeline-health")
    return json(
      route,
      reportEnvelope(mockNow, {
        connector: "healthy",
        settlement: "healthy",
        reconciliation: "healthy",
      }),
    );
  return problem(route, 404, "Report not found");
}
