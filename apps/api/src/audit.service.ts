import { Inject, Injectable, Optional } from "@nestjs/common";

import type { DatabaseClient, Prisma } from "@tokenpilot/db";

import { AuditContextService } from "./audit-context.js";
import { redactSensitiveData, redactSensitiveString } from "./security.js";
import { DATABASE_CLIENT } from "./tokens.js";

function json(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  return redactSensitiveData(serialized) as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Optional() @Inject(AuditContextService) private readonly context?: AuditContextService,
  ) {}

  async record(
    input: {
      readonly action: string;
      readonly objectType: string;
      readonly objectId: string;
      readonly before?: unknown;
      readonly after?: unknown;
      readonly reason?: string;
      readonly actorId?: string;
      readonly applicationId?: string;
      readonly ip?: string;
    },
    transaction?: Pick<DatabaseClient, "auditLog">,
  ): Promise<void> {
    const beforeJson = json(input.before);
    const afterJson = json(input.after);
    const database = transaction ?? this.database;
    const context = this.context?.current() ?? { actorId: "system" };
    await database.auditLog.create({
      data: {
        ...((input.applicationId ?? context.applicationId) === undefined
          ? {}
          : { applicationId: input.applicationId ?? context.applicationId }),
        actorId: input.actorId ?? context.actorId,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        ...(beforeJson === undefined ? {} : { beforeJson }),
        ...(afterJson === undefined ? {} : { afterJson }),
        ...(input.reason === undefined ? {} : { reason: redactSensitiveString(input.reason) }),
        ...((input.ip ?? context.ip) === undefined ? {} : { ip: input.ip ?? context.ip }),
      },
    });
  }
}
