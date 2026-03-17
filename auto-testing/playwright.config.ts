import { defineConfig, devices } from "@playwright/test";
import path from "path";

const JOB_ID = process.env.JOB_ID;
const REPORT_BASE = process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report";
const OUTPUT_BASE = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const REPORT_DIR = JOB_ID ? path.join(REPORT_BASE, JOB_ID) : REPORT_BASE;
const OUTPUT_DIR = JOB_ID ? path.join(OUTPUT_BASE, JOB_ID) : OUTPUT_BASE;

export default defineConfig({
  testDir: "./generated-tests",
  testMatch: /.*\.ui\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: REPORT_DIR,
        open: "never",
        // No attachmentsBaseURL - use default relative paths; base tag in served HTML makes them resolve to /report/<jobId>/data/...
      },
    ],
    ["json", { outputFile: path.join(OUTPUT_DIR, "results.json") }],
  ],
  outputDir: path.join(OUTPUT_DIR, "pw-artifacts"),
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "on",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
