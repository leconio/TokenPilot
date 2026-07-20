"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ComboboxOption } from "@/components/ui/combobox";
import {
  applicationApiPath,
  useCurrentApplicationSlug,
} from "@/features/applications/use-current-application";
import { controlGetAllPages, normalizePage } from "../api/client";
import { useControlQuery } from "../api/hooks";
import {
  builtInAnalysisFields,
  builtInAnalysisGroups,
  type AnalysisDataType,
  type AnalysisFieldDefinition,
  type AnalysisGroup,
  type AnalysisKind,
  type AnalysisOperator,
} from "./analysis-config";

type ResourceRow = Readonly<Record<string, unknown>>;

interface PropertyDefinition {
  readonly key: string;
  readonly display_name: string;
  readonly scope: "EVENT" | "USER";
  readonly data_type: AnalysisDataType;
  readonly allowed_values: readonly string[] | null;
  readonly searchable: boolean;
  readonly groupable: boolean;
  readonly sensitive: boolean;
  readonly status: "ACTIVE" | "DISABLED";
}

interface PropertyList {
  readonly properties: readonly PropertyDefinition[];
}

const statusOptions: readonly ComboboxOption[] = [
  { value: "success", label: "成功" },
  { value: "failure", label: "失败" },
  { value: "timeout", label: "超时" },
  { value: "cancelled", label: "已取消" },
  { value: "unknown", label: "未知" },
];
const costStatusOptions: readonly ComboboxOption[] = [
  { value: "official", label: "已计算" },
  { value: "unpriced", label: "尚未配置成本" },
  { value: "invalid_usage", label: "用量信息不完整" },
];
const aiuStatusOptions: readonly ComboboxOption[] = [
  { value: "official", label: "已计算" },
  { value: "unrated", label: "尚未计算" },
  { value: "invalid_usage", label: "用量信息不完整" },
];
const connectionDriverOptions: readonly ComboboxOption[] = [
  { value: "litellm", label: "LiteLLM" },
  { value: "openai_compatible", label: "OpenAI 兼容接口" },
  { value: "anthropic", label: "Anthropic 接口" },
];

const propertyOperators: Readonly<Record<AnalysisDataType, readonly AnalysisOperator[]>> = {
  TEXT: ["equals", "not_equals", "contains", "starts_with", "is_set", "is_not_set"],
  NUMBER: [
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ],
  BOOLEAN: ["equals", "is_set", "is_not_set"],
  DATETIME: [
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ],
  ENUM: ["equals", "not_equals", "one_of", "is_set", "is_not_set"],
  TEXT_LIST: ["contains_any", "contains_all", "is_set", "is_not_set"],
};

function text(row: ResourceRow, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function distinct(options: readonly ComboboxOption[]): readonly ComboboxOption[] {
  return [...new Map(options.map((option) => [option.value, option])).values()].sort(
    (left, right) => left.label.localeCompare(right.label, "zh-CN"),
  );
}

export function useAnalysisCatalog(kind: AnalysisKind): Readonly<{
  fields: readonly AnalysisFieldDefinition[];
  propertyFields: readonly AnalysisFieldDefinition[];
  groups: readonly AnalysisGroup[];
}> {
  const applicationSlug = useCurrentApplicationSlug();
  const properties = useControlQuery<PropertyList>(
    ["analysis-properties", applicationSlug],
    applicationApiPath(applicationSlug, "/properties"),
    undefined,
    { retry: false },
  );
  return useMemo(() => {
    const active = (properties.data?.properties ?? []).filter(
      (property) => property.status === "ACTIVE",
    );
    const propertyField = (property: PropertyDefinition): AnalysisFieldDefinition => ({
      id: `property:${property.scope.toLowerCase()}:${property.key}`,
      kind: "property",
      scope: property.scope.toLowerCase() as "event" | "user",
      key: property.key,
      label: property.display_name,
      placeholder: `输入${property.display_name}`,
      data_type: property.data_type,
      operators: propertyOperators[property.data_type],
      ...(property.allowed_values === null ? {} : { allowed_values: property.allowed_values }),
      allow_custom_value: property.data_type === "TEXT",
      ...(property.sensitive ? { sensitive: true } : {}),
      searchable: property.searchable,
    });
    const propertyFields = active.map(propertyField);
    const searchablePropertyFields = active
      .filter((property) => property.searchable && !property.sensitive)
      .map(propertyField);
    const propertyGroups = active
      .filter(
        (property) =>
          property.groupable && !property.sensitive && property.data_type !== "TEXT_LIST",
      )
      .map((property): AnalysisGroup => ({
        kind: "property",
        scope: property.scope.toLowerCase() as "event" | "user",
        key: property.key,
        label: property.display_name,
      }));
    return {
      fields: [...builtInAnalysisFields(kind), ...searchablePropertyFields],
      propertyFields,
      groups: [...builtInAnalysisGroups, ...propertyGroups],
    };
  }, [kind, properties.data]);
}

export function useAnalysisOptions(activeFieldIds: ReadonlySet<string>) {
  const applicationSlug = useCurrentApplicationSlug();
  const usersPath = applicationApiPath(applicationSlug, "/users") ?? "";
  const needsUsers =
    activeFieldIds.has("builtin:user_id") ||
    activeFieldIds.has("builtin:display_user") ||
    activeFieldIds.has("builtin:user_tag");
  const models = useControlQuery<unknown>(
    ["analysis-options", applicationSlug, "models"],
    activeFieldIds.has("builtin:model_id") ||
      activeFieldIds.has("builtin:request_model") ||
      activeFieldIds.has("builtin:provider")
      ? applicationApiPath(applicationSlug, "/models")
      : null,
  );
  const connections = useControlQuery<unknown>(
    ["analysis-options", applicationSlug, "connections"],
    activeFieldIds.has("builtin:connection_id")
      ? applicationApiPath(applicationSlug, "/connections")
      : null,
  );
  const virtualModels = useControlQuery<unknown>(
    ["analysis-options", applicationSlug, "virtual-models"],
    activeFieldIds.has("builtin:virtual_model")
      ? applicationApiPath(applicationSlug, "/virtual-models")
      : null,
  );
  const users = useQuery({
    queryKey: ["analysis-options", applicationSlug, "users", "all"],
    queryFn: () => controlGetAllPages<ResourceRow>(usersPath, {}, ["users"]),
    enabled: needsUsers && usersPath.length > 0,
  });
  const userGroups = useControlQuery<unknown>(
    ["analysis-options", applicationSlug, "user-groups"],
    activeFieldIds.has("builtin:user_group")
      ? applicationApiPath(applicationSlug, "/user-groups")
      : null,
  );

  return useMemo(() => {
    const modelRows = normalizePage<ResourceRow>(models.data, ["models"]).items;
    const virtualRows = normalizePage<ResourceRow>(virtualModels.data, ["virtual_models"]).items;
    const userRows = normalizePage<ResourceRow>(users.data, ["users"]).items;
    const userGroupRows = normalizePage<ResourceRow>(userGroups.data, ["user_groups"]).items;
    const modelOptions = modelRows.flatMap((row) => {
      const value = text(row, "requestModel", "request_model");
      return value
        ? [{ value, label: text(row, "displayName", "display_name") ?? value, keywords: value }]
        : [];
    });
    const modelIdOptions = modelRows.flatMap((row) => {
      const value = text(row, "id");
      return value
        ? [{ value, label: text(row, "displayName", "display_name", "name") ?? value }]
        : [];
    });
    const connectionRows = normalizePage<ResourceRow>(connections.data, ["connections"]).items;
    const connectionOptions = connectionRows.flatMap((row) => {
      const value = text(row, "id");
      return value ? [{ value, label: text(row, "name") ?? value }] : [];
    });
    const virtualOptions = virtualRows.flatMap((row) => {
      const value = text(row, "stableName", "stable_name");
      return value ? [{ value, label: text(row, "displayName", "display_name") ?? value }] : [];
    });
    const providerOptions = modelRows.flatMap((row) => {
      const provider = text(row, "provider");
      return provider ? [{ value: provider, label: provider }] : [];
    });
    const userOptions = userRows.flatMap((row) => {
      const value = text(row, "user_id", "externalId", "external_id");
      return value
        ? [{ value, label: text(row, "display_user", "name") ?? value, keywords: value }]
        : [];
    });
    const displayOptions = userRows.flatMap((row) => {
      const value = text(row, "display_user", "name");
      return value ? [{ value, label: value }] : [];
    });
    const userTagOptions = userRows.flatMap((row) => {
      const values = row.tags;
      return Array.isArray(values)
        ? values.flatMap((value) => (typeof value === "string" ? [{ value, label: value }] : []))
        : [];
    });
    const userGroupOptions = userGroupRows.flatMap((row) => {
      const value = text(row, "id");
      return value ? [{ value, label: text(row, "name") ?? value }] : [];
    });
    return {
      "builtin:model_id": distinct(modelIdOptions),
      "builtin:request_model": distinct(modelOptions),
      "builtin:virtual_model": distinct(virtualOptions),
      "builtin:connection_id": distinct(connectionOptions),
      "builtin:connection_driver": connectionDriverOptions,
      "builtin:provider": distinct(providerOptions),
      "builtin:user_id": distinct(userOptions),
      "builtin:display_user": distinct(displayOptions),
      "builtin:user_tag": distinct(userTagOptions),
      "builtin:user_group": distinct(userGroupOptions),
      "builtin:status": statusOptions,
      "builtin:cost_status": costStatusOptions,
      "builtin:aiu_status": aiuStatusOptions,
    } satisfies Readonly<Record<string, readonly ComboboxOption[]>>;
  }, [connections.data, models.data, userGroups.data, users.data, virtualModels.data]);
}

export function useUserLabelMap(enabled: boolean): ReadonlyMap<string, string> {
  const applicationSlug = useCurrentApplicationSlug();
  const usersPath = applicationApiPath(applicationSlug, "/users") ?? "";
  const users = useQuery({
    queryKey: ["analysis-options", applicationSlug, "user-labels", "all"],
    queryFn: () => controlGetAllPages<ResourceRow>(usersPath, {}, ["users"]),
    enabled: enabled && usersPath.length > 0,
  });
  return useMemo(() => {
    const rows = normalizePage<ResourceRow>(users.data, ["users"]).items;
    return new Map(
      rows.flatMap((row) => {
        const id = text(row, "user_id", "externalId", "external_id");
        return id === undefined ? [] : ([[id, text(row, "display_user", "name") ?? id]] as const);
      }),
    );
  }, [users.data]);
}
