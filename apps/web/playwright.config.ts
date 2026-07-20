import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results";
const trace = process.env.PLAYWRIGHT_TRACE === "on" ? "on" : "retain-on-failure";
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? "2");
if (!Number.isInteger(workers) || workers < 1) {
  throw new TypeError("PLAYWRIGHT_WORKERS must be a positive integer");
}

export default defineConfig({
  testDir: "./e2e",
  outputDir,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  expect: { timeout: 8_000 },
  timeout: 45_000,
  use: {
    baseURL,
    browserName: "chromium",
    colorScheme: "light",
    locale: "zh-CN",
    timezoneId: "UTC",
    trace,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1440x900",
      use: { viewport: { width: 1_440, height: 900 } },
    },
    {
      name: "narrow-390x844",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
  ...(externalBaseUrl === undefined
    ? {
        webServer: {
          command: "node scripts/start-playwright-server.mjs",
          cwd: webDirectory,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
});
