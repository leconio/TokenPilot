import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = new URL("../../", import.meta.url);

describe("operations readiness", () => {
  it("passes the static observability, security, backup, and runbook acceptance", async () => {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/acceptance/operations-readiness.mjs"],
      {
        cwd: root,
      },
    );
    expect(JSON.parse(stdout)).toEqual({ status: "passed", failures: [] });
  });

  it("keeps all current operational alerts linked to concrete runbooks", async () => {
    const alerts = await readFile(
      new URL("../../deploy/observability/alerts.yml", import.meta.url),
      "utf8",
    );
    for (const name of [
      "InboxOldestAge",
      "SettlementDLQIncreasing",
      "ClickHouseSinkLag",
      "ReconciliationConsecutiveFailures",
      "ProviderCostUnpricedRatio",
      "AiuUnratedRatio",
      "QuotaNegativeBalance",
      "ReservationExpirySpike",
      "RealtimeOfficialDelta",
    ]) {
      expect(alerts).toContain(`TokenPilot${name}`);
    }
    expect(alerts.match(/runbook: docs\/operations\.md$/gmu)).toHaveLength(26);
  });
});
