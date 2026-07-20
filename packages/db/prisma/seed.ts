import { featureFlagsFromEnvironment, loadEnvironment } from "@tokenpilot/shared";

import { createPrismaClient } from "../src/client.js";
import { ensureInstanceSettings } from "../src/instance-settings.js";

const environment = loadEnvironment(process.env);
const database = createPrismaClient(environment.DATABASE_URL);

try {
  await ensureInstanceSettings(database, {
    instanceId: environment.INSTANCE_ID,
    environment: environment.ENVIRONMENT,
    timezone: environment.APP_TIMEZONE,
    baseCurrency: environment.BASE_CURRENCY,
    featureFlagDefaults: featureFlagsFromEnvironment(environment),
    aiuMicroScale: environment.AIU_MICRO_SCALE,
  });
} finally {
  await database.$disconnect();
}
