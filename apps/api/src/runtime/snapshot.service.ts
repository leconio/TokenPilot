import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";

import type { RuntimeSnapshot } from "@tokenpilot/contracts";
import { PublicationStatus, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { verifyRuntimeSnapshot } from "../runtime-configuration/runtime-snapshot-integrity.js";
import { DATABASE_CLIENT } from "../tokens.js";

function includesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((raw) => {
    let candidate = raw.trim();
    if (candidate === "*") return true;
    if (candidate.startsWith("W/")) candidate = candidate.slice(2);
    if (candidate.startsWith('"') && candidate.endsWith('"')) candidate = candidate.slice(1, -1);
    return candidate === etag;
  });
}

export interface RuntimeSnapshotResult {
  readonly snapshot: RuntimeSnapshot;
  readonly notModified: boolean;
}

@Injectable()
export class RuntimeSnapshotService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  public async get(ifNoneMatch?: string): Promise<RuntimeSnapshotResult> {
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) throw new NotFoundException("Application context is missing");
    const row = await this.database.runtimeConfigurationVersion.findFirst({
      where: { applicationId, status: PublicationStatus.PUBLISHED },
      orderBy: { version: "desc" },
      select: { applicationId: true, etag: true, signature: true, snapshotJson: true },
    });
    if (row === null) throw new NotFoundException("No configuration has been published");
    let snapshot: RuntimeSnapshot;
    try {
      snapshot = verifyRuntimeSnapshot(row.snapshotJson);
    } catch {
      throw new ServiceUnavailableException("The published configuration failed integrity checks");
    }
    if (
      row.applicationId !== applicationId ||
      snapshot.application_id !== applicationId ||
      row.etag !== snapshot.etag ||
      row.signature !== snapshot.signature
    ) {
      throw new ServiceUnavailableException("The published configuration binding is invalid");
    }
    return { snapshot, notModified: includesEtag(ifNoneMatch, snapshot.etag) };
  }
}
