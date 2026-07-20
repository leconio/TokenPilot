import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { applicationSlug, configuration } from "./support/config.js";
import { webCookies } from "./support/fixtures.js";
import { database, server } from "./support/harness.js";

export function registerWebSessionCases(): void {
  it("uses Web login, application membership, CSRF, and application-scoped console routes", async () => {
    const status = await server.inject({ method: "GET", url: "/web/setup/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ setup_required: false });

    const login = await server.inject({
      method: "POST",
      url: "/web/session/login",
      headers: { "content-type": "application/json", "user-agent": "integration-test" },
      payload: JSON.stringify({
        email: "admin@example.test",
        password: "correct horse battery staple",
      }),
    });
    expect(login.statusCode).toBe(201);
    const browser = webCookies(login.headers["set-cookie"]);
    const stored = await database.session.findFirstOrThrow({
      where: { user: { email: "admin@example.test" } },
      orderBy: { createdAt: "desc" },
    });
    expect(stored.token).toBe(createHash("sha256").update(browser.sessionToken).digest("hex"));

    const applications = await server.inject({
      method: "GET",
      url: "/applications",
      headers: { cookie: browser.cookie },
    });
    expect(applications.statusCode).toBe(200);
    expect(applications.json()).toMatchObject({
      applications: [{ slug: applicationSlug, role: "owner" }],
    });
    for (const suffix of ["capabilities", "connectors", "settings", "audit"]) {
      const response = await server.inject({
        method: "GET",
        url: `/applications/${applicationSlug}/${suffix}`,
        headers: { cookie: browser.cookie },
      });
      expect(response.statusCode, suffix).toBe(200);
    }

    const missingCsrf = await server.inject({
      method: "PATCH",
      url: `/applications/${applicationSlug}`,
      headers: { cookie: browser.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Blocked update" }),
    });
    expect(missingCsrf.statusCode).toBe(403);
    const wrongOrigin = await server.inject({
      method: "PATCH",
      url: `/applications/${applicationSlug}`,
      headers: {
        cookie: browser.cookie,
        "x-csrf-token": browser.csrf,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Blocked update" }),
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const changed = await server.inject({
      method: "PATCH",
      url: `/applications/${applicationSlug}`,
      headers: {
        cookie: browser.cookie,
        "x-csrf-token": browser.csrf,
        origin: configuration.webBaseUrl,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Current Integration Updated" }),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      slug: applicationSlug,
      name: "Current Integration Updated",
    });

    const logout = await server.inject({
      method: "POST",
      url: "/web/session/logout",
      headers: {
        cookie: browser.cookie,
        "x-csrf-token": browser.csrf,
        origin: configuration.webBaseUrl,
      },
    });
    expect(logout.statusCode).toBe(201);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
  });
}
