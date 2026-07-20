"use client";

import { LogOut, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { ApplicationSwitcher, type SwitchableApplication } from "@/components/application-switcher";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { MobileNavigation } from "@/components/mobile-navigation";
import { activeNavigationHref, visibleNavigationGroups } from "@/components/navigation-config";
import { useLocale } from "@/i18n/locale-provider";
import { apiFetch } from "@/lib/api";
import type { CapabilityState } from "@/lib/capabilities";
import { InstanceTimezoneProvider } from "./instance-timezone";

interface ApplicationList {
  readonly applications: readonly SwitchableApplication[];
}

export function ConsoleShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const { text } = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const applicationSlug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1];
  const applicationBase = applicationSlug === undefined ? null : `/apps/${applicationSlug}`;
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => apiFetch<{ user: { name: string; email: string } }>("/web/session"),
    retry: false,
  });
  const applications = useQuery({
    queryKey: ["applications"],
    queryFn: () => apiFetch<ApplicationList>("/applications"),
    enabled: session.isSuccess,
    retry: false,
  });
  const currentApplication = applications.data?.applications.find(
    (application) => application.slug === applicationSlug,
  );
  const capabilities = useQuery({
    queryKey: ["application-capabilities", currentApplication?.id],
    queryFn: () =>
      apiFetch<CapabilityState>(
        `/applications/${encodeURIComponent(currentApplication!.slug)}/capabilities`,
      ),
    enabled: currentApplication !== undefined,
    retry: false,
  });
  useEffect(() => {
    if (session.isError) router.replace("/login");
  }, [router, session.isError]);
  useEffect(() => {
    if (applications.data !== undefined && currentApplication === undefined) {
      router.replace("/apps");
    }
  }, [applications.data, currentApplication, router]);
  if (session.isError) return <div className="loading">正在验证管理会话…</div>;
  if (session.isPending) return <div className="loading">正在打开管理控制台…</div>;
  const visibleNavigation = visibleNavigationGroups(capabilities.data).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      href: `${applicationBase ?? ""}${item.href}`,
    })),
  }));
  const activeHref = activeNavigationHref(pathname, visibleNavigation);
  const activePage = visibleNavigation
    .flatMap((group) => group.items)
    .find((item) => item.href === activeHref);
  const timezone = search.get("timezone") ?? currentApplication?.timezone ?? "UTC";
  return (
    <InstanceTimezoneProvider timezone={timezone}>
      <div className="console">
        <aside className="sidebar desktop-navigation" aria-label="主要导航">
          <Link className="brand-mark" href={`${applicationBase ?? "/apps"}/dashboard`}>
            <span className="brand-glyph">
              <SlidersHorizontal size={17} />
            </span>
            <span>TokenPilot</span>
          </Link>
          <div className="sidebar-context-label">当前应用</div>
          <ApplicationSwitcher
            applications={applications.data?.applications ?? []}
            className="desktop-application-switcher"
            current={currentApplication}
          />
          <nav className="nav">
            {visibleNavigation.map((group) => (
              <div className="nav-group" key={group.label ?? group.items[0]?.href}>
                {group.label ? <div className="nav-section">{group.label}</div> : null}
                {group.items.map((item) => (
                  <Link
                    aria-current={activeHref === item.href ? "page" : undefined}
                    aria-label={item.label}
                    className={`nav-link ${activeHref === item.href ? "active" : ""}`}
                    href={item.href}
                    key={item.href}
                    title={item.label}
                  >
                    <item.icon aria-hidden="true" size={16} />
                    <span>{item.label}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="main-shell">
          <header className="topbar">
            <Breadcrumb className="instance desktop-breadcrumb">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`${applicationBase ?? "/apps"}/dashboard`}>
                      <span data-i18n-skip={currentApplication === undefined ? undefined : ""}>
                        {currentApplication?.name ?? "TokenPilot"}
                      </span>
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{activePage?.label ?? "当前页面"}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <ApplicationSwitcher
              applications={applications.data?.applications ?? []}
              className="mobile-application-switcher"
              current={currentApplication}
            />
            <div className="top-actions">
              <LanguageSwitcher variant="toolbar" />
              <Button
                className="top-logout"
                aria-label={`${text("退出", "Sign out")} ${session.data.user.email}`}
                size="icon-sm"
                variant="outline"
                onClick={async () => {
                  await apiFetch("/web/session/logout", { method: "POST" });
                  router.replace("/login");
                }}
              >
                <LogOut />
              </Button>
            </div>
          </header>
          {children}
        </main>
        <MobileNavigation groups={visibleNavigation} pathname={pathname} />
      </div>
    </InstanceTimezoneProvider>
  );
}
