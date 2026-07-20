import type { OperationContract } from "../types.js";
import { CATALOG_OPERATION_CONTRACTS } from "./catalog.js";
import { INGESTION_OPERATION_CONTRACTS } from "./ingestion.js";
import { PLATFORM_OPERATION_CONTRACTS } from "./platform.js";
import { SERVICE_KEY_OPERATION_CONTRACTS } from "./service-keys.js";
import { USAGE_OPERATION_CONTRACTS } from "./usage.js";
import { USER_OPERATION_CONTRACTS } from "./users.js";
import { WEB_OPERATION_CONTRACTS } from "./web.js";

export const OPENAPI_OPERATION_CONTRACTS: Readonly<Record<string, OperationContract>> = {
  ...INGESTION_OPERATION_CONTRACTS,
  ...CATALOG_OPERATION_CONTRACTS,
  ...SERVICE_KEY_OPERATION_CONTRACTS,
  ...USAGE_OPERATION_CONTRACTS,
  ...USER_OPERATION_CONTRACTS,
  ...WEB_OPERATION_CONTRACTS,
  ...PLATFORM_OPERATION_CONTRACTS,
};
