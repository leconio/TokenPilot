"use client";

import { Filter, RotateCcw, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PropertyDefinition } from "@/features/properties/types";
import { UserAdvancedFilters, type UserAdvancedFilterValues } from "./user-advanced-filters";

interface UserFilterGroup {
  readonly id: string;
  readonly name: string;
  readonly latest_evaluation_id: string | null;
}

interface UserFiltersProps {
  readonly search: string;
  readonly tag: string;
  readonly status: string;
  readonly groupId: string;
  readonly groups: readonly UserFilterGroup[];
  readonly advanced: UserAdvancedFilterValues;
  readonly properties: readonly PropertyDefinition[];
  readonly onSearchChange: (value: string) => void;
  readonly onTagChange: (value: string) => void;
  readonly onStatusChange: (value: string) => void;
  readonly onGroupChange: (value: string) => void;
  readonly onAdvancedChange: (value: UserAdvancedFilterValues) => void;
  readonly onSubmit: () => void;
  readonly onReset: () => void;
}

export function UserFilters({
  search,
  tag,
  status,
  groupId,
  groups,
  advanced,
  properties,
  onSearchChange,
  onTagChange,
  onStatusChange,
  onGroupChange,
  onAdvancedChange,
  onSubmit,
  onReset,
}: UserFiltersProps) {
  const [open, setOpen] = useState(false);
  const advancedCount = [
    advanced.minCalls,
    advanced.minTokens,
    advanced.minAiu,
    advanced.propertyKey,
    advanced.propertyValue,
  ].filter((value) => value.length > 0).length;
  const activeCount =
    Number(tag.trim().length > 0) +
    Number(status !== "all") +
    Number(groupId !== "all") +
    advancedCount;
  return (
    <Card size="sm">
      <CardContent>
        <Collapsible open={open} onOpenChange={setOpen}>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="flex min-w-0 flex-wrap gap-2">
              <div className="relative min-w-[12rem] flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
                />
                <Input
                  className="pl-9"
                  aria-label="搜索用户"
                  placeholder="用户 ID、用户名或标签"
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                />
              </div>
              <CollapsibleTrigger asChild>
                <Button aria-expanded={open} type="button" variant="outline">
                  <Filter />
                  筛选
                  {activeCount > 0 ? (
                    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                      {activeCount}
                    </span>
                  ) : null}
                </Button>
              </CollapsibleTrigger>
              <Button type="submit">搜索</Button>
            </div>
            <CollapsibleContent className="grid gap-3 rounded-lg border bg-muted/25 p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="user-tag-filter">用户标签</Label>
                  <Input
                    id="user-tag-filter"
                    aria-label="用户标签"
                    placeholder="例如 paid"
                    value={tag}
                    onChange={(event) => onTagChange(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="user-status-filter">调用状态</Label>
                  <Select value={status} onValueChange={onStatusChange}>
                    <SelectTrigger id="user-status-filter" aria-label="调用状态">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="active">正常</SelectItem>
                      <SelectItem value="blocked">已停止</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="user-group-filter">用户组</Label>
                  <Select value={groupId} onValueChange={onGroupChange}>
                    <SelectTrigger id="user-group-filter" aria-label="用户组">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部用户组</SelectItem>
                      {groups.map((group) => (
                        <SelectItem
                          disabled={group.latest_evaluation_id === null}
                          key={group.id}
                          value={group.id}
                        >
                          <span data-i18n-skip>{group.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <UserAdvancedFilters
                value={advanced}
                properties={properties}
                onChange={onAdvancedChange}
              />
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="ghost" onClick={onReset}>
                  <RotateCcw />
                  清空筛选
                </Button>
              </div>
            </CollapsibleContent>
          </form>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
