import {
  Boxes,
  Cable,
  ChartNoAxesCombined,
  CircleDollarSign,
  History,
  House,
  LibraryBig,
  Layers3,
  Rocket,
  Settings,
  Tags,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import {
  isCapabilityVisible,
  type CapabilityState,
  type ConsoleCapability,
} from "../lib/capabilities";

export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly requiredCapability?: ConsoleCapability;
}

export interface NavigationGroup {
  readonly label?: string;
  readonly items: readonly NavigationItem[];
}

export const navigationGroups: readonly NavigationGroup[] = [
  {
    items: [{ href: "/dashboard", label: "首页", icon: House }],
  },
  {
    label: "使用统计",
    items: [
      {
        href: "/ai-units",
        label: "AIU 分析",
        icon: ChartNoAxesCombined,
        requiredCapability: "aiu",
      },
      { href: "/costs", label: "模型花费", icon: CircleDollarSign },
      { href: "/reports", label: "报表", icon: LibraryBig },
    ],
  },
  {
    label: "用户",
    items: [
      {
        href: "/users",
        label: "用户列表",
        icon: Users,
        requiredCapability: "aiu",
      },
      {
        href: "/user-groups",
        label: "用户组",
        icon: UsersRound,
        requiredCapability: "aiu",
      },
    ],
  },
  {
    label: "模型",
    items: [
      {
        href: "/virtual-models",
        label: "虚拟模型",
        icon: Boxes,
        requiredCapability: "model_catalog",
      },
      {
        href: "/models",
        label: "真实模型",
        icon: Layers3,
        requiredCapability: "model_catalog",
      },
      {
        href: "/connections",
        label: "调用连接",
        icon: Cable,
        requiredCapability: "model_catalog",
      },
    ],
  },
  {
    label: "设置",
    items: [
      { href: "/properties", label: "自定义字段", icon: Tags },
      { href: "/connectors", label: "运行状态", icon: Cable },
      { href: "/releases", label: "发布记录", icon: Rocket },
      { href: "/audit", label: "操作记录", icon: History },
      { href: "/settings", label: "设置", icon: Settings },
    ],
  },
];

export function visibleNavigationGroups(
  capabilities: CapabilityState | undefined,
): NavigationGroup[] {
  return navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        isCapabilityVisible(item.requiredCapability, capabilities),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export function activeNavigationHref(
  pathname: string,
  groups: readonly NavigationGroup[],
): string | undefined {
  if (pathname === "/usage" || pathname.startsWith("/usage/")) {
    return groups.flatMap((group) => group.items).some((item) => item.href === "/costs")
      ? "/costs"
      : undefined;
  }
  return groups
    .flatMap((group) => group.items)
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}
