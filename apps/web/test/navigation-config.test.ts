import { describe, expect, it } from "vitest";

import {
  activeNavigationHref,
  navigationGroups,
  visibleNavigationGroups,
} from "../components/navigation-config.js";

const allCapabilities = {
  capabilities: ["aiu", "quota", "model_catalog"],
} as const;

describe("console navigation information architecture", () => {
  it("keeps the approved hierarchy and Chinese labels in one shared configuration", () => {
    const groups = visibleNavigationGroups(allCapabilities);
    expect(groups.map((group) => group.label ?? group.items[0]?.label)).toEqual([
      "首页",
      "使用统计",
      "用户",
      "模型",
      "设置",
    ]);
    expect(groups.map((group) => group.items.map((item) => item.label))).toEqual([
      ["首页"],
      ["AIU 分析", "模型花费", "报表"],
      ["用户列表", "用户组"],
      ["虚拟模型", "真实模型", "调用连接"],
      ["自定义字段", "运行状态", "发布记录", "操作记录", "设置"],
    ]);
  });

  it("removes unavailable capability links without leaving empty groups", () => {
    const groups = visibleNavigationGroups({ capabilities: [] });
    expect(groups.flatMap((group) => group.items.map((item) => item.label))).toEqual([
      "首页",
      "模型花费",
      "报表",
      "自定义字段",
      "运行状态",
      "发布记录",
      "操作记录",
      "设置",
    ]);
    expect(groups.some((group) => group.label === "用户")).toBe(false);
    expect(groups.some((group) => group.label === "模型")).toBe(false);
  });

  it("selects the most specific active route", () => {
    expect(activeNavigationHref("/models/details", navigationGroups)).toBe("/models");
    expect(activeNavigationHref("/users/detail", navigationGroups)).toBe("/users");
    expect(activeNavigationHref("/usage", navigationGroups)).toBe("/costs");
  });
});
