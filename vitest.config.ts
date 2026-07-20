import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { provider: "v8" },
    exclude: [
      ...configDefaults.exclude,
      "**/.tokenpilot/**",
      "**/.venv/**",
      "**/dist/**",
      "apps/web/e2e/**",
      // These use node:test and are exercised by the dedicated release gate.
      "scripts/acceptance/release/*.test.mjs",
    ],
  },
});
