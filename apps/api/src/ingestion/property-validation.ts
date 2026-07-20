import type { UsageEvent } from "@tokenpilot/contracts";
import type { PropertyDataType, PropertyScope } from "@tokenpilot/db";

export interface PropertyDefinitionForValidation {
  readonly key: string;
  readonly scope: PropertyScope;
  readonly dataType: PropertyDataType;
  readonly allowedValuesJson: unknown;
  readonly constraintsJson?: unknown;
}

interface PropertyConstraints {
  readonly max_length?: number;
  readonly min?: number;
  readonly max?: number;
  readonly max_items?: number;
}

function constraints(value: unknown): PropertyConstraints {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PropertyConstraints)
    : {};
}

function valueMatches(definition: PropertyDefinitionForValidation, value: unknown): boolean {
  const limit = constraints(definition.constraintsJson);
  switch (definition.dataType) {
    case "TEXT":
      return (
        typeof value === "string" &&
        (limit.max_length === undefined || value.length <= limit.max_length)
      );
    case "NUMBER":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (limit.min === undefined || value >= limit.min) &&
        (limit.max === undefined || value <= limit.max)
      );
    case "BOOLEAN":
      return typeof value === "boolean";
    case "DATETIME":
      return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
    case "ENUM":
      return (
        typeof value === "string" &&
        Array.isArray(definition.allowedValuesJson) &&
        definition.allowedValuesJson.includes(value)
      );
    case "TEXT_LIST":
      return (
        Array.isArray(value) &&
        (limit.max_items === undefined || value.length <= limit.max_items) &&
        value.every(
          (item) =>
            typeof item === "string" &&
            (limit.max_length === undefined || item.length <= limit.max_length),
        )
      );
  }
}

function validateScope(
  scope: PropertyScope,
  values: Readonly<Record<string, unknown>> | undefined,
  definitions: ReadonlyMap<string, PropertyDefinitionForValidation>,
): string | null {
  for (const [key, value] of Object.entries(values ?? {})) {
    const definition = definitions.get(`${scope}:${key}`);
    if (definition === undefined) return `${scope.toLowerCase()} property ${key} is not defined`;
    if (!valueMatches(definition, value)) {
      return `${scope.toLowerCase()} property ${key} does not match ${definition.dataType.toLowerCase()}`;
    }
  }
  return null;
}

export function validateEventProperties(
  event: UsageEvent,
  definitions: readonly PropertyDefinitionForValidation[],
): string | null {
  const indexed = new Map(
    definitions.map((definition) => [`${definition.scope}:${definition.key}`, definition]),
  );
  return (
    validateScope("EVENT", event.event_properties, indexed) ??
    validateScope("USER", event.user_properties, indexed)
  );
}
