import { createHash } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  runtimeConfigurationAcknowledgementSchema,
  type RuntimeConfigurationAcknowledgement,
} from "@tokenpilot/contracts";
import { PolicyAcknowledgementState, PublicationStatus, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { DATABASE_CLIENT } from "../tokens.js";

const states = {
  received: PolicyAcknowledgementState.RECEIVED,
  applied: PolicyAcknowledgementState.APPLIED,
  rejected: PolicyAcknowledgementState.REJECTED,
} as const;

function payloadHash(value: RuntimeConfigurationAcknowledgement): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class RuntimeConfigurationAcknowledgementService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(AuditContextService) private readonly context: AuditContextService,
  ) {}

  public async acknowledge(
    input: unknown,
  ): Promise<{ readonly status: "accepted"; readonly duplicate: boolean }> {
    const parsed = runtimeConfigurationAcknowledgementSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(
        "Body must satisfy the current Runtime Configuration Acknowledgement contract",
      );
    }
    const applicationId = this.context.current().applicationId;
    if (applicationId === undefined) throw new ForbiddenException("Application context is missing");
    const acknowledgement = parsed.data;
    if (acknowledgement.application_id !== applicationId) {
      throw new NotFoundException("The acknowledged application configuration was not found");
    }
    if (new Date(acknowledgement.acknowledged_at).getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException("acknowledged_at is too far in the future");
    }
    const hash = payloadHash(acknowledgement);
    const key = {
      applicationId_acknowledgementId: {
        applicationId,
        acknowledgementId: acknowledgement.acknowledgement_id,
      },
    } as const;
    const existing = await this.database.runtimeConfigurationAcknowledgement.findUnique({
      where: key,
      select: { payloadHash: true },
    });
    if (existing !== null) {
      if (existing.payloadHash !== hash) {
        throw new ConflictException("Acknowledgement ID was already used with another payload");
      }
      return { status: "accepted", duplicate: true };
    }
    const configuration = await this.database.runtimeConfigurationVersion.findUnique({
      where: {
        applicationId_version: {
          applicationId,
          version: acknowledgement.configuration_version,
        },
      },
      select: { etag: true, status: true },
    });
    if (
      configuration === null ||
      configuration.etag !== acknowledgement.configuration_etag ||
      (configuration.status !== PublicationStatus.PUBLISHED &&
        configuration.status !== PublicationStatus.RETIRED)
    ) {
      throw new NotFoundException("The acknowledged application configuration was not found");
    }
    try {
      await this.database.runtimeConfigurationAcknowledgement.create({
        data: {
          applicationId,
          acknowledgementId: acknowledgement.acknowledgement_id,
          connectorInstanceId: acknowledgement.connector.instance_id,
          connectorName: acknowledgement.connector.name,
          connectorVersion: acknowledgement.connector.version,
          configurationVersion: acknowledgement.configuration_version,
          configurationEtag: acknowledgement.configuration_etag,
          state: states[acknowledgement.state],
          acknowledgedAt: new Date(acknowledgement.acknowledged_at),
          appliedAt:
            acknowledgement.applied_at === null ? null : new Date(acknowledgement.applied_at),
          errorCode: acknowledgement.error?.code ?? null,
          errorMessage: acknowledgement.error?.message ?? null,
          payloadHash: hash,
        },
      });
      return { status: "accepted", duplicate: false };
    } catch (error) {
      if (!uniqueConstraint(error)) throw error;
      const raced = await this.database.runtimeConfigurationAcknowledgement.findUniqueOrThrow({
        where: key,
        select: { payloadHash: true },
      });
      if (raced.payloadHash !== hash) {
        throw new ConflictException("Acknowledgement ID was already used with another payload");
      }
      return { status: "accepted", duplicate: true };
    }
  }
}
