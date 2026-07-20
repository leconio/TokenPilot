import { expect, test } from "@playwright/test";

import {
  acceptanceEnvironment,
  enabled,
  freshUlid,
  verifyExternalIngress,
} from "./real-stack-fixtures";
import {
  sendLiteLLMCompletion,
  verifyApplicationPages,
  verifyReportedUsage,
} from "./real-stack-verification";

test.skip(!enabled, "REAL_STACK_E2E=true is required");

const environment = enabled ? acceptanceEnvironment() : null;

test.beforeEach(async ({ page }) => {
  if (environment === null) throw new Error("Real-stack environment is unavailable");
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(environment!.email);
  await page.getByLabel("密码").fill(environment!.password);
  await page.getByRole("button", { name: "登录控制台" }).click();
  await expect(page).toHaveURL(/\/apps\/[^/]+\/dashboard(?:\?|$)/u);
});

test("真实 LiteLLM 调用按应用写入用户、字段、模型花费和 AIU", async ({ page, request }) => {
  test.skip(process.env.REAL_STACK_SCENARIO !== "healthy", "Healthy stack only");
  await verifyExternalIngress(request, environment!);
  const requestId = freshUlid();
  const traceId = `trace-${freshUlid()}`;
  const feature = `acceptance-${freshUlid()}`;

  await sendLiteLLMCompletion(environment!, requestId, traceId, feature);
  await verifyReportedUsage(page, environment!.applicationSlug, requestId);
  await verifyApplicationPages(page, environment!.applicationSlug);
});

test("ClickHouse 中断时真实报告页显示错误态", async ({ page }) => {
  test.skip(process.env.REAL_STACK_SCENARIO !== "clickhouse-outage", "Outage stack only");
  await page.goto(`/apps/${environment!.applicationSlug}/usage`);
  await expect(page.getByText("加载失败", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("分析服务暂时不可用，请稍后重试或联系管理员。")).toBeVisible();
});
