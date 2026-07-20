export interface MockOptions {
  readonly setupRequired?: boolean;
  readonly datastoreReady?: boolean;
}

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockApplication {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  base_currency: string;
  role: string;
  permissions: string[];
  member_count: number;
  archived_at: string | null;
}

export interface MockModel {
  id: string;
  name: string;
  litellm_tag: string;
  provider: string | null;
  enabled: boolean;
}

export interface MockUser {
  id: string;
  user_id: string;
  display_user: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  status: "active" | "blocked";
  blocked_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
  usage: { calls: number; tokens: string; aiu_micros: string };
  quota: {
    limit_aiu_micros: string;
    used_aiu_micros: string;
    reserved_aiu_micros: string;
    remaining_aiu_micros: string;
    hard_limit: boolean;
    period: string;
    period_start: string | null;
    period_end: string | null;
  };
}

export const mockNow = "2026-07-18T06:00:00.000Z";

export function mockSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return ascii || `application-${Date.now()}`;
}

export function newMockUser(
  id: string,
  displayUser: string | null,
  tags: readonly string[] = [],
): MockUser {
  return {
    id: `user-${id}`,
    user_id: id,
    display_user: displayUser,
    tags: [...tags],
    properties: {},
    status: "active",
    blocked_reason: null,
    first_seen_at: mockNow,
    last_seen_at: mockNow,
    usage: { calls: 3, tokens: "1200", aiu_micros: "2500000" },
    quota: {
      limit_aiu_micros: "100000000",
      used_aiu_micros: "2500000",
      reserved_aiu_micros: "0",
      remaining_aiu_micros: "97500000",
      hard_limit: true,
      period: "monthly",
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-08-01T00:00:00.000Z",
    },
  };
}

export function initialMockApplications(): MockApplication[] {
  return [
    {
      id: "app-a",
      name: "客服助手",
      slug: "support",
      status: "active",
      timezone: "Asia/Shanghai",
      base_currency: "USD",
      role: "owner",
      permissions: ["admin:read", "admin:write"],
      member_count: 1,
      archived_at: null,
    },
    {
      id: "app-b",
      name: "语音助手",
      slug: "voice",
      status: "active",
      timezone: "Asia/Shanghai",
      base_currency: "USD",
      role: "owner",
      permissions: ["admin:read", "admin:write"],
      member_count: 1,
      archived_at: null,
    },
  ];
}

export function initialMockModels(): Map<string, MockModel[]> {
  return new Map([
    [
      "support",
      [
        {
          id: "model-support",
          name: "快速模型",
          litellm_tag: "openai/gpt-4.1-mini",
          provider: "openai",
          enabled: true,
        },
      ],
    ],
    [
      "voice",
      [
        {
          id: "model-voice",
          name: "语音模型",
          litellm_tag: "openai/gpt-4o-audio",
          provider: "openai",
          enabled: true,
        },
      ],
    ],
  ]);
}

export function initialMockUsers(): Map<string, MockUser[]> {
  return new Map([
    ["support", [newMockUser("shared-user", "客服用户", ["paid"])]],
    ["voice", [newMockUser("shared-user", "语音用户", ["voice"])]],
  ]);
}
