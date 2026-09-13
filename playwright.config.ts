import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";

dotenv.config({ path: ".env", quiet: true });
const port = Number(process.env.CMS_E2E_PORT ?? 3000);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 -p ${port}`,
    url: `${baseURL}/sign-in`,
    env: { BETTER_AUTH_URL: baseURL, SCHEDULED_PUBLISHER_ENABLED: "false" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
