"use client";

import { Menu } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { activeNavigationHref, type NavigationGroup } from "@/components/navigation-config";

const quickLinks = ["/dashboard", "/costs", "/users"] as const;

export function MobileNavigation({
  groups,
  pathname,
}: Readonly<{
  groups: readonly NavigationGroup[];
  pathname: string;
}>) {
  const visible = groups.flatMap((group) => group.items);
  const quick = quickLinks.flatMap((href) =>
    visible.filter((item) => item.href === href || item.href.endsWith(href)),
  );
  const activeHref = activeNavigationHref(pathname, groups);

  return (
    <aside className="mobile-navigation" aria-label="移动导航">
      <nav className="mobile-navigation-quick" aria-label="移动快捷导航">
        {quick.map((item) => (
          <Link
            aria-current={activeHref === item.href ? "page" : undefined}
            aria-label={item.label}
            className={`mobile-navigation-link ${activeHref === item.href ? "active" : ""}`}
            href={item.href}
            key={item.href}
          >
            <item.icon aria-hidden="true" size={17} />
            <span>{item.label}</span>
          </Link>
        ))}
        <Sheet>
          <SheetTrigger asChild>
            <Button className="mobile-navigation-link" variant="ghost">
              <Menu aria-hidden="true" size={18} />
              <span>全部功能</span>
            </Button>
          </SheetTrigger>
          <SheetContent className="max-w-[22rem]" aria-describedby="mobile-navigation-description">
            <SheetHeader>
              <SheetTitle>导航</SheetTitle>
              <SheetDescription id="mobile-navigation-description">
                选择要打开的功能。
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="mobile-navigation-sheet">
              {groups.map((group) => (
                <div className="mobile-navigation-group" key={group.label ?? group.items[0]?.href}>
                  {group.label ? (
                    <div className="mobile-navigation-section">{group.label}</div>
                  ) : null}
                  {group.items.map((item) => (
                    <SheetClose asChild key={item.href}>
                      <Link
                        aria-current={activeHref === item.href ? "page" : undefined}
                        className={`mobile-navigation-sheet-link ${activeHref === item.href ? "active" : ""}`}
                        href={item.href}
                      >
                        <item.icon aria-hidden="true" size={17} />
                        <span>{item.label}</span>
                      </Link>
                    </SheetClose>
                  ))}
                </div>
              ))}
            </SheetBody>
          </SheetContent>
        </Sheet>
      </nav>
    </aside>
  );
}
