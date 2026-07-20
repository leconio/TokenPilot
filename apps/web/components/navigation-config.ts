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
    label: "数据分析",
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
    label: "模型配置",
    items: [
      {
        href: "/models",
        label: "模型",
        icon: Layers3,
        requiredCapability: "model_catalog",
      },
      {
        href: "/virtual-models",
        label: "虚拟模型",
        icon: Boxes,
        requiredCapability: "model_catalog",
      },
      { href: "/releases", label: "发布中心", icon: Rocket },
    ],
  },
  {
    label: "用户管理",
    items: [
      {
        href: "/users",
        label: "用户",
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
    label: "系统",
    items: [
      { href: "/properties", label: "自定义字段", icon: Tags },
      { href: "/connectors", label: "服务连接", icon: Cable },
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
