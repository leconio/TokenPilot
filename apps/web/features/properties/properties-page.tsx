"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type DataColumn } from "@/features/shared/components/data-table";
import { PageHeading } from "@/features/shared/components/page-heading";
import { PageState } from "@/features/shared/components/page-state";
import { StatusBadge } from "@/features/shared/components/status-badge";
import { controlApi } from "@/lib/api";
import {
  propertyTypeLabels,
  type PropertyDefinition,
  type PropertyList,
  type PropertyScope,
  type PropertyType,
} from "./types";

export function PropertiesPage() {
  const pathname = usePathname();
  const applicationSlug = /^\/apps\/([^/]+)/u.exec(pathname)?.[1] ?? "";
  const path = `/applications/${applicationSlug}/properties`;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [scope, setScope] = useState<PropertyScope>("EVENT");
  const [dataType, setDataType] = useState<PropertyType>("TEXT");
  const [choices, setChoices] = useState("");
  const [groupable, setGroupable] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [confirmHighCardinality, setConfirmHighCardinality] = useState(false);
  const [maxLength, setMaxLength] = useState("");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [maxItems, setMaxItems] = useState("");
  const properties = useQuery({
    queryKey: ["properties", applicationSlug],
    queryFn: () => controlApi<PropertyList>(path),
    enabled: applicationSlug.length > 0,
  });
  const create = useMutation({
    mutationFn: () =>
      controlApi<PropertyDefinition>(path, {
        method: "POST",
        body: JSON.stringify({
          key,
          display_name: displayName,
          scope,
          data_type: dataType,
          searchable: true,
          groupable,
          sensitive,
          confirm_high_cardinality: confirmHighCardinality,
          constraints: {
            ...(maxLength ? { max_length: Number(maxLength) } : {}),
            ...(minimum ? { min: Number(minimum) } : {}),
            ...(maximum ? { max: Number(maximum) } : {}),
            ...(maxItems ? { max_items: Number(maxItems) } : {}),
          },
          ...(dataType === "ENUM"
            ? {
                allowed_values: choices
                  .split(",")
                  .map((choice) => choice.trim())
                  .filter(Boolean),
              }
            : {}),
        }),
      }),
    onSuccess: async () => {
      setCreating(false);
      setDisplayName("");
      setKey("");
      setScope("EVENT");
      setDataType("TEXT");
      setChoices("");
      setGroupable(false);
      setSensitive(false);
      setConfirmHighCardinality(false);
      setMaxLength("");
      setMinimum("");
      setMaximum("");
      setMaxItems("");
      await client.invalidateQueries({ queryKey: ["properties", applicationSlug] });
    },
  });
  const toggle = useMutation({
    mutationFn: (property: PropertyDefinition) =>
      controlApi<PropertyDefinition>(`${path}/${property.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: property.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["properties", applicationSlug] });
    },
  });
  const columns: DataColumn<PropertyDefinition>[] = [
    {
      key: "name",
      label: "字段",
      cell: (property) => (
        <div>
          <strong data-i18n-skip>{property.display_name}</strong>
          <div className="text-xs text-muted-foreground">{property.key}</div>
        </div>
      ),
    },
    {
      key: "scope",
      label: "用于",
      cell: (property) => (property.scope === "USER" ? "用户" : "事件"),
    },
    { key: "type", label: "类型", cell: (property) => propertyTypeLabels[property.data_type] },
    {
      key: "analysis",
      label: "可用于",
      cell: (property) =>
        [
          property.searchable ? "筛选" : null,
          property.groupable ? "分组" : null,
          property.sensitive ? "敏感" : null,
        ]
          .filter(Boolean)
          .join("、") || "仅详情",
    },
    {
      key: "status",
      label: "状态",
      cell: (property) => (
        <StatusBadge value={property.status === "ACTIVE" ? "enabled" : "disabled"} />
      ),
    },
    {
      key: "actions",
      label: "",
      cell: (property) => (
        <Button
          size="sm"
          variant="outline"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(property)}
        >
          {property.status === "ACTIVE" ? "停用" : "启用"}
        </Button>
      ),
    },
  ];
  const enumChoicesValid =
    dataType !== "ENUM" || choices.split(",").some((choice) => choice.trim().length > 0);
  const highCardinalityRisk = groupable && ["TEXT", "DATETIME", "TEXT_LIST"].includes(dataType);

  return (
    <main className="page">
      <PageHeading
        title="自定义字段"
        description="定义上报的数据类型；时间、版本、用户和模型等常用字段已经内置。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            添加字段
          </Button>
        }
      />
      {properties.isPending ? (
        <PageState state="loading" />
      ) : properties.error ? (
        <PageState
          state="error"
          message={properties.error.message}
          onRetry={() => properties.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          emptyMessage="目前只使用内置字段。需要额外数据时再添加。"
          rows={[...(properties.data?.properties ?? [])]}
        />
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加自定义字段</DialogTitle>
            <DialogDescription>
              名称给人看，字段标识用于程序上报，创建后不可修改。
            </DialogDescription>
          </DialogHeader>
          <div className="form-grid">
            <div className="field">
              <Label htmlFor="property-name">名称</Label>
              <Input
                id="property-name"
                placeholder="下一步操作"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="field">
              <Label htmlFor="property-key">字段标识</Label>
              <Input
                id="property-key"
                placeholder="next_action"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <div className="field">
              <Label>用于</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as PropertyScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EVENT">每次调用</SelectItem>
                  <SelectItem value="USER">用户资料</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="field">
              <Label>类型</Label>
              <Select
                value={dataType}
                onValueChange={(value) => {
                  setDataType(value as PropertyType);
                  setMaxLength("");
                  setMinimum("");
                  setMaximum("");
                  setMaxItems("");
                  setConfirmHighCardinality(false);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(propertyTypeLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {dataType === "ENUM" ? (
              <div className="field">
                <Label htmlFor="property-choices">可选内容</Label>
                <Input
                  id="property-choices"
                  placeholder="搜索, 购买, 其他"
                  value={choices}
                  onChange={(event) => setChoices(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-3 rounded-lg border p-3">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={groupable}
                  onCheckedChange={(checked) => setGroupable(checked === true)}
                />
                <span>
                  <strong className="block">可用于分组</strong>
                  <span className="text-muted-foreground">例如按会员等级或调用场景查看统计。</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={sensitive}
                  onCheckedChange={(checked) => setSensitive(checked === true)}
                />
                <span>
                  <strong className="block">包含敏感信息</strong>
                  <span className="text-muted-foreground">详情和导出会按权限隐藏内容。</span>
                </span>
              </label>
              {highCardinalityRisk ? (
                <label className="flex items-start gap-2 text-sm text-amber-700">
                  <Checkbox
                    checked={confirmHighCardinality}
                    onCheckedChange={(checked) => setConfirmHighCardinality(checked === true)}
                  />
                  <span>我确认这个字段可能产生很多分组，查询会更慢。</span>
                </label>
              ) : null}
            </div>
            {dataType === "TEXT" || dataType === "NUMBER" || dataType === "TEXT_LIST" ? (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost">
                    更多限制
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                  {dataType === "TEXT" || dataType === "TEXT_LIST" ? (
                    <div className="field">
                      <Label htmlFor="property-max-length">
                        {dataType === "TEXT_LIST" ? "每项最长字符" : "最长字符"}
                      </Label>
                      <Input
                        id="property-max-length"
                        inputMode="numeric"
                        placeholder="不额外限制"
                        value={maxLength}
                        onChange={(event) => setMaxLength(event.target.value)}
                      />
                    </div>
                  ) : null}
                  {dataType === "TEXT_LIST" ? (
                    <div className="field">
                      <Label htmlFor="property-max-items">最多几项</Label>
                      <Input
                        id="property-max-items"
                        inputMode="numeric"
                        placeholder="最多 32 项"
                        value={maxItems}
                        onChange={(event) => setMaxItems(event.target.value)}
                      />
                    </div>
                  ) : null}
                  {dataType === "NUMBER" ? (
                    <>
                      <div className="field">
                        <Label htmlFor="property-minimum">最小值</Label>
                        <Input
                          id="property-minimum"
                          inputMode="decimal"
                          placeholder="不限制"
                          value={minimum}
                          onChange={(event) => setMinimum(event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <Label htmlFor="property-maximum">最大值</Label>
                        <Input
                          id="property-maximum"
                          inputMode="decimal"
                          placeholder="不限制"
                          value={maximum}
                          onChange={(event) => setMaximum(event.target.value)}
                        />
                      </div>
                    </>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {create.error ? (
              <p className="text-sm text-destructive">{create.error.message}</p>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={
                displayName.trim().length === 0 ||
                key.trim().length === 0 ||
                !enumChoicesValid ||
                (highCardinalityRisk && !confirmHighCardinality) ||
                create.isPending
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? "正在添加…" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
