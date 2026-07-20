import type { Route } from "@playwright/test";

import { json, problem } from "./control-plane-mock-http";
import { mockNow } from "./control-plane-mock-state";

export interface RuntimeMockState {
  readonly versions: Map<string, number>;
  readonly runtimeStates: Map<
    string,
    { state: "received" | "applied" | "rejected"; error: string | null }
  >;
}

export function handleMockRuntimeConfiguration(
  route: Route,
  method: string,
  slug: string,
  suffix: string,
  state: RuntimeMockState,
) {
  const version = state.versions.get(slug) ?? 0;
  const runtimeState = state.runtimeStates.get(slug) ?? { state: "applied", error: null };
  if (suffix === "/runtime-configurations" && method === "GET")
    return json(route, {
      versions:
        version === 0
          ? []
          : [
              {
                id: `configuration-${slug}-${version}`,
                version,
                status: "PUBLISHED",
                effective_state: runtimeState.state,
                published_at: mockNow,
                connectors: [
                  {
                    instance_id: "litellm-primary",
                    state: runtimeState.state,
                    error: runtimeState.error === null ? null : { message: runtimeState.error },
                  },
                ],
              },
            ],
    });
  if (suffix === "/runtime-configurations/publish" && method === "POST") {
    state.versions.set(slug, version + 1);
    state.runtimeStates.set(slug, { state: "applied", error: null });
    return json(route, { version: version + 1 }, 201);
  }
  const restore = suffix.match(/^\/runtime-configurations\/(\d+)\/restore$/u);
  if (restore !== null && method === "POST") {
    const sourceVersion = Number(restore[1]);
    state.versions.set(slug, version + 1);
    state.runtimeStates.set(slug, { state: "applied", error: null });
    return json(route, { version: version + 1, restored_from_version: sourceVersion }, 201);
  }
  return problem(route, 404, "Configuration not found");
}
