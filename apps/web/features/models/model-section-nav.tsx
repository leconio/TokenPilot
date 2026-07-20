"use client";

import { usePathname, useRouter } from "next/navigation";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentApplicationSlug } from "@/features/applications/use-current-application";

const sections = [
  { value: "virtual-models", label: "虚拟模型" },
  { value: "models", label: "真实模型" },
  { value: "connections", label: "调用连接" },
] as const;

export function ModelSectionNav() {
  const pathname = usePathname();
  const router = useRouter();
  const applicationSlug = useCurrentApplicationSlug();
  const current =
    sections.find((section) => pathname.includes(`/${section.value}`))?.value ?? "models";

  return (
    <Tabs
      aria-label="模型配置页面"
      className="mb-5"
      value={current}
      onValueChange={(value) => router.push(`/apps/${applicationSlug}/${value}`)}
    >
      <TabsList>
        {sections.map((section) => (
          <TabsTrigger key={section.value} value={section.value}>
            {section.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
