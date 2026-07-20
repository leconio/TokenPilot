import { loadEnvironment } from "@tokenpilot/shared";

import { createPrismaClient } from "../src/client.js";
import { exampleSeedApplicationEnvironment, seedExampleModelRouting } from "../src/example-seed.js";

const environment = loadEnvironment(process.env);
const applicationSlug = process.env[exampleSeedApplicationEnvironment]?.trim();
if (!applicationSlug) {
  throw new Error(`${exampleSeedApplicationEnvironment} is required`);
}

const database = createPrismaClient(environment.DATABASE_URL);
try {
  const result = await seedExampleModelRouting(database, applicationSlug);
  process.stdout.write(`${JSON.stringify({ status: "seeded", ...result })}\n`);
} finally {
  await database.$disconnect();
}
