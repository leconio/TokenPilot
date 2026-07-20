import { type Page, type Route } from "@playwright/test";

import { bodyOf, json, objectBody, problem } from "./control-plane-mock-http";
import { handleMockConnection } from "./control-plane-mock-connections";
import { handleMockModel } from "./control-plane-mock-models";
import { handleMockReport } from "./control-plane-mock-reports";
import { ControlPlaneMockResources } from "./control-plane-mock-resources";
import { handleMockRuntimeConfiguration } from "./control-plane-mock-runtime";
import {
  initialMockApplications,
  initialMockConnections,
  initialMockModels,
  initialMockUsers,
  mockNow,
  mockSlug,
  newMockUser,
  type MockApplication,
  type MockConnection,
  type MockModel,
  type MockOptions,
  type MockUser,
  type RecordedCall,
} from "./control-plane-mock-state";

export { expectUsableLayout } from "./layout-assertions";

export class ControlPlaneMock {
  readonly calls: RecordedCall[] = [];
  readonly applications: MockApplication[] = initialMockApplications();
  readonly models: Map<string, MockModel[]> = initialMockModels();
  readonly connections: Map<string, MockConnection[]> = initialMockConnections();
  readonly users: Map<string, MockUser[]> = initialMockUsers();
  setupRequired: boolean;
  datastoreReady: boolean;
  readonly versions = new Map<string, number>();
  readonly runtimeStates = new Map<
    string,
    { state: "received" | "applied" | "rejected"; error: string | null }
  >();
  private readonly resources = new ControlPlaneMockResources();
  private members = new Map<string, Array<Record<string, unknown>>>([
    [
      "support",
      [
        {
          user_id: "admin-1",
          name: "管理员",
          email: "admin@example.test",
          role: "owner",
          permissions: ["admin:read", "admin:write", "reports:read"],
          created_at: mockNow,
        },
      ],
    ],
    [
      "voice",
      [
        {
          user_id: "admin-1",
          name: "管理员",
          email: "admin@example.test",
          role: "owner",
          permissions: ["admin:read", "admin:write", "reports:read"],
          created_at: mockNow,
        },
      ],
    ],
  ]);

  constructor(options: MockOptions = {}) {
    this.setupRequired = options.setupRequired ?? false;
    this.datastoreReady = options.datastoreReady ?? true;
  }

  async install(page: Page): Promise<void> {
    await page.route("**/api/control/**", async (route) => this.dispatch(route));
  }

  callsFor(method: string, path: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  private async dispatch(route: Route): Promise<void> {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname.replace(/^\/api\/control/u, "");
    const method = request.method();
    const body = bodyOf(request);
    this.calls.push({ method, path, body });

    if (method === "GET" && path === "/health/ready") return this.health(route);
    if (method === "GET" && path === "/web/setup/status")
      return json(route, { setup_required: this.setupRequired });
    if (method === "POST" && path === "/web/setup/initialize") return this.initialize(route, body);
    if (method === "POST" && path === "/web/session/login")
      return json(route, {
        user: { name: "管理员", email: "admin@example.test" },
        csrf_token: "csrf",
        expires_at: mockNow,
      });
    if (method === "GET" && path === "/web/session")
      return json(route, { user: { name: "管理员", email: "admin@example.test" } });
    if (method === "POST" && path === "/web/session/logout")
      return json(route, { logged_out: true });
    if (method === "GET" && path === "/applications/manage")
      return json(route, { applications: this.applications });
    const managedApplication = path.match(/^\/applications\/manage\/([^/]+)$/u);
    if (managedApplication !== null)
      return this.applicationItem(route, method, decodeURIComponent(managedApplication[1]!), body);
    if (path === "/applications") return this.applicationCollection(route, method, body);

    const appMatch = path.match(/^\/applications\/([^/]+)(\/.*)?$/u);
    if (appMatch === null) return problem(route, 404, "Route not found");
    const slug = decodeURIComponent(appMatch[1] ?? "");
    const suffix = appMatch[2] ?? "";
    if (!this.applications.some((application) => application.slug === slug))
      return problem(route, 404, "Application not found");
    if (suffix === "") return this.applicationItem(route, method, slug, body);
    if (method === "GET" && suffix === "/capabilities") return json(route, this.capabilities());
    if (suffix === "/archive" && method === "POST")
      return this.archiveApplication(route, slug, body);
    if (suffix.startsWith("/members"))
      return this.applicationMember(route, method, slug, suffix, body);
    if (suffix.startsWith("/reports/"))
      return handleMockReport(route, method, slug, suffix, body, this);
    if (suffix.startsWith("/connections"))
      return handleMockConnection(
        route,
        method,
        slug,
        suffix,
        body,
        this.connections.get(slug)!,
        this.models.get(slug)!,
      );
    if (suffix.startsWith("/models"))
      return handleMockModel(
        route,
        method,
        slug,
        suffix,
        body,
        this.models.get(slug)!,
        this.connections.get(slug)!,
      );
    if (suffix.startsWith("/virtual-models"))
      return this.resources.virtualModel(route, method, slug, suffix, body);
    if (suffix.startsWith("/runtime-configurations"))
      return handleMockRuntimeConfiguration(route, method, slug, suffix, this);
    if (suffix.startsWith("/quota-policies"))
      return this.resources.quotaPolicy(route, method, slug, suffix, body);
    if (suffix.startsWith("/users"))
      return this.user(route, method, slug, suffix, body, requestUrl.searchParams);
    if (suffix.startsWith("/user-groups")) return this.userGroup(route, method, slug, suffix, body);
    if (suffix.startsWith("/properties"))
      return this.resources.property(route, method, slug, suffix, body);
    if (suffix.startsWith("/service-api-keys"))
      return this.resources.serviceKey(route, method, slug, suffix, body);
    if (method === "GET" && suffix === "/connectors")
      return json(route, {
        connectors: [
          {
            id: `connector-${slug}`,
            instance_id: "litellm-primary",
            name: "LiteLLM",
            type: "litellm",
            version: "1.0.0",
            status: "healthy",
            last_heartbeat_at: mockNow,
            buffer_depth: 0,
            oldest_event_age_seconds: null,
          },
        ],
      });
    if (method === "GET" && suffix.startsWith("/audit")) return json(route, { entries: [] });
    if (method === "GET" && suffix === "/settings")
      return json(route, {
        app_name: this.applications.find((item) => item.slug === slug)?.name,
        timezone: "Asia/Shanghai",
        base_currency: "USD",
        retention_days: 30,
        privacy: { store_prompt_content: false, store_response_content: false },
      });
    return problem(route, 404, "Route not found");
  }

  private health(route: Route) {
    const status = this.datastoreReady ? "healthy" : "unavailable";
    return json(
      route,
      {
        status: this.datastoreReady ? "ready" : "not_ready",
        dependencies: { postgres: { status }, clickhouse: { status }, redis: { status } },
      },
      this.datastoreReady ? 200 : 503,
    );
  }

  private initialize(route: Route, value: unknown) {
    const input = objectBody(value);
    const name = String(input.application_name ?? "First application");
    const slug = mockSlug(name);
    this.applications.splice(0, this.applications.length, {
      id: "app-initial",
      name,
      slug,
      status: "active",
      timezone: "UTC",
      base_currency: "USD",
      role: "owner",
      permissions: ["admin:read", "admin:write"],
      member_count: 1,
      archived_at: null,
    });
    this.models.set(slug, []);
    this.connections.set(slug, []);
    this.users.set(slug, []);
    this.members.set(slug, []);
    this.setupRequired = false;
    return json(route, { initialized: true, application: this.applications[0] }, 201);
  }

  private applicationCollection(route: Route, method: string, value: unknown) {
    if (method === "GET") return json(route, { applications: this.applications });
    if (method !== "POST") return problem(route, 405, "Method not allowed");
    const name = String(objectBody(value).name ?? "").trim();
    if (!name) return problem(route, 400, "Application name is required");
    const application = {
      id: `app-${this.applications.length + 1}`,
      name,
      slug: mockSlug(name),
      status: "active",
      timezone: "UTC",
      base_currency: "USD",
      role: "owner",
      permissions: ["admin:read", "admin:write"],
      member_count: 1,
      archived_at: null,
    };
    this.applications.push(application);
    this.models.set(application.slug, []);
    this.connections.set(application.slug, []);
    this.users.set(application.slug, []);
    this.members.set(application.slug, [
      {
        user_id: "admin-1",
        name: "管理员",
        email: "admin@example.test",
        role: "owner",
        permissions: ["admin:read", "admin:write", "reports:read"],
        created_at: mockNow,
      },
    ]);
    return json(route, application, 201);
  }

  private applicationItem(route: Route, method: string, slug: string, value: unknown) {
    const application = this.applications.find((item) => item.slug === slug);
    if (application === undefined) return problem(route, 404, "Application not found");
    if (method === "GET") return json(route, application);
    if (method !== "PATCH") return problem(route, 405, "Method not allowed");
    Object.assign(application, objectBody(value));
    return json(route, application);
  }

  private archiveApplication(route: Route, slug: string, value: unknown) {
    const application = this.applications.find((item) => item.slug === slug)!;
    const input = objectBody(value);
    if (input.confirmation_name !== application.name || String(input.reason ?? "").length < 5)
      return problem(route, 400, "Application confirmation is invalid");
    application.status = "disabled";
    application.archived_at = mockNow;
    return json(route, {
      archived: true,
      status: "disabled",
      historical_data_retained: true,
    });
  }

  private applicationMember(
    route: Route,
    method: string,
    slug: string,
    suffix: string,
    value: unknown,
  ) {
    const items = this.members.get(slug) ?? [];
    this.members.set(slug, items);
    if (suffix === "/members" && method === "GET") return json(route, { members: items });
    if (suffix === "/members" && method === "POST") {
      const input = objectBody(value);
      const role = String(input.role ?? "viewer");
      const member = {
        user_id: `member-${items.length + 1}`,
        name: String(input.email).split("@")[0],
        email: String(input.email),
        role,
        permissions:
          role === "viewer" ? ["admin:read", "reports:read"] : ["admin:read", "admin:write"],
        created_at: mockNow,
      };
      items.push(member);
      const application = this.applications.find((item) => item.slug === slug)!;
      application.member_count = items.length;
      return json(route, member, 201);
    }
    const match = suffix.match(/^\/members\/([^/]+)$/u);
    const index = items.findIndex((item) => item.user_id === match?.[1]);
    if (index < 0) return problem(route, 404, "Application member not found");
    if (method === "PATCH") {
      Object.assign(items[index]!, objectBody(value));
      return json(route, items[index]);
    }
    if (method === "DELETE") {
      items.splice(index, 1);
      const application = this.applications.find((item) => item.slug === slug)!;
      application.member_count = items.length;
      return json(route, { removed: true });
    }
    return problem(route, 405, "Method not allowed");
  }

  private capabilities() {
    return {
      feature_flags: {
        usage_pipeline: true,
        model_catalog: true,
        aiu: true,
        quota: true,
        hard_limit: true,
        reconciliation: true,
      },
      capabilities: ["usage", "model_catalog", "aiu", "quota", "hard_limit", "reconciliation"],
      permissions: [
        "usage:read",
        "reports:read",
        "admin:read",
        "admin:write",
        "pricing:read",
        "pricing:write",
        "configuration:read",
        "configuration:write",
      ],
    };
  }

  private user(
    route: Route,
    method: string,
    slug: string,
    suffix: string,
    value: unknown,
    parameters: URLSearchParams,
  ) {
    const items = this.users.get(slug)!;
    if (suffix === "/users/summary")
      return json(route, {
        total_users: items.length,
        blocked_users: items.filter((user) => user.status === "blocked").length,
        limit_aiu_micros: String(items.length * 100_000_000),
        used_aiu_micros: String(items.length * 2_500_000),
        reserved_aiu_micros: "0",
        remaining_aiu_micros: String(items.length * 97_500_000),
      });
    if (suffix === "/users" && method === "GET") {
      const searchValue = parameters.get("search")?.trim() ?? "";
      const search = searchValue.toLocaleLowerCase();
      const status = parameters.get("status");
      const tag = parameters.get("tag")?.trim() ?? "";
      const page = Math.max(Number(parameters.get("page") ?? "1"), 1);
      const pageSize = Math.max(Number(parameters.get("limit") ?? "25"), 1);
      const filtered = items.filter(
        (user) =>
          (search.length === 0 ||
            user.user_id.toLocaleLowerCase().includes(search) ||
            user.display_user?.toLocaleLowerCase().includes(search) === true ||
            user.tags.includes(searchValue)) &&
          (status === null || user.status === status) &&
          (tag.length === 0 || user.tags.includes(tag)),
      );
      const start = (page - 1) * pageSize;
      return json(route, {
        users: filtered.slice(start, start + pageSize),
        page,
        page_size: pageSize,
        total: filtered.length,
      });
    }
    if (suffix === "/users" && method === "POST") {
      const input = objectBody(value);
      const user = newMockUser(
        String(input.user_id),
        typeof input.display_user === "string" ? input.display_user : null,
      );
      items.push(user);
      return json(route, user, 201);
    }
    const match = suffix.match(/^\/users\/([^/]+)(\/aiu-ledger|\/quota|\/quota\/reset)?$/u);
    const user = items.find((item) => item.id === match?.[1]);
    if (!user) return problem(route, 404, "User not found");
    if (match?.[2] === "/aiu-ledger") return json(route, { entries: [] });
    if (match?.[2] === "/quota/reset") {
      user.quota.used_aiu_micros = "0";
      user.quota.remaining_aiu_micros = user.quota.limit_aiu_micros;
      return json(route, user);
    }
    if (match?.[2] === "/quota" && method === "PUT") return json(route, user);
    if (method === "PATCH") {
      const input = objectBody(value);
      if (typeof input.display_user === "string" || input.display_user === null)
        user.display_user = input.display_user as string | null;
      if (Array.isArray(input.tags)) user.tags = input.tags.map(String);
      if (typeof input.blocked === "boolean") user.status = input.blocked ? "blocked" : "active";
      return json(route, user);
    }
    return problem(route, 405, "Method not allowed");
  }

  private userGroup(route: Route, method: string, slug: string, suffix: string, value: unknown) {
    if (suffix === "/user-groups" && method === "GET") return json(route, { user_groups: [] });
    if (suffix === "/user-groups" && method === "POST")
      return json(
        route,
        {
          id: `group-${slug}`,
          ...objectBody(value),
          definition_version: 1,
          refresh_minutes: null,
          enabled: true,
          member_count: 0,
          latest_evaluation_id: null,
          evaluated_at: null,
          updated_at: mockNow,
        },
        201,
      );
    return json(route, { members: [], evaluated_at: mockNow });
  }
}
