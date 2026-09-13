import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
// Production compilation, isolated listener, local DB from .env only.
export default defineConfig({
  ...base,
  outputDir: "test-results/performance",
  testMatch: "performance.spec.ts",
  grep: /initial navigation/,
  use: { ...base.use, baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 -p 3100",
    url: "http://127.0.0.1:3100/sign-in",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      BETTER_AUTH_URL: "http://127.0.0.1:3100",
      SCHEDULED_PUBLISHER_ENABLED: "false",
    },
  },
});
