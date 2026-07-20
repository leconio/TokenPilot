"use client";

import { Languages } from "lucide-react";

import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useLocale } from "../i18n/locale-provider";

export function LanguageSwitcher({
  variant = "floating",
}: Readonly<{ variant?: "floating" | "toolbar" }>) {
  const { locale, setLocale, text } = useLocale();
  return (
    <div className={cn("language-switcher", `language-switcher--${variant}`)} data-locale-control>
      <Languages aria-hidden="true" size={15} />
      <Select value={locale} onValueChange={(value) => setLocale(value === "en" ? "en" : "zh-CN")}>
        <SelectTrigger aria-label={text("界面语言", "Interface language")} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" data-locale-control>
          <SelectItem value="zh-CN">中文</SelectItem>
          <SelectItem value="en">English</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
