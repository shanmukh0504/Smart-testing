import { defineConfig } from "vitest/config";
import path from "path";

const JOB_ID = process.env.JOB_ID;
const OUTPUT_BASE = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const OUTPUT_DIR = JOB_ID ? path.join(OUTPUT_BASE, JOB_ID) : OUTPUT_BASE;

export default defineConfig({
  test: {
    include: ["generated-tests/**/*.api.spec.ts"],
    exclude: ["**/*.ui.spec.ts", "node_modules"],
    environment: "node",
    reporters: ["default", "json"],
    outputFile: { json: path.join(OUTPUT_DIR, "api-report.json") },
  },
});
