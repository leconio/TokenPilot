import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
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

export interface UserAdvancedFilterValues {
  readonly minCalls: string;
  readonly minTokens: string;
  readonly minAiu: string;
  readonly propertyKey: string;
  readonly propertyValue: string;
  readonly propertyDataType: string;
}

const emptyProperty = { propertyKey: "", propertyValue: "", propertyDataType: "" } as const;

function PropertyValue({
  property,
  value,
  onChange,
}: {
  readonly property: PropertyDefinition | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  if (property?.data_type === "BOOLEAN") {
    return (
      <Select
        value={value || "none"}
        onValueChange={(next) => onChange(next === "none" ? "" : next)}
      >
        <SelectTrigger id="user-property-value">
          <SelectValue placeholder="选择值" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">不限</SelectItem>
          <SelectItem value="true">是</SelectItem>
          <SelectItem value="false">否</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (property?.data_type === "ENUM") {
    return (
      <Select
        value={value || "none"}
        onValueChange={(next) => onChange(next === "none" ? "" : next)}
      >
        <SelectTrigger id="user-property-value">
          <SelectValue placeholder="选择值" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">不限</SelectItem>
          {(property.allowed_values ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      id="user-property-value"
      type={
        property?.data_type === "NUMBER"
          ? "number"
          : property?.data_type === "DATETIME"
            ? "datetime-local"
            : "text"
      }
      step={property?.data_type === "NUMBER" ? "any" : undefined}
      placeholder={property === undefined ? "先选择字段" : "输入值"}
      disabled={property === undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function UserAdvancedFilters({
  value,
  properties,
  onChange,
}: {
  readonly value: UserAdvancedFilterValues;
  readonly properties: readonly PropertyDefinition[];
  readonly onChange: (value: UserAdvancedFilterValues) => void;
}) {
  const available = properties.filter(
    (property) =>
      property.scope === "USER" &&
      property.status === "ACTIVE" &&
      property.searchable &&
      !property.sensitive,
  );
  const selected = available.find((property) => property.key === value.propertyKey);
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button className="w-fit" type="button" size="sm" variant="ghost">
          更多筛选
          <ChevronDown />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="grid gap-1.5">
          <Label htmlFor="minimum-user-calls">至少调用</Label>
          <Input
            id="minimum-user-calls"
            type="number"
            min="0"
            step="1"
            placeholder="不限"
            value={value.minCalls}
            onChange={(event) => onChange({ ...value, minCalls: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="minimum-user-tokens">至少 Token</Label>
          <Input
            id="minimum-user-tokens"
            type="number"
            min="0"
            step="any"
            placeholder="不限"
            value={value.minTokens}
            onChange={(event) => onChange({ ...value, minTokens: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="minimum-user-aiu">至少 AIU</Label>
          <Input
            id="minimum-user-aiu"
            type="number"
            min="0"
            step="0.000001"
            placeholder="不限"
            value={value.minAiu}
            onChange={(event) => onChange({ ...value, minAiu: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="user-property">用户字段</Label>
          <Select
            value={value.propertyKey || "none"}
            onValueChange={(key) => {
              if (key === "none") return onChange({ ...value, ...emptyProperty });
              const property = available.find((item) => item.key === key);
              onChange({
                ...value,
                propertyKey: key,
                propertyValue: "",
                propertyDataType: property?.data_type ?? "",
              });
            }}
          >
            <SelectTrigger id="user-property">
              <SelectValue placeholder="选择字段" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不限</SelectItem>
              {available.map((property) => (
                <SelectItem key={property.id} value={property.key}>
                  <span data-i18n-skip>{property.display_name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="user-property-value">字段值</Label>
          <PropertyValue
            property={selected}
            value={value.propertyValue}
            onChange={(propertyValue) => onChange({ ...value, propertyValue })}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
