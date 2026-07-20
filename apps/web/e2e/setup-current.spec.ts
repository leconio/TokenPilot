import { expect, test } from "@playwright/test";

import { ControlPlaneMock } from "./control-plane-mock";

test("首次配置创建管理员、首个应用和两枚应用密钥", async ({ page }) => {
  const mock = new ControlPlaneMock({ setupRequired: true });
  await mock.install(page);
  await page.goto("/setup");
  await page.getByLabel("应用名称").fill("Knowledge");
  await page.getByLabel("管理员姓名").fill("管理员");
  await page.getByLabel("管理员邮箱").fill("admin@example.test");
  await page.getByLabel("管理员密码").fill("StrongPassword123!");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "配置已完成" })).toBeVisible();
  await expect(page.getByLabel("用量接入密钥 key")).toHaveValue(/tp_live_knowledge/u);
  await expect(page.getByLabel("策略读取密钥 key")).toHaveValue(/tp_live_knowledge/u);
  expect(mock.callsFor("POST", "/applications/knowledge/service-api-keys")).toHaveLength(2);
  await page.getByRole("button", { name: "进入应用" }).click();
  await expect(page).toHaveURL(/\/apps\/knowledge\/dashboard/u);
});

test("PostgreSQL、ClickHouse 或 Redis 未就绪时禁止首次配置", async ({ page }) => {
  const mock = new ControlPlaneMock({ setupRequired: true, datastoreReady: false });
  await mock.install(page);
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "数据连接不完整" })).toBeVisible();
  await expect(page.getByLabel("应用名称")).toHaveCount(0);
});

test("登录成功进入应用选择而不是无应用上下文页面", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("admin@example.test");
  await page.getByLabel("密码").fill("StrongPassword123!");
  await page.getByRole("button", { name: "登录控制台" }).click();
  await expect(page).toHaveURL(/\/apps\/support\/dashboard/u);
});
