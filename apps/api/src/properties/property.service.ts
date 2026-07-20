import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { Prisma, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  constraintsMatchType,
  createPropertySchema,
  updatePropertySchema,
} from "./property.schemas.js";

const reservedKeys = new Set([
  "application_id",
  "environment",
  "event_id",
  "event_time",
  "schema_version",
  "app_version",
  "application_version",
  "sdk_version",
  "connector_version",
  "config_version",
  "user_id",
  "display_user",
  "session_id",
  "conversation_id",
  "trace_id",
  "request_id",
  "attempt_id",
  "operation_id",
  "parent_request_id",
  "reservation_id",
  "virtual_model",
  "model_id",
  "request_model",
  "model",
  "provider",
  "route_reason",
  "fallback",
  "fallback_from",
  "status",
  "error_class",
  "http_status",
  "latency_ms",
  "input_tokens",
  "cached_input_tokens",
  "cache_read_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "provider_cost",
  "provider_cost_status",
  "aiu",
  "aiu_micros",
  "aiu_status",
  "quota_status",
  "source",
  "request",
  "user",
  "route",
  "usage",
  "result",
  "privacy",
  "source_cost",
  "analytics_dimensions",
  "event_properties",
  "user_properties",
]);

function present(row: {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly scope: string;
  readonly dataType: string;
  readonly allowedValuesJson: unknown;
  readonly searchable: boolean;
  readonly groupable: boolean;
  readonly sensitive: boolean;
  readonly constraintsJson: unknown;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: row.id,
    key: row.key,
    display_name: row.displayName,
    scope: row.scope,
    data_type: row.dataType,
    allowed_values: row.allowedValuesJson,
    searchable: row.searchable,
    groupable: row.groupable,
    sensitive: row.sensitive,
    constraints: row.constraintsJson,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class PropertyService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private applicationId(): string {
    const id = this.context.current().applicationId;
    if (id === undefined) throw new ForbiddenException("An application context is required");
    return id;
  }

  async list() {
    const rows = await this.database.propertyDefinition.findMany({
      where: { applicationId: this.applicationId() },
      orderBy: [{ status: "asc" }, { scope: "asc" }, { displayName: "asc" }],
    });
    return { properties: rows.map(present) };
  }

  async create(input: unknown) {
    const parsed = createPropertySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid field definition");
    if (reservedKeys.has(parsed.data.key)) {
      throw new BadRequestException("This key is already provided as a built-in field");
    }
    const value = parsed.data;
    try {
      const row = await this.database.propertyDefinition.create({
        data: {
          applicationId: this.applicationId(),
          key: value.key,
          displayName: value.display_name,
          scope: value.scope,
          dataType: value.data_type,
          allowedValuesJson:
            value.data_type === "ENUM" ? (value.allowed_values ?? []) : Prisma.JsonNull,
          searchable: value.sensitive === true ? false : (value.searchable ?? true),
          groupable: value.sensitive === true ? false : (value.groupable ?? false),
          sensitive: value.sensitive ?? false,
          constraintsJson: value.constraints ?? {},
        },
      });
      await this.audit.record({
        action: "property.create",
        objectType: "property",
        objectId: row.id,
        after: { key: row.key, scope: row.scope, data_type: row.dataType },
        reason: "Created custom field",
      });
      return present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This field key already exists in the application");
      }
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const parsed = updatePropertySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid field changes");
    const current = await this.database.propertyDefinition.findFirst({
      where: { id, applicationId: this.applicationId() },
    });
    if (current === null) throw new NotFoundException("Field not found");
    if (parsed.data.allowed_values !== undefined && current.dataType !== "ENUM") {
      throw new BadRequestException("Allowed values are only available for enum fields");
    }
    if (
      parsed.data.constraints !== undefined &&
      !constraintsMatchType(current.dataType, parsed.data.constraints)
    ) {
      throw new BadRequestException("These limits do not match the field type");
    }
    const value = parsed.data;
    const nextSensitive = value.sensitive ?? current.sensitive;
    if (value.groupable === true && current.dataType === "TEXT_LIST") {
      throw new BadRequestException("Text-list fields cannot be used for grouping");
    }
    const row = await this.database.propertyDefinition.update({
      where: { id: current.id },
      data: {
        ...(value.display_name === undefined ? {} : { displayName: value.display_name }),
        ...(value.allowed_values === undefined ? {} : { allowedValuesJson: value.allowed_values }),
        ...(value.constraints === undefined ? {} : { constraintsJson: value.constraints }),
        ...(nextSensitive
          ? { searchable: false }
          : value.searchable === undefined
            ? {}
            : { searchable: value.searchable }),
        ...(nextSensitive
          ? { groupable: false }
          : value.groupable === undefined
            ? {}
            : { groupable: value.groupable }),
        ...(value.sensitive === undefined ? {} : { sensitive: value.sensitive }),
        ...(value.status === undefined ? {} : { status: value.status }),
      },
    });
    await this.audit.record({
      action: "property.update",
      objectType: "property",
      objectId: row.id,
      before: { display_name: current.displayName, status: current.status },
      after: { display_name: row.displayName, status: row.status },
      reason: "Updated custom field",
    });
    return present(row);
  }
}
