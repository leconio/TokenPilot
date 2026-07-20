import { expect, test } from "@playwright/test";

import { ControlPlaneMock } from "./control-plane-mock";

test("先配置调用连接，再录入真实模型并设置花费与 AIU", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/connections");
  await page.getByRole("button", { name: "添加调用连接" }).click();
  const connectionDialog = page.getByRole("dialog", { name: "添加调用连接" });
  await connectionDialog.getByLabel("名称", { exact: true }).fill("备用连接");
  await connectionDialog.getByLabel("类型").click();
  await page.getByRole("option", { name: "OpenAI 兼容服务" }).click();
  await connectionDialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("备用连接", { exact: true })).toBeVisible();
  expect(mock.callsFor("POST", "/applications/support/connections")[0]?.body).toMatchObject({
    name: "备用连接",
    driver: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    credential_ref: "OPENAI_API_KEY",
  });

  await page.goto("/apps/support/models");
  await page.getByRole("button", { name: "添加真实模型" }).click();
  const dialog = page.getByRole("dialog", { name: "添加真实模型" });
  await expect(dialog.getByRole("textbox")).toHaveCount(2);
  await dialog.getByLabel("显示名称").fill("推理模型");
  await dialog.getByLabel("模型标识").fill("claude-sonnet-4-5");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("推理模型", { exact: true })).toBeVisible();
  expect(mock.callsFor("POST", "/applications/support/models")[0]?.body).toEqual({
    name: "推理模型",
    connection_id: "connection-support",
    request_model: "claude-sonnet-4-5",
    provider: "openai",
    task_type: "chat",
    capabilities: [],
  });
  await page.getByText("推理模型", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "推理模型" })).toBeVisible();
  await expect(
    page.locator('[data-slot="card-title"]').filter({ hasText: /^模型花费$/u }),
  ).toBeVisible();
  await expect(
    page.locator('[data-slot="card-title"]').filter({ hasText: /^AIU 单价$/u }),
  ).toBeVisible();
});

test("模型详情显示统计，并在停用前说明虚拟模型影响", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/models/model-support");
  await expect(page.getByRole("heading", { name: "快速模型" })).toBeVisible();
  await expect(page.getByText("调用数", { exact: true })).toBeVisible();
  await expect(page.getByText("3,456", { exact: true })).toBeVisible();
  await expect(page.getByText("客服虚拟模型", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "停用模型" }).click();
  const dialog = page.getByRole("dialog", { name: "确认停用模型？" });
  await expect(dialog.getByText("客服虚拟模型", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "确认停用", exact: true }).click();
  await expect(page.getByRole("button", { name: "启用模型" })).toBeVisible();
  expect(mock.callsFor("PATCH", "/applications/support/models/model-support")[0]?.body).toEqual({
    enabled: false,
  });
});

test("同一用户 ID 在不同应用显示独立用户资料，后台可手动新增", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/users");
  await expect(page.getByText("客服用户", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("shared-user", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("paid", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("用户标签").fill("paid");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("客服用户", { exact: true })).toBeVisible();

  await page.getByLabel("用户标签").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "添加用户" }).click();
  const dialog = page.getByRole("dialog", { name: "添加用户" });
  await expect(dialog.getByLabel("显示名称（推荐）")).toBeVisible();
  await dialog.getByLabel("用户 ID").fill("manual-user");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.locator("tbody").getByText("manual-user", { exact: true })).toBeVisible();
  expect(mock.callsFor("POST", "/applications/support/users")[0]?.body).toEqual({
    user_id: "manual-user",
  });
  await page.getByRole("button", { name: "关闭" }).click();

  mock.users.get("support")![0]!.status = "blocked";
  await page.getByRole("combobox").filter({ hasText: "全部状态" }).click();
  await page.getByRole("option", { name: "已停止" }).click();
  await expect(page.getByText("客服用户", { exact: true })).toBeVisible();
  await expect(page.locator("tbody").getByText("manual-user", { exact: true })).toHaveCount(0);

  await page.goto("/apps/voice/users");
  await expect(page.getByText("语音用户", { exact: true })).toBeVisible();
  await expect(page.getByText("客服用户", { exact: true })).toHaveCount(0);
  await expect(page.getByText("manual-user", { exact: true })).toHaveCount(0);
});

test("应用默认额度保持最少字段，并明确区分提醒与严格限制", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/users");

  await expect(
    page.getByText("尚未设置；可以单独为用户或用户组设置额度。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置默认额度" }).click();
  const dialog = page.getByRole("dialog", { name: "默认 AIU 额度" });
  await expect(dialog.getByRole("spinbutton")).toHaveCount(1);
  await dialog.getByLabel("每人额度").fill("12.5");
  await expect(
    dialog.getByText("超过额度只记录提醒，不会阻止调用。", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();

  await expect(page.getByText("12.5 AIU · 每月 · 只提醒", { exact: true })).toBeVisible();
  expect(mock.callsFor("PUT", "/applications/support/quota-policies/application")[0]?.body).toEqual(
    {
      limit: "12.5",
      hard_limit: false,
      period: "month",
      priority: 0,
    },
  );

  await page.getByRole("button", { name: "修改", exact: true }).click();
  await page
    .getByRole("dialog", { name: "默认 AIU 额度" })
    .getByRole("button", { name: "移除规则" })
    .click();
  await expect(
    page.getByText("尚未设置；可以单独为用户或用户组设置额度。", { exact: true }),
  ).toBeVisible();
  expect(
    mock.callsFor("DELETE", "/applications/support/quota-policies/application")[0]?.body,
  ).toEqual({});
});

test("虚拟模型承载分流配置并按应用发布", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/virtual-models");
  await page.getByRole("button", { name: "添加虚拟模型" }).click();
  const dialog = page.getByRole("dialog", { name: "添加虚拟模型" });
  await dialog.getByLabel("调用名称").fill("assistant");
  await dialog.getByLabel("显示名称（可选）").fill("智能助手");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("智能助手", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发布配置" }).click();
  await expect(page.getByText("配置 1 已发布。", { exact: true })).toBeVisible();
  expect(
    mock.callsFor("POST", "/applications/support/runtime-configurations/publish"),
  ).toHaveLength(1);
});

test("发布中心只展示服务端确认状态，并可查看原因后重新发布", async ({ page }) => {
  const mock = new ControlPlaneMock();
  mock.versions.set("support", 1);
  mock.runtimeStates.set("support", {
    state: "rejected",
    error: "首选真实模型当前不可用",
  });
  await mock.install(page);
  await page.goto("/apps/support/releases");

  await expect(page.getByText("未采用", { exact: true })).toBeVisible();
  await expect(page.getByText("首选真实模型当前不可用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新发布" }).click();

  await expect(
    page.getByText("已从配置 #1 创建新配置 #2，等待服务确认。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已生效", { exact: true })).toBeVisible();
  expect(
    mock.callsFor("POST", "/applications/support/runtime-configurations/1/restore"),
  ).toHaveLength(1);
});

test("应用可定义类型化自定义字段并进入分析目录", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/properties");
  await page.getByRole("button", { name: "添加字段" }).click();
  const dialog = page.getByRole("dialog", { name: "添加自定义字段" });
  await dialog.getByLabel("名称").fill("下一步操作");
  await dialog.getByLabel("字段标识").fill("next_action");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("下一步操作", { exact: true })).toBeVisible();
  const body = mock.callsFor("POST", "/applications/support/properties")[0]?.body as Record<
    string,
    unknown
  >;
  expect(body).toMatchObject({
    key: "next_action",
    display_name: "下一步操作",
    scope: "EVENT",
    data_type: "TEXT",
  });
});

test("应用设置完成创建、编辑、停用、成员管理和安全归档", async ({ page }) => {
  const mock = new ControlPlaneMock();
  await mock.install(page);
  await page.goto("/apps/support/settings");
  await page.getByRole("tab", { name: "应用管理" }).click();
  const management = page.getByRole("tabpanel");
  await expect(management.getByText("客服助手", { exact: true })).toBeVisible();
  await expect(management.getByText("语音助手", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "创建应用", exact: true }).click();
  const create = page.getByRole("dialog", { name: "创建应用" });
  await expect(create.getByRole("textbox")).toHaveCount(1);
  await create.getByLabel("应用名称").fill("Analytics");
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(management.getByText("Analytics", { exact: true })).toBeVisible();
  expect(mock.callsFor("POST", "/applications").at(-1)?.body).toEqual({ name: "Analytics" });

  await page.getByRole("button", { name: "编辑应用 客服助手" }).click();
  const edit = page.getByRole("dialog", { name: "编辑应用" });
  await edit.getByLabel("应用名称").fill("客服中心");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  expect(mock.callsFor("PATCH", "/applications/manage/support").at(-1)?.body).toMatchObject({
    name: "客服中心",
  });

  await page.getByRole("button", { name: "添加成员" }).click();
  const addMember = page.getByRole("dialog", { name: "添加成员" });
  await addMember.getByLabel("邮箱").fill("reader@example.test");
  await addMember.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText("reader", { exact: true })).toBeVisible();
  expect(mock.callsFor("POST", "/applications/support/members").at(-1)?.body).toEqual({
    email: "reader@example.test",
    role: "viewer",
  });

  await page.getByRole("button", { name: "停用应用 语音助手" }).click();
  const disable = page.getByRole("dialog", { name: "停用应用" });
  await disable.getByRole("button", { name: "确认停用" }).click();
  expect(mock.callsFor("PATCH", "/applications/manage/voice").at(-1)?.body).toEqual({
    status: "disabled",
  });

  await page.getByRole("button", { name: "归档应用 Analytics" }).click();
  const archive = page.getByRole("dialog", { name: "归档应用" });
  const archiveButton = archive.getByRole("button", { name: "确认归档并保留历史" });
  await expect(archiveButton).toBeDisabled();
  await archive.getByLabel("确认应用名称").fill("Analytics");
  await archive.getByLabel("归档原因").fill("This application is no longer needed");
  await archiveButton.click();
  expect(mock.callsFor("POST", "/applications/analytics/archive").at(-1)?.body).toEqual({
    confirmation_name: "Analytics",
    reason: "This application is no longer needed",
  });
});
