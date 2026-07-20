import { dateTime, object, type JsonObject } from "./payload-readers.js";

const propertyTypeValues = ["TEXT", "NUMBER", "BOOLEAN", "DATETIME", "ENUM", "TEXT_LIST"] as const;
type PropertyType = (typeof propertyTypeValues)[number];

interface ScopeColumns {
  readonly text: Record<string, string>;
  readonly number: Record<string, number>;
  readonly boolean: Record<string, number>;
  readonly datetime: Record<string, string>;
  readonly enum: Record<string, string>;
  readonly textList: Record<string, readonly string[]>;
}

function propertyType(value: unknown, key: string): PropertyType {
  if (typeof value === "string" && propertyTypeValues.includes(value as PropertyType)) {
    return value as PropertyType;
  }
  throw new TypeError(`property type for ${key} is missing or invalid`);
}

function scopeColumns(valuesInput: unknown, typesInput: unknown, scope: string): ScopeColumns {
  const values = valuesInput === undefined ? {} : object(valuesInput, `${scope} properties`);
  const types = typesInput === undefined ? {} : object(typesInput, `${scope} property types`);
  const output: ScopeColumns = {
    text: {},
    number: {},
    boolean: {},
    datetime: {},
    enum: {},
    textList: {},
  };
  for (const [key, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    switch (propertyType(types[key], key)) {
      case "TEXT":
        if (typeof value !== "string") throw new TypeError(`${scope}.${key} must be text`);
        output.text[key] = value;
        break;
      case "NUMBER":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new TypeError(`${scope}.${key} must be a finite number`);
        }
        output.number[key] = value;
        break;
      case "BOOLEAN":
        if (typeof value !== "boolean") throw new TypeError(`${scope}.${key} must be boolean`);
        output.boolean[key] = Number(value);
        break;
      case "DATETIME":
        output.datetime[key] = dateTime(value, `${scope}.${key}`);
        break;
      case "ENUM":
        if (typeof value !== "string") throw new TypeError(`${scope}.${key} must be an enum`);
        output.enum[key] = value;
        break;
      case "TEXT_LIST":
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
          throw new TypeError(`${scope}.${key} must be a text list`);
        }
        output.textList[key] = value;
        break;
    }
  }
  return output;
}

function columns(prefix: "event" | "user", value: ScopeColumns): JsonObject {
  return {
    [`${prefix}_text_properties`]: value.text,
    [`${prefix}_number_properties`]: value.number,
    [`${prefix}_boolean_properties`]: value.boolean,
    [`${prefix}_datetime_properties`]: value.datetime,
    [`${prefix}_enum_properties`]: value.enum,
    [`${prefix}_text_list_properties`]: value.textList,
  };
}

export function typedPropertyColumns(payload: JsonObject, normalized: JsonObject): JsonObject {
  const propertyTypes = object(payload.property_types ?? {}, "property types");
  return {
    ...columns(
      "event",
      scopeColumns(normalized.event_properties, propertyTypes.event, "event property"),
    ),
    ...columns(
      "user",
      scopeColumns(normalized.user_properties, propertyTypes.user, "user property"),
    ),
  };
}
