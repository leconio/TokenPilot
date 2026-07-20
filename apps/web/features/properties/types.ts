export type PropertyScope = "EVENT" | "USER";
export type PropertyType = "TEXT" | "NUMBER" | "BOOLEAN" | "DATETIME" | "ENUM" | "TEXT_LIST";

export interface PropertyDefinition {
  readonly id: string;
  readonly key: string;
  readonly display_name: string;
  readonly scope: PropertyScope;
  readonly data_type: PropertyType;
  readonly allowed_values: readonly string[] | null;
  readonly searchable: boolean;
  readonly groupable: boolean;
  readonly sensitive: boolean;
  readonly status: "ACTIVE" | "DISABLED";
}

export interface PropertyList {
  readonly properties: readonly PropertyDefinition[];
}

export const propertyTypeLabels: Readonly<Record<PropertyType, string>> = {
  TEXT: "文本",
  NUMBER: "数字",
  BOOLEAN: "是 / 否",
  DATETIME: "日期时间",
  ENUM: "固定选项",
  TEXT_LIST: "文本列表",
};
