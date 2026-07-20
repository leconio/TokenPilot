import { expect, test } from "@playwright/test";

import { ControlPlaneMock, expectUsableLayout } from "./control-plane-mock";

const pages = [
  ["dashboard", "首页"],
  ["ai-units", "AIU 分析"],
  ["costs", "模型花费"],
  ["reports", "报表"],
  ["models", "模型"],
  ["virtual-models", "虚拟模型"],
  ["releases", "配置发布"],
  ["users", "用户"],
  ["user-groups", "用户组"],
  ["properties", "自定义字段"],
  ["connectors", "服务连接"],
  ["audit", "操作记录"],
  ["settings", "设置"],
] as const;

test.beforeEach(async ({ page }) => {
  await new ControlPlaneMock().install(page);
});

test("每个应用页面保留应用路径并在桌面和窄屏可用", async ({ page }, testInfo) => {
  const narrow = testInfo.project.name.includes("narrow");
  for (const [path, heading] of pages) {
    await page.goto(`/apps/support/${path}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    if (narrow) {
      await expect(page.locator('button[aria-label="切换应用"]:visible')).toContainText("客服助手");
    } else {
      const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" });
      await expect(breadcrumb.getByRole("link", { name: "客服助手" })).toBeVisible();
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
        path === "releases" ? "发布中心" : heading,
      );
    }
    await expect(page).toHaveURL(new RegExp(`/apps/support/${path}`));
    await expectUsableLayout(page);
  }
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(
    /(?:钱包|账单|发票|基础模型|抽象模型|运行模型|\bwallet\b|\bbilling\b|\binvoice\b|\bPhase\b)/iu,
  );
});

test("中英文切换不丢失当前应用", async ({ page }) => {
  await page.goto("/apps/support/users?status=active");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "User", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/apps\/support\/users\?status=active/u);
});

test("应用切换支持搜索、最近使用和创建入口", async ({ page }) => {
  await page.goto("/apps/support/dashboard");
  await page.locator('button[aria-label="切换应用"]:visible').click();
  const switcher = page.getByRole("dialog", { name: "切换应用" });
  await switcher.getByRole("combobox", { name: "搜索应用" }).fill("语音");
  await page
    .getByRole("option", { name: /语音助手/u })
    .last()
    .click();
  await expect(page).toHaveURL(/\/apps\/voice\/dashboard/u);
  await expect(page.locator('button[aria-label="切换应用"]:visible')).toContainText("语音助手");

  await page.locator('button[aria-label="切换应用"]:visible').click();
  const reopened = page.getByRole("dialog", { name: "切换应用" });
  await expect(reopened.getByText("最近使用", { exact: true })).toBeVisible();
  await reopened.getByRole("option", { name: "新建应用" }).click();
  await page.getByLabel("应用名称").fill("评测工具");
  await page
    .getByRole("dialog", { name: "创建应用" })
    .getByRole("button", { name: "创建", exact: true })
    .click();
  await expect(page).toHaveURL(/\/apps\/application-\d+\/dashboard/u);
});
