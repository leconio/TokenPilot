import type { OpenApiSchema } from "../types.js";
import { SERVICE_KEY_COMPONENT_SCHEMAS } from "./service-keys.js";
import { USAGE_COMPONENT_SCHEMAS } from "./usage.js";

export const OPENAPI_COMPONENT_SCHEMAS: Readonly<Record<string, OpenApiSchema>> = {
  ...SERVICE_KEY_COMPONENT_SCHEMAS,
  ...USAGE_COMPONENT_SCHEMAS,
};
