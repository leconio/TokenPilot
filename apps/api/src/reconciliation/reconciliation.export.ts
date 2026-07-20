import { NotFoundException } from "@nestjs/common";

import type { DatabaseClient } from "@tokenpilot/db";
import {
  exportReconciliationDiffsCsv,
  type ReconciliationDiff,
} from "@tokenpilot/reconciliation-engine";

export async function exportReconciliationRun(
  database: DatabaseClient,
  applicationId: string,
  runId: string,
): Promise<string> {
  const run = await database.reconciliationRun.findFirst({
    where: { id: runId, applicationId },
    select: { id: true },
  });
  if (run === null) throw new NotFoundException("Reconciliation run not found");
  const rows = await database.reconciliationDiff.findMany({
    where: { runId, run: { applicationId } },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const diffs: ReconciliationDiff[] = rows.map((row) => ({
    type: row.diffType as ReconciliationDiff["type"],
    severity: row.severity.toLowerCase() as ReconciliationDiff["severity"],
    dimensions: row.dimensionsJson as ReconciliationDiff["dimensions"],
    count: row.differenceCount.toString(),
    amount: row.amount?.toString() ?? null,
    pgValues: row.pgValuesJson as ReconciliationDiff["pgValues"],
    chValues: row.chValuesJson as ReconciliationDiff["chValues"],
    deltaValues: row.deltaValuesJson as ReconciliationDiff["deltaValues"],
    sampleEventIds: row.sampleEventIdsJson as unknown as readonly string[],
    explanation: row.explanation,
  }));
  return exportReconciliationDiffsCsv(diffs);
}
