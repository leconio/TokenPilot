import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { jsonBody, record, records, RemoteApi, requiredString } from "./support/remote-api.js";

const enabled = process.env.REMOTE_RELEASE_ACCEPTANCE === "true";
const apiUrl = process.env.RELEASE_API_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:1";
const adminKey = process.env.RELEASE_ADMIN_API_KEY ?? "missing";
const runtimeKey = process.env.RELEASE_RUNTIME_API_KEY ?? "missing";
const applicationSlug = process.env.REAL_STACK_APPLICATION_SLUG ?? "acceptance";
const applicationPath = `/applications/${encodeURIComponent(applicationSlug)}`;
const admin = new RemoteApi(apiUrl, adminKey);
const runtime = new RemoteApi(apiUrl, runtimeKey);

function putJson(value: unknown): RequestInit {
  return { method: "PUT", body: JSON.stringify(value) };
}

function patchJson(value: unknown): RequestInit {
  return { method: "PATCH", body: JSON.stringify(value) };
}

describe.skipIf(!enabled).sequential("remote application acceptance", () => {
  it("serves the published virtual-model routing snapshot with conditional reads", async () => {
    const result = await runtime.json("/runtime/snapshot");
    expect(result.response.status).toBe(200);
    const snapshot = record(result.body, "runtime snapshot");
    expect(snapshot.schema_version).toBe("2.0");
    const routing = record(snapshot.routing, "runtime routing");
    const virtualModel = record(routing["acceptance.chat"], "acceptance virtual model");
    const defaultRoute = record(virtualModel.default, "default route");
    const targets = records(defaultRoute.targets, "default route targets");
    expect(targets.map((target) => target.model_tag)).toEqual([
      "text.fast.demo-primary",
      "text.fast.demo-fallback",
    ]);

    const etag = requiredString(snapshot.etag, "runtime etag");
    const cached = await runtime.json("/runtime/snapshot", {
      headers: { "if-none-match": `"${etag}"` },
    });
    expect(cached.response.status).toBe(304);
    expect(cached.body).toBeNull();
  });

  it("manages an application user quota and enforces block and reset", async () => {
    const userId = `remote-user-${ulid().toLowerCase()}`;
    const created = record(
      await admin.expectJson(
        `${applicationPath}/users`,
        201,
        jsonBody({
          user_id: userId,
          display_user: "Remote acceptance user",
          tags: ["acceptance"],
          properties: { member_level: "acceptance" },
        }),
      ),
      "created user",
    );
    const internalId = requiredString(created.id, "created user id");
    expect(created.user_id).toBe(userId);
    expect(created.display_user).toBe("Remote acceptance user");

    const found = record(
      await admin.expectJson(`${applicationPath}/users/${internalId}`, 200),
      "created user detail",
    );
    expect(found).toMatchObject({ user_id: userId, display_user: "Remote acceptance user" });

    const withQuota = record(
      await admin.expectJson(
        `${applicationPath}/users/${internalId}/quota`,
        200,
        putJson({ limit: "2", hard_limit: true, period: "lifetime" }),
      ),
      "user quota",
    );
    expect(record(withQuota.quota, "quota")).toMatchObject({
      limit_aiu_micros: "2000000",
      remaining_aiu_micros: "2000000",
      hard_limit: true,
    });

    const reserved = record(
      await runtime.expectJson(
        "/runtime/users/aiu/reservations",
        200,
        jsonBody({
          user_id: userId,
          display_user: "Remote acceptance user",
          operation_id: `operation-${ulid().toLowerCase()}`,
          virtual_model: "acceptance.chat",
          estimated_aiu_micros: "750000",
        }),
      ),
      "reservation",
    );
    expect(reserved).toMatchObject({ allowed: true, reason: "reserved" });
    const reservation = record(reserved.reservation, "reservation details");
    const reservationId = requiredString(reservation.id, "reservation id");
    const token = requiredString(reservation.token, "reservation token");
    const settled = record(
      await runtime.expectJson(
        `/runtime/users/aiu/reservations/${reservationId}/settle`,
        200,
        jsonBody({ reservation_token: token, settled_aiu_micros: "500000" }),
      ),
      "settlement",
    );
    expect(settled).toMatchObject({ status: "settled", settled_aiu_micros: "500000" });

    const blocked = record(
      await admin.expectJson(
        `${applicationPath}/users/${internalId}`,
        200,
        patchJson({ blocked: true, reason: "Remote acceptance access check" }),
      ),
      "blocked user",
    );
    expect(blocked.status).toBe("blocked");
    const denied = record(
      await runtime.expectJson(
        "/runtime/users/aiu/reservations",
        200,
        jsonBody({
          user_id: userId,
          operation_id: `operation-${ulid().toLowerCase()}`,
          virtual_model: "acceptance.chat",
          estimated_aiu_micros: "1",
        }),
      ),
      "blocked reservation",
    );
    expect(denied).toMatchObject({ allowed: false, reason: "user_blocked" });

    await admin.expectJson(
      `${applicationPath}/users/${internalId}`,
      200,
      patchJson({ blocked: false, reason: "Remote acceptance access restored" }),
    );
    const reset = record(
      await admin.expectJson(
        `${applicationPath}/users/${internalId}/quota/reset`,
        201,
        jsonBody({ reason: "Remote acceptance quota reset" }),
      ),
      "reset quota",
    );
    expect(record(reset.quota, "reset quota state")).toMatchObject({
      used_aiu_micros: "0",
      reserved_aiu_micros: "0",
      remaining_aiu_micros: "2000000",
    });
  });
});
