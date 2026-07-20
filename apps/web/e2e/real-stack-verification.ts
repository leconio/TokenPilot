import { expect, type Page } from "@playwright/test";

import {
  acceptanceDisplayUser,
  acceptanceUserId,
  virtualModel,
  type AcceptanceEnvironment,
} from "./real-stack-fixtures";

export async function sendLiteLLMCompletion(
  environment: AcceptanceEnvironment,
  requestId: string,
  traceId: string,
  feature: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (environment.masterKey !== undefined) {
    headers.authorization = `Bearer ${environment.masterKey}`;
  }
  const body = JSON.stringify({
    model: virtualModel,
    messages: [{ role: "user", content: "Content-free isolated acceptance request." }],
    metadata: {
      cp: {
        context_version: "1",
        request_id: requestId,
        operation_id: requestId,
        trace_id: traceId,
        user_id: acceptanceUserId,
        display_user: acceptanceDisplayUser,
        application_version: "acceptance",
        sdk_version: "acceptance",
        event_properties: { next_action: "complete" },
        user_properties: { member_level: "acceptance" },
        analytics_dimensions: { acceptance_feature: feature },
      },
    },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/v1/chat/completions", environment.litellmUrl), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await response.text();
    if (response.status === 500 && responseBody.includes("No trusted Runtime Snapshot")) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      continue;
    }
    expect(response.status, responseBody).toBe(200);
    return;
  }
  throw new Error("LiteLLM did not load its trusted runtime snapshot within 60 seconds");
}

interface UsageProbe {
  readonly status: number;
  readonly found: boolean;
  readonly userId: string | null;
  readonly displayUser: string | null;
  readonly requestModel: string | null;
  readonly providerCostAmount: string | null;
  readonly aiuMicros: string | null;
  readonly eventProperties: Record<string, unknown> | null;
  readonly userProperties: Record<string, unknown> | null;
}

async function probeUsage(page: Page, applicationSlug: string, requestId: string) {
  return page.evaluate<UsageProbe, { applicationSlug: string; requestId: string }>(
    async ({ applicationSlug: slug, requestId: target }) => {
      const now = Date.now();
      const parameters = new URLSearchParams({
        from: new Date(now - 86_400_000).toISOString(),
        to: new Date(now + 60_000).toISOString(),
        timezone: "UTC",
        page_size: "100",
        conditions: JSON.stringify([
          { kind: "builtin", field: "request_id", operator: "equals", values: [target] },
        ]),
      });
      const response = await fetch(
        `/api/control/applications/${encodeURIComponent(slug)}/reports/usage?${parameters}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) {
        return {
          status: response.status,
          found: false,
          userId: null,
          displayUser: null,
          requestModel: null,
          providerCostAmount: null,
          aiuMicros: null,
          eventProperties: null,
          userProperties: null,
        };
      }
      const payload = (await response.json()) as {
        data?: { items?: Array<Record<string, unknown>> };
      };
      const item = payload.data?.items?.find(
        (candidate) => candidate.request_id === target && candidate.status === "success",
      );
      return {
        status: response.status,
        found: item !== undefined,
        userId: typeof item?.user_id === "string" ? item.user_id : null,
        displayUser: typeof item?.display_user === "string" ? item.display_user : null,
        requestModel: typeof item?.request_model === "string" ? item.request_model : null,
        providerCostAmount:
          typeof item?.provider_cost_amount === "string" ? item.provider_cost_amount : null,
        aiuMicros: typeof item?.aiu_micros === "string" ? item.aiu_micros : null,
        eventProperties:
          item?.event_properties !== null && typeof item?.event_properties === "object"
            ? (item.event_properties as Record<string, unknown>)
            : null,
        userProperties:
          item?.user_properties !== null && typeof item?.user_properties === "object"
            ? (item.user_properties as Record<string, unknown>)
            : null,
      };
    },
    { applicationSlug, requestId },
  );
}

export async function verifyReportedUsage(
  page: Page,
  applicationSlug: string,
  requestId: string,
): Promise<void> {
  await expect
    .poll(() => probeUsage(page, applicationSlug, requestId), {
      timeout: 120_000,
      intervals: [500, 1_000, 2_000, 5_000],
    })
    .toMatchObject({
      status: 200,
      found: true,
      userId: acceptanceUserId,
      displayUser: acceptanceDisplayUser,
      requestModel: "text.fast.demo-fallback",
      providerCostAmount: expect.any(String),
      aiuMicros: expect.any(String),
      eventProperties: { next_action: "complete" },
      userProperties: { member_level: "acceptance" },
    });
  const usage = await probeUsage(page, applicationSlug, requestId);
  expect(Number(usage.providerCostAmount)).toBeGreaterThan(0);
  expect(BigInt(usage.aiuMicros ?? "0")).toBeGreaterThan(0n);
}

export async function verifyApplicationPages(page: Page, applicationSlug: string): Promise<void> {
  await page.goto(`/apps/${applicationSlug}/users`);
  await expect(page.getByRole("heading", { name: "用户", exact: true })).toBeVisible();
  await expect(page.getByText(acceptanceDisplayUser, { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  await page.goto(`/apps/${applicationSlug}/usage`);
  await expect(page.getByRole("heading", { name: "调用明细", exact: true })).toBeVisible();

  await page.goto(`/apps/${applicationSlug}/models`);
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await expect(page.getByText("Acceptance primary", { exact: true })).toBeVisible();

  await page.goto(`/apps/${applicationSlug}/virtual-models`);
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "虚拟模型", exact: true })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByText("Acceptance chat", { exact: true })).toBeVisible();
}
