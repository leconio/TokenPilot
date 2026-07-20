import { describe, expect, it } from "vitest";

import type { RuntimeRouteMatch, RuntimeSnapshot } from "@tokenpilot/contracts";

import { createAiRuntimeClient, withAiContext, type RuntimeRouteContext } from "../src/index.js";

import {
  now,
  signedSnapshot,
  baseSnapshot,
  json,
  acceptedUsage,
  client,
  lkgPath,
} from "./runtime-testkit.js";

describe("Node runtime SDK reliability", () => {
  it("settles a successful hard-limit reservation exactly once", async () => {
    const hard = structuredClone(baseSnapshot);
    hard.aiu.mode = "hard_limit";
    hard.routing["text.fast"]!.default.targets[0]!.model_id =
      "00000000-0000-4000-8000-000000000001";
    hard.routing["text.fast"]!.default.targets[1]!.model_id =
      "00000000-0000-4000-8000-000000000002";
    const snapshot = signedSnapshot(hard);
    let settles = 0;
    const runtime = createAiRuntimeClient({
      controlPlaneUrl: "http://control.test",
      apiKey: "node-sdk-runtime-key-0000001",
      lkgPath,
      credentials: { LITELLM_API_KEY: "local-secret" },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/runtime/snapshot")) return json(snapshot);
        if (url.endsWith("/runtime/configuration-acknowledgements")) return json({}, 202);
        if (url.endsWith("/usage-events/batch")) return acceptedUsage(init);
        if (url.endsWith("/runtime/users/aiu/reservations")) {
          return json({
            allowed: true,
            reason: "reserved",
            user: {
              id: "user-1",
              limit_aiu_micros: "1000",
              used_aiu_micros: "0",
              reserved_aiu_micros: "100",
              remaining_aiu_micros: "900",
            },
            reservation: {
              id: "reservation-1",
              token: "reservation-token-0123456789abcdef0123456789abcdef0123456789abcdef",
              reserved_aiu_micros: "100",
              expires_at: "2026-07-16T13:05:00.000Z",
            },
          });
        }
        if (url.endsWith("/settle")) {
          settles += 1;
          expect(JSON.parse(String(init?.body))).toMatchObject({ settled_aiu_micros: "80" });
          return json({ status: "settled" });
        }
        throw new Error(`Unexpected control request: ${url}`);
      },
      providerFetch: async () =>
        json({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      now: () => now,
    });
    await runtime.refresh();
    await withAiContext({ userId: "quota-user" }, () =>
      runtime.chat({
        model: "text.fast",
        messages: [{ role: "user", content: "hello" }],
        estimatedAiuMicros: "80",
      }),
    );
    expect(settles).toBe(1);
    runtime.close();
  });

  it("covers user, property, source, schedule, override, and conflict routing rules", async () => {
    type RuleInput = RuntimeRouteMatch & { readonly priority?: number };
    const withRules = (matches: RuleInput[], timezone = "UTC") => {
      const value: RuntimeSnapshot = structuredClone(baseSnapshot);
      const plan = value.routing["text.fast"]!;
      plan.timezone = timezone;
      const routeTag = "cp:text.fast:rule";
      const targets = [...plan.default.targets].reverse().map((target, index) => ({
        ...target,
        route_tag: routeTag,
        fallback_order: index,
      }));
      plan.rules = matches.map((candidate, index) => {
        const { priority = 100, ...match } = candidate;
        return {
          id: `rule-${index}`,
          priority,
          match,
          route: { route_tag: routeTag, selection_mode: "ordered", targets },
          ...("override_active" in match && match.override_active === true
            ? { expires_at: "2026-07-16T14:00:00.000Z" }
            : {}),
        };
      });
      return signedSnapshot(value);
    };
    const cases: Array<[RuleInput, RuntimeRouteContext]> = [
      [{ user: { ids: ["u-1"] } }, { userId: "u-1" }],
      [
        { user_property: { key: "plan", operator: "starts_with", value: "pro" } },
        { userProperties: { plan: "professional" } },
      ],
      [
        { user_property: { key: "tags", operator: "contains", value: "vip" } },
        { userProperties: { tags: ["vip", "paid"] } },
      ],
      [{ user_property: { key: "region", operator: "is_not_set" } }, { userProperties: {} }],
      [{ call_source: { value: "parse" } }, { callSource: "parse" }],
      [{ schedule: { days: [4], from: "12:00", to: "14:00" } }, {}],
      [{ override_active: true }, {}],
    ];
    for (const [match, context] of cases) {
      const runtime = client(async () => json({}), withRules([match]));
      await runtime.refresh();
      expect(runtime.selectRoute("text.fast", context).primary.model_id).toBe("model-fallback");
      runtime.close();
    }
    const overnight = client(
      async () => json({}),
      withRules([{ schedule: { days: [3], from: "23:00", to: "14:00" } }]),
    );
    await overnight.refresh();
    expect(overnight.selectRoute("text.fast").ruleId).toBe("rule-0");
    overnight.close();

    const conflict = client(
      async () => json({}),
      withRules([
        { priority: 100, user: { ids: ["u-1"] } },
        { priority: 100, call_source: { value: "parse" } },
      ]),
    );
    await conflict.refresh();
    expect(() => conflict.selectRoute("text.fast", { userId: "u-1", callSource: "parse" })).toThrow(
      /winning priority/u,
    );
    expect(() => conflict.selectRoute("missing")).toThrow(/No active route/u);
    conflict.close();
  });
});
