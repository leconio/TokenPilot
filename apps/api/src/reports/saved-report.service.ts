import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { Prisma, SavedReportKind, type DatabaseClient } from "@tokenpilot/db";

import { AuditContextService } from "../audit-context.js";
import { AuditService } from "../audit.service.js";
import { DATABASE_CLIENT } from "../tokens.js";
import {
  createDashboardCardSchema,
  createSavedReportSchema,
  savedReportDefinitionSchema,
  updateDashboardCardSchema,
  updateSavedReportSchema,
  type SavedReportDefinition,
} from "./saved-report.schemas.js";

type SavedRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: SavedReportKind;
  readonly definitionJson: unknown;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

async function assertDefinitionFieldsAvailable(
  database: DatabaseClient,
  applicationId: string,
  definition: SavedReportDefinition,
): Promise<void> {
  const conditions = definition.conditions.filter((condition) => condition.kind === "property");
  const group = definition.group.kind === "property" ? definition.group : null;
  const keys = [...conditions.map((condition) => condition.key), ...(group ? [group.key] : [])];
  if (keys.length === 0) return;
  const rows = await database.propertyDefinition.findMany({
    where: { applicationId, status: "ACTIVE", key: { in: [...new Set(keys)] } },
    select: {
      key: true,
      scope: true,
      searchable: true,
      groupable: true,
      sensitive: true,
      dataType: true,
    },
  });
  const indexed = new Map(
    rows.map((row) => [`${row.scope.toLowerCase()}:${row.key}`, row] as const),
  );
  for (const condition of conditions) {
    const row = indexed.get(`${condition.scope}:${condition.key}`);
    if (row === undefined || !row.searchable || row.sensitive) {
      throw new BadRequestException(`字段 ${condition.key} 已停用或不可用于保存报表`);
    }
  }
  if (group !== null) {
    const row = indexed.get(`${group.scope}:${group.key}`);
    if (row === undefined || !row.groupable || row.sensitive || row.dataType === "TEXT_LIST") {
      throw new BadRequestException(`字段 ${group.key} 已停用或不可用于报表分组`);
    }
  }
}

function presentReport(row: SavedRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind.toLowerCase(),
    definition: savedReportDefinitionSchema.parse(row.definitionJson),
    required_permission: "reports:read",
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function presentCard(row: {
  readonly id: string;
  readonly position: number;
  readonly width: number;
  readonly report: SavedRow;
}) {
  return {
    id: row.id,
    position: row.position,
    width: row.width,
    report: presentReport(row.report),
  };
}

@Injectable()
export class SavedReportService {
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

  private async safeReport(row: SavedRow, applicationId: string) {
    const definition = savedReportDefinitionSchema.safeParse(row.definitionJson);
    if (!definition.success) return null;
    try {
      await assertDefinitionFieldsAvailable(this.database, applicationId, definition.data);
      return presentReport(row);
    } catch (error) {
      if (error instanceof BadRequestException) return null;
      throw error;
    }
  }

  async list() {
    const applicationId = this.applicationId();
    const reports = await this.database.savedReport.findMany({
      where: { applicationId },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    });
    const presented = await Promise.all(
      reports.map((report) => this.safeReport(report, applicationId)),
    );
    return { reports: presented.filter((report) => report !== null) };
  }

  async create(input: unknown) {
    const parsed = createSavedReportSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid saved report");
    const applicationId = this.applicationId();
    await assertDefinitionFieldsAvailable(this.database, applicationId, parsed.data.definition);
    try {
      const report = await this.database.savedReport.create({
        data: {
          applicationId,
          name: parsed.data.name,
          kind: SavedReportKind[parsed.data.kind.toUpperCase() as keyof typeof SavedReportKind],
          definitionJson: parsed.data.definition,
          createdBy: this.context.current().actorId,
        },
      });
      await this.audit.record({
        action: "report.create",
        objectType: "saved_report",
        objectId: report.id,
        after: { name: report.name, kind: report.kind.toLowerCase() },
        reason: "Saved analysis report",
      });
      return presentReport(report);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("A report with this name already exists");
      }
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const parsed = updateSavedReportSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid saved report changes");
    const applicationId = this.applicationId();
    const current = await this.database.savedReport.findFirst({ where: { id, applicationId } });
    if (current === null) throw new NotFoundException("Saved report not found");
    if (
      parsed.data.definition !== undefined &&
      !createSavedReportSchema.safeParse({
        name: parsed.data.name ?? current.name,
        kind: current.kind.toLowerCase(),
        definition: parsed.data.definition,
      }).success
    ) {
      throw new BadRequestException("The selected metric does not match the report type");
    }
    const targetDefinition = savedReportDefinitionSchema.safeParse(
      parsed.data.definition ?? current.definitionJson,
    );
    if (!targetDefinition.success) throw new BadRequestException("Saved report is not available");
    await assertDefinitionFieldsAvailable(this.database, applicationId, targetDefinition.data);
    try {
      const report = await this.database.savedReport.update({
        where: { id: current.id },
        data: {
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          ...(parsed.data.definition === undefined
            ? {}
            : { definitionJson: parsed.data.definition }),
        },
      });
      await this.audit.record({
        action: "report.update",
        objectType: "saved_report",
        objectId: report.id,
        before: { name: current.name },
        after: { name: report.name },
        reason: "Updated saved analysis report",
      });
      return presentReport(report);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("A report with this name already exists");
      }
      throw error;
    }
  }

  async remove(id: string) {
    const applicationId = this.applicationId();
    const current = await this.database.savedReport.findFirst({ where: { id, applicationId } });
    if (current === null) throw new NotFoundException("Saved report not found");
    await this.database.$transaction(async (transaction) => {
      await transaction.applicationDashboardCard.deleteMany({
        where: { applicationId, reportId: id },
      });
      await transaction.savedReport.delete({ where: { id } });
    });
    await this.audit.record({
      action: "report.delete",
      objectType: "saved_report",
      objectId: id,
      before: { name: current.name },
      reason: "Deleted saved analysis report",
    });
    return { deleted: true };
  }

  async listDashboard() {
    const applicationId = this.applicationId();
    const cards = await this.database.applicationDashboardCard.findMany({
      where: { applicationId },
      include: { report: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    const presented = await Promise.all(
      cards.map(async (card) => {
        const report = await this.safeReport(card.report, applicationId);
        return report === null
          ? null
          : { id: card.id, position: card.position, width: card.width, report };
      }),
    );
    return { cards: presented.filter((card) => card !== null) };
  }

  async addDashboard(input: unknown) {
    const parsed = createDashboardCardSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid dashboard card");
    const applicationId = this.applicationId();
    const report = await this.database.savedReport.findFirst({
      where: { id: parsed.data.report_id, applicationId },
    });
    if (report === null) throw new NotFoundException("Saved report not found");
    const definition = savedReportDefinitionSchema.safeParse(report.definitionJson);
    if (!definition.success) throw new BadRequestException("Saved report is not available");
    await assertDefinitionFieldsAvailable(this.database, applicationId, definition.data);
    const position = await this.database.applicationDashboardCard.count({
      where: { applicationId },
    });
    try {
      const card = await this.database.applicationDashboardCard.create({
        data: {
          applicationId,
          reportId: report.id,
          position,
          width: parsed.data.width ?? 1,
        },
        include: { report: true },
      });
      return presentCard(card);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This report is already on the dashboard");
      }
      throw error;
    }
  }

  async updateDashboard(id: string, input: unknown) {
    const parsed = updateDashboardCardSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException("Invalid dashboard card changes");
    const applicationId = this.applicationId();
    const current = await this.database.applicationDashboardCard.findFirst({
      where: { id, applicationId },
    });
    if (current === null) throw new NotFoundException("Dashboard card not found");
    const report = await this.database.savedReport.findFirst({
      where: { id: current.reportId, applicationId },
    });
    if (report === null) throw new NotFoundException("Saved report not found");
    const definition = savedReportDefinitionSchema.safeParse(report.definitionJson);
    if (!definition.success) throw new BadRequestException("Saved report is not available");
    await assertDefinitionFieldsAvailable(this.database, applicationId, definition.data);
    const card = await this.database.applicationDashboardCard.update({
      where: { id: current.id },
      data: {
        ...(parsed.data.position === undefined ? {} : { position: parsed.data.position }),
        ...(parsed.data.width === undefined ? {} : { width: parsed.data.width }),
      },
      include: { report: true },
    });
    return presentCard(card);
  }

  async removeDashboard(id: string) {
    const applicationId = this.applicationId();
    const result = await this.database.applicationDashboardCard.deleteMany({
      where: { id, applicationId },
    });
    if (result.count === 0) throw new NotFoundException("Dashboard card not found");
    return { deleted: true };
  }
}
