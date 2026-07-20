import { expect, test, type Page } from "@playwright/test";

import { ControlPlaneMock } from "./control-plane-mock";

const pages = [
  "dashboard",
  "ai-units",
  "costs",
  "reports",
  "models",
  "models/model-support",
  "virtual-models",
  "releases",
  "users",
  "user-groups",
  "properties",
  "connectors",
  "audit",
  "settings",
] as const;

function useEnglishFixtureData(mock: ControlPlaneMock) {
  mock.applications[0]!.name = "Support assistant";
  mock.applications[1]!.name = "Voice assistant";
  mock.models.get("support")![0]!.name = "Fast model";
  mock.models.get("voice")![0]!.name = "Voice model";
  mock.users.get("support")![0]!.display_user = "Support user";
  mock.users.get("voice")![0]!.display_user = "Voice user";
}

async function untranslatedInterfaceText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const han = /[\p{Script=Han}]/u;
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    };
    const leftovers = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const parent = node.parentElement;
      const value = node.textContent?.trim() ?? "";
      if (
        value !== "" &&
        han.test(value) &&
        parent !== null &&
        parent.closest("[data-locale-control], [data-i18n-skip], script, style, code, pre") ===
          null &&
        visible(parent)
      ) {
        leftovers.add(value);
      }
      node = walker.nextNode();
    }
    for (const element of document.body.querySelectorAll<HTMLElement>(
      "[aria-label], [placeholder], [title], [alt]",
    )) {
      if (element.closest("[data-locale-control], [data-i18n-skip]") !== null || !visible(element))
        continue;
      for (const attribute of ["aria-label", "placeholder", "title", "alt"]) {
        const value = element.getAttribute(attribute)?.trim() ?? "";
        if (han.test(value)) leftovers.add(`${attribute}: ${value}`);
      }
    }
    return [...leftovers].sort();
  });
}

async function expectEnglishInterface(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect.poll(() => untranslatedInterfaceText(page)).toEqual([]);
}

async function collectEnglishInterfaceIssues(page: Page): Promise<string[]> {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return untranslatedInterfaceText(page);
}

async function installEnglishMock(page: Page, emptyApplications = false) {
  const mock = new ControlPlaneMock();
  useEnglishFixtureData(mock);
  if (emptyApplications) mock.applications.splice(0);
  await mock.install(page);
  return mock;
}

test("英文模式覆盖全部应用页面且服务端直接使用已选语言", async ({ page }) => {
  await installEnglishMock(page);
  await page.goto("/apps/support/dashboard");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();

  const uncovered: Record<string, string[]> = {};
  for (const path of pages) {
    const response = await page.goto(`/apps/support/${path}`);
    expect(await response?.text()).toContain('<html lang="en"');
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    if (path === "costs") {
      await expect(page.getByText("By model", { exact: true })).toBeVisible();
    }
    let issues = await collectEnglishInterfaceIssues(page);
    if (path === "ai-units") {
      await page.getByRole("tab", { name: "Explore data" }).click();
      await expect(page.getByText("By user", { exact: true })).toBeVisible();
      issues = [...new Set([...issues, ...(await collectEnglishInterfaceIssues(page))])];
    }
    if (issues.length > 0) uncovered[path] = issues;
  }
  expect(uncovered).toEqual({});
});

test("英文模式覆盖常用筛选器和弹窗", async ({ page }) => {
  await installEnglishMock(page);
  await page.goto("/apps/support/users");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();

  await page.getByRole("button", { name: "Filters" }).click();
  await expectEnglishInterface(page);
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByRole("dialog", { name: "Add user" })).toBeVisible();
  await expectEnglishInterface(page);
  await page
    .getByRole("dialog", { name: "Add user" })
    .getByRole("button", { name: "Close" })
    .first()
    .click();

  await page.goto("/apps/support/models");
  await page.getByRole("button", { name: "Add model" }).click();
  await expect(page.getByRole("dialog", { name: "Add model" })).toBeVisible();
  await expectEnglishInterface(page);

  await page.keyboard.press("Escape");
  await page.goto("/apps/support/virtual-models");
  await page.getByRole("button", { name: "Add virtual model" }).click();
  await expect(page.getByRole("dialog", { name: "Add virtual model" })).toBeVisible();
  await expectEnglishInterface(page);

  await page.keyboard.press("Escape");
  await page.locator('button[aria-label="Switch application"]:visible').click();
  await expect(page.getByRole("dialog", { name: "Switch application" })).toBeVisible();
  await expectEnglishInterface(page);

  await page.keyboard.press("Escape");
  await page.goto("/apps/support/costs");
  await page.getByRole("tab", { name: "Explore data" }).click();
  await page.getByRole("button", { name: "Save report" }).click();
  const saveReport = page.getByRole("dialog", { name: "Save report" });
  const reportName = saveReport.getByLabel("Name");
  await expect(reportName).toHaveValue(/Model cost/u);
  expect(await reportName.inputValue()).not.toMatch(/[\p{Script=Han}]/u);
  await expectEnglishInterface(page);
});

test("英文模式覆盖登录、首次应用和不存在页面", async ({ page }) => {
  await installEnglishMock(page, true);
  await page.goto("/login");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectEnglishInterface(page);

  await page.goto("/apps");
  await expect(page.getByText("Create your first application", { exact: true })).toBeVisible();
  await expectEnglishInterface(page);

  await page.goto("/this-page-does-not-exist");
  await expect(page.getByText("Page not found", { exact: true })).toBeVisible();
  await expectEnglishInterface(page);
});

test("英文模式覆盖首次配置页和表单校验", async ({ page }) => {
  const mock = new ControlPlaneMock({ setupRequired: true });
  await mock.install(page);
  await page.goto("/setup");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Create administrator" })).toBeVisible();
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expectEnglishInterface(page);
});

test("英文模式不会改写应用、模型和用户数据", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/dashboard");
  await page.getByLabel("界面语言").click();
  await page.getByRole("option", { name: "English" }).click();

  await expect(page.locator('button[aria-label="Switch application"]:visible')).toContainText(
    "客服助手",
  );

  await page.goto("/apps/support/models");
  await expect(page.getByText("快速模型", { exact: true })).toBeVisible();
  await page.getByText("快速模型", { exact: true }).click();
  await expect(page.getByText("客服虚拟模型", { exact: true })).toBeVisible();

  await page.goto("/apps/support/users");
  await expect(page.getByText("客服用户", { exact: true })).toBeVisible();
});
