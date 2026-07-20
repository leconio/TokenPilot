"use client";

import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { useControlQuery } from "@/features/control-plane/api/hooks";
import type { InstanceCapabilities } from "@/features/control-plane/api/types";

export function PermissionBoundary({
  permission,
  capability,
  hideWhenDenied = false,
  children,
}: Readonly<{
  permission?: string | undefined;
  capability?: string | undefined;
  hideWhenDenied?: boolean | undefined;
  children: ReactNode;
}>) {
  const applicationSlug = useCurrentApplicationSlug();
  const access = useControlQuery<InstanceCapabilities>(
    ["application-capabilities", applicationSlug],
    applicationApiPath(applicationSlug, "/capabilities"),
  );
  if (access.isPending) return hideWhenDenied ? null : <Skeleton className="h-24 w-full" />;
  if (access.isError) {
    if (hideWhenDenied) return null;
    return (
      <Alert variant="destructive">
        <AlertTitle>无法验证权限</AlertTitle>
        <AlertDescription>为避免越权，页面内容已隐藏。{access.error.message}</AlertDescription>
      </Alert>
    );
  }
  const capabilities = access.data.capabilities ?? [];
  const permissions = access.data.permissions ?? [];
  if (capability && !capabilities.includes(capability)) {
    if (hideWhenDenied) return null;
    return (
      <Alert>
        <AlertTitle>功能未启用</AlertTitle>
        <AlertDescription>此功能尚未启用，请先在设置中开启。</AlertDescription>
      </Alert>
    );
  }
  if (permission && !permissions.includes(permission) && !permissions.includes("*")) {
    if (hideWhenDenied) return null;
    return (
      <Alert variant="destructive">
        <AlertTitle>权限不足</AlertTitle>
        <AlertDescription>当前账号没有查看或操作此页面的权限。</AlertDescription>
      </Alert>
    );
  }
  return children;
}
