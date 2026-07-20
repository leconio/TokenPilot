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
      "数据分析",
      "模型配置",
      "用户管理",
      "系统",
    ]);
    expect(groups.map((group) => group.items.map((item) => item.label))).toEqual([
      ["首页"],
      ["AIU 分析", "模型花费", "报表"],
      ["模型", "虚拟模型", "发布中心"],
      ["用户", "用户组"],
      ["自定义字段", "服务连接", "操作记录", "设置"],
    ]);
  });

  it("removes unavailable capability links without leaving empty groups", () => {
    const groups = visibleNavigationGroups({ capabilities: [] });
    expect(groups.flatMap((group) => group.items.map((item) => item.label))).toEqual([
      "首页",
      "模型花费",
      "报表",
      "发布中心",
      "自定义字段",
      "服务连接",
      "操作记录",
      "设置",
    ]);
    expect(groups.some((group) => group.label === "用户管理")).toBe(false);
  });

  it("selects the most specific active route", () => {
    expect(activeNavigationHref("/models/details", navigationGroups)).toBe("/models");
    expect(activeNavigationHref("/users/detail", navigationGroups)).toBe("/users");
    expect(activeNavigationHref("/usage", navigationGroups)).toBe("/costs");
  });
});
