import { afterAll, beforeAll, describe } from "vitest";

import { registerAdministrationCases } from "./integration/administration.cases.js";
import { registerConfigurationCases } from "./integration/configuration.cases.js";
import { registerControlCases } from "./integration/controls.cases.js";
import { registerIngestionCases } from "./integration/ingestion.cases.js";
import { registerOperationsCases } from "./integration/operations.cases.js";
import { registerPolicyCases } from "./integration/policy.cases.js";
import { registerReportingCases } from "./integration/reporting.cases.js";
import { enabled } from "./integration/support/config.js";
import { startIntegrationHarness, stopIntegrationHarness } from "./integration/support/harness.js";
import { registerWebSessionCases } from "./integration/web-session.cases.js";

describe.skipIf(!enabled)("current usage ingestion API", () => {
  beforeAll(startIntegrationHarness, 30_000);
  afterAll(stopIntegrationHarness);

  registerIngestionCases();
  registerWebSessionCases();
  registerAdministrationCases();
  registerPolicyCases();
  registerReportingCases();
  registerOperationsCases();
  registerControlCases();
});

describe("current integration test configuration", () => {
  registerConfigurationCases();
});
