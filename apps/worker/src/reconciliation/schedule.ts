import {
  planReconciliationRun,
  type ReconciliationRunPlan,
} from "@tokenpilot/reconciliation-engine";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function scheduledReconciliationPlan(
  applicationId: string,
  runType: "hourly" | "daily",
  triggeredAt: Date,
): ReconciliationRunPlan {
  if (!Number.isFinite(triggeredAt.getTime())) throw new TypeError("triggeredAt is invalid");
  const width = runType === "hourly" ? HOUR_MS : DAY_MS;
  const completeBoundary = Math.floor(triggeredAt.getTime() / width) * width;
  return planReconciliationRun({
    applicationId,
    runType,
    rangeStart: new Date(completeBoundary - width).toISOString(),
    rangeEnd: new Date(completeBoundary).toISOString(),
  });
}

export function scheduledReconciliationIdempotencyKey(plan: ReconciliationRunPlan): string {
  if (plan.runType === "manual") {
    throw new TypeError("manual reconciliation does not have a schedule key");
  }
  return `reconciliation:${plan.applicationId}:${plan.runType}:${plan.rangeStart}:${plan.rangeEnd}`;
}
