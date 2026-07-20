import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

import { Injectable } from "@nestjs/common";

interface AuditRequestContext {
  actorId?: string;
  ip?: string;
  applicationId?: string;
  applicationSlug?: string;
}

export function normalizeAuditIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const candidate = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  const withoutZone = candidate.split("%", 1)[0];
  return withoutZone !== undefined && isIP(withoutZone) !== 0 ? withoutZone : undefined;
}

@Injectable()
export class AuditContextService {
  private readonly storage = new AsyncLocalStorage<AuditRequestContext>();

  run<Result>(ip: string | undefined, callback: () => Result): Result {
    const normalized = normalizeAuditIp(ip);
    return this.storage.run(normalized === undefined ? {} : { ip: normalized }, callback);
  }

  setActor(actorId: string): void {
    const context = this.storage.getStore();
    if (context !== undefined) context.actorId = actorId;
  }

  setApplication(applicationId: string, applicationSlug: string): void {
    const context = this.storage.getStore();
    if (context !== undefined) {
      context.applicationId = applicationId;
      context.applicationSlug = applicationSlug;
    }
  }

  current(): Readonly<{
    actorId: string;
    ip?: string;
    applicationId?: string;
    applicationSlug?: string;
  }> {
    const context = this.storage.getStore();
    return {
      actorId: context?.actorId ?? "system",
      ...(context?.ip === undefined ? {} : { ip: context.ip }),
      ...(context?.applicationId === undefined
        ? {}
        : { applicationId: context.applicationId, applicationSlug: context.applicationSlug }),
    };
  }
}
