import "dotenv/config";

import { defineConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

if (
  databaseUrl === undefined ||
  databaseUrl.length === 0 ||
  shadowDatabaseUrl === undefined ||
  shadowDatabaseUrl.length === 0
) {
  throw new Error("DATABASE_URL and SHADOW_DATABASE_URL are required");
}

export default defineConfig({
  schema: "../../packages/db/prisma/schema",
  migrations: {
    path: "../../packages/db/prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl,
  },
});
