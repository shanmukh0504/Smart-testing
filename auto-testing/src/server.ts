/**
 * Test server - API endpoints, job-based reports, cron scheduling
 */

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { readFile, readdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";
import { AutoTestingAgent } from "./agent.js";
import { createGitProvider } from "./git-provider.js";
import { loadKT, listKTs, loadRepoSettings, saveRepoSettings, type RepoSettings } from "./kt-store.js";
import { RepoTestConfigSchema } from "./config.js";
import type { TestPrompt } from "./test-generator.js";
import { generateJobId } from "./job-id.js";
import {
  runTests,
  loadRunHistory,
  isTestRunning,
  getCurrentJobId,
  cancelRunningTest,
  type TriggerType,
} from "./test-runner.js";
import {
  loadSchedule,
  saveSchedule,
  startScheduler,
  getNextRun,
  updateSchedulerCron,
  type ScheduleConfig,
} from "./schedule.js";

const DEFAULT_PORT = parseInt(process.env.PORT || "8080", 10);
const RESULTS_DIR = join(process.cwd(), "test-results");
const REPORT_BASE = join(process.cwd(), "playwright-report");
const GENERATED_TESTS_DIR = join(process.cwd(), "generated-tests");

let serverPort = DEFAULT_PORT;

async function loadConfig() {
  const path = join(process.cwd(), "config", "test-config.json");
  try {
    const raw = await readFile(path, "utf-8");
    return RepoTestConfigSchema.parse(JSON.parse(raw));
  } catch {
    return RepoTestConfigSchema.parse({});
  }
}

function createAgent() {
  if (!process.env.GIT_TOKEN) {
    throw new Error("GIT_TOKEN required");
  }
  return new AutoTestingAgent({
    gitProvider: createGitProvider(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeModel: process.env.CLAUDE_MODEL,
    config: {} as any,
  });
}

async function runScheduledTests() {
  const jobId = generateJobId();
  const result = await runTests({
    jobId,
    triggerType: "scheduled",
    runApi: true,
    runUi: true,
  });
  const schedule = await loadSchedule();
  await saveSchedule({
    lastRun: result.endTime,
    lastSuccessfulRun: result.success ? result.endTime : schedule.lastSuccessfulRun,
  });
}

function json(res: Response, data: object, status = 200) {
  res.status(status).json(data);
}

export function startServer(port: number = DEFAULT_PORT): void {
  serverPort = port;
  const app = express();
  app.use(express.json());

  // CORS for frontend
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  // --- API: Generated Tests ---
  app.get("/api/tests", async (_req: Request, res: Response) => {
    try {
      if (!existsSync(GENERATED_TESTS_DIR)) {
        return json(res, { repos: [], testsByRepo: {}, reposWithType: [] });
      }
      const repos = await readdir(GENERATED_TESTS_DIR);
      const testsByRepo: Record<string, string[]> = {};
      const reposWithType: Array<{ name: string; type: "backend" | "frontend" }> = [];
      for (const repo of repos) {
        const dir = join(GENERATED_TESTS_DIR, repo);
        if (existsSync(dir)) {
          const files = await readdir(dir);
          const specFiles = files.filter((f) => f.endsWith(".spec.ts"));
          testsByRepo[repo] = specFiles;
          const hasApi = specFiles.some((f) => f.endsWith(".api.spec.ts"));
          const hasUi = specFiles.some((f) => f.endsWith(".ui.spec.ts"));
          const type = hasApi ? "backend" : "frontend";
          reposWithType.push({ name: repo, type });
        }
      }
      json(res, { repos, testsByRepo, reposWithType });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  // --- API: Run History ---
  app.get("/api/runs", async (req: Request, res: Response) => {
    try {
      const history = await loadRunHistory();
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string | undefined;
      const trigger = req.query.trigger as string | undefined;
      const dateFrom = req.query.dateFrom as string | undefined;
      const dateTo = req.query.dateTo as string | undefined;
      let filtered = history.slice(0, limit);
      if (status) filtered = filtered.filter((r) => r.status === status);
      if (trigger) filtered = filtered.filter((r) => r.triggerType === trigger);
      if (dateFrom) {
        const from = new Date(dateFrom).getTime();
        filtered = filtered.filter((r) => new Date(r.startTime).getTime() >= from);
      }
      if (dateTo) {
        const to = new Date(dateTo).getTime();
        filtered = filtered.filter((r) => new Date(r.startTime).getTime() <= to);
      }
      json(res, { runs: filtered });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  app.get("/api/runs/current", (_req: Request, res: Response) => {
    const jobId = getCurrentJobId();
    if (!jobId) {
      return json(res, { running: false });
    }
    const progressPath = join(RESULTS_DIR, jobId, "progress.json");
    let progress: object | undefined;
    if (existsSync(progressPath)) {
      try {
        progress = JSON.parse(readFileSync(progressPath, "utf-8"));
      } catch {
        /* ignore */
      }
    }
    json(res, { running: true, jobId, progress });
  });

  app.get("/api/runs/:jobId", async (req: Request, res: Response) => {
    const history = await loadRunHistory();
    const run = history.find((r) => r.jobId === req.params.jobId);
    if (!run) return json(res, { error: "Run not found" }, 404);
    json(res, run);
  });

  // --- API: Last Run ---
  app.get("/api/last-run", async (_req: Request, res: Response) => {
    const history = await loadRunHistory();
    const last = history.find((r) => r.status !== "running");
    const lastSuccess = history.find((r) => r.status === "passed");
    json(res, {
      lastRun: last ? { date: last.startTime, status: last.status } : null,
      lastSuccessfulRun: lastSuccess ? { date: lastSuccess.startTime } : null,
    });
  });

  // --- API: Schedule ---
  app.get("/api/schedule", async (_req: Request, res: Response) => {
    try {
      const config = await loadSchedule();
      const next = getNextRun(config.cronExpression);
      json(res, { ...config, nextRun: next || config.nextRun });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  app.post("/api/schedule", async (req: Request, res: Response) => {
    try {
      const { enabled, cronExpression } = req.body;
      const current = await loadSchedule();
      const updates: Partial<ScheduleConfig> = {};
      if (typeof enabled === "boolean") updates.enabled = enabled;
      if (typeof cronExpression === "string") updates.cronExpression = cronExpression;
      const updated = await saveSchedule(updates);
      if (updates.cronExpression) updateSchedulerCron(updated.cronExpression);
      json(res, updated);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  // --- API: Manual Controls ---
  app.post("/api/test/trigger", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    // Auto-detect which test types exist
    let hasApi = false;
    let hasUi = false;
    if (existsSync(GENERATED_TESTS_DIR)) {
      try {
        const repos = await readdir(GENERATED_TESTS_DIR);
        for (const repo of repos) {
          const files = await readdir(join(GENERATED_TESTS_DIR, repo));
          if (files.some((f) => f.endsWith(".api.spec.ts"))) hasApi = true;
          if (files.some((f) => f.endsWith(".ui.spec.ts"))) hasUi = true;
        }
      } catch { /* ignore */ }
    }
    if (!hasApi && !hasUi) { hasApi = true; hasUi = true; } // fallback: run both
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: hasApi,
      runUi: hasUi,
    }).catch((err) => console.error("[TEST] Run failed:", err));
  });

  // --- API: Run specific test files for a repo ---
  app.post("/api/test/run-files", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const { repo, files } = req.body as { repo: string; files?: string[] };
    if (!repo) {
      return json(res, { error: "repo is required" }, 400);
    }

    // Determine which test types to run
    let hasApi = false;
    let hasUi = false;
    if (files && files.length > 0) {
      hasApi = files.some((f: string) => f.endsWith(".api.spec.ts"));
      hasUi = files.some((f: string) => f.endsWith(".ui.spec.ts"));
    } else {
      // Run all tests for the repo
      const repoDir = join(GENERATED_TESTS_DIR, repo);
      if (existsSync(repoDir)) {
        try {
          const repoFiles = await readdir(repoDir);
          hasApi = repoFiles.some((f) => f.endsWith(".api.spec.ts"));
          hasUi = repoFiles.some((f) => f.endsWith(".ui.spec.ts"));
        } catch { /* ignore */ }
      }
      if (!hasApi && !hasUi) { hasApi = true; hasUi = true; }
    }

    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: hasApi,
      runUi: hasUi,
      repo,
      testFiles: files,
    }).catch((err) => console.error("[TEST] Run files failed:", err));
  });

  app.post("/api/test/rerun-failed", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const jobId = generateJobId();
    json(res, { jobId, status: "started", reportUrl: `http://localhost:${serverPort}/report/${jobId}` });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: false,
      runUi: true,
      rerunFailedOnly: true,
    }).catch((err) => console.error("[TEST] Rerun failed:", err));
  });

  app.post("/api/test/rerun", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    // Auto-detect which test types exist
    let hasApi = false;
    let hasUi = false;
    if (existsSync(GENERATED_TESTS_DIR)) {
      try {
        const repos = await readdir(GENERATED_TESTS_DIR);
        for (const repo of repos) {
          const files = await readdir(join(GENERATED_TESTS_DIR, repo));
          if (files.some((f) => f.endsWith(".api.spec.ts"))) hasApi = true;
          if (files.some((f) => f.endsWith(".ui.spec.ts"))) hasUi = true;
        }
      } catch { /* ignore */ }
    }
    if (!hasApi && !hasUi) { hasApi = true; hasUi = true; }
    const jobId = generateJobId();
    json(res, { jobId, status: "started", reportUrl: `http://localhost:${serverPort}/report/${jobId}` });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: hasApi,
      runUi: hasUi,
    }).catch((err) => console.error("[TEST] Rerun failed:", err));
  });

  app.post("/api/test/cancel", (_req: Request, res: Response) => {
    const cancelled = cancelRunningTest();
    json(res, { cancelled });
  });

  // --- API: Add test cases (agent generates, then rerun) ---
  app.post("/api/test/add-cases", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const { userPrompt, repo, apiBaseUrl, endpoint, sampleReq, secretsAndParams } = req.body;
    if (!userPrompt || !repo) {
      return json(res, { error: "userPrompt and repo required" }, 400);
    }
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    (async () => {
      try {
        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();
        await agent.addTestCases({
          userPrompt,
          repo,
          apiBaseUrl,
          endpoint,
          sampleReq,
          secretsAndParams,
        });
        await runTests({
          jobId,
          triggerType: "add-cases",
          runApi: true,
          runUi: true,
          repo,
        });
      } catch (err) {
        console.error("[TEST] Add cases failed:", err);
      }
    })();
  });

  // --- API: KT (Knowledge Transfer) ---
  app.get("/api/kt", async (_req: Request, res: Response) => {
    try {
      const repos = await listKTs();
      const kts: Record<string, any> = {};
      const settings: Record<string, RepoSettings> = {};
      for (const repo of repos) {
        const kt = await loadKT(repo);
        if (kt) {
          kts[repo] = {
            generated_at: kt.kt.generated_at,
            modules: kt.kt.modules.length,
            apis: kt.kt.apis.length,
            ui_components: kt.kt.ui_components.length,
            tests: {
              api: kt.tests.api.length,
              playwright: kt.tests.playwright.length,
              unit: kt.tests.unit.length,
              integration: kt.tests.integration.length,
            },
          };
        }
        const repoSettings = await loadRepoSettings(repo);
        if (repoSettings) {
          settings[repo] = repoSettings;
        }
      }
      json(res, { repos, kts, settings });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  app.get("/api/kt/:repo", async (req: Request, res: Response) => {
    try {
      const repoName = req.params.repo as string;
      const kt = await loadKT(repoName);
      if (!kt) return json(res, { error: "KT not found" }, 404);
      json(res, kt);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  // --- API: Repo Settings ---
  app.get("/api/repo/:repo/settings", async (req: Request, res: Response) => {
    try {
      const repoName = req.params.repo as string;
      const settings = await loadRepoSettings(repoName);
      if (!settings) return json(res, { error: "Settings not found" }, 404);
      json(res, settings);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  app.post("/api/repo/:repo/settings", async (req: Request, res: Response) => {
    try {
      const repoName = req.params.repo as string;
      const settings = req.body as RepoSettings;
      if (!settings.repoType) {
        return json(res, { error: "repoType required" }, 400);
      }
      // Merge with existing settings
      const existing = await loadRepoSettings(repoName) || { repoType: settings.repoType };
      const merged: RepoSettings = {
        ...existing,
        ...settings,
        endpointParams: { ...(existing.endpointParams || {}), ...(settings.endpointParams || {}) },
      };
      await saveRepoSettings(repoName, merged);
      json(res, merged);
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  app.post("/api/kt/generate", async (req: Request, res: Response) => {
    const { repo, repoType } = req.body;
    if (!repo) return json(res, { error: "repo required" }, 400);
    json(res, { status: "started", repo });
    (async () => {
      try {
        // Save repoType to settings if provided
        // Use the full repo name (e.g. "hashiraio/quote") so it maps to the same
        // directory as the KT document (memory/hashiraio-quote/)
        if (repoType === 'frontend' || repoType === 'backend') {
          const existing = await loadRepoSettings(repo) || { repoType };
          await saveRepoSettings(repo, { ...existing, repoType });
          console.log(`[KT] Saved repoType="${repoType}" for ${repo}`);
        }

        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();

        // Step 1: Ensure KT exists and is saved to memory (no tests yet)
        const { kt, freshlyGenerated } = await agent.ensureKT(repo);
        console.log(
          `[KT] KT ${freshlyGenerated ? "generated" : "loaded"} for ${repo}: ` +
          `${kt.kt.modules.length} modules, ${kt.kt.apis.length} APIs, ${kt.kt.ui_components.length} UI components`
        );

        // Step 2: Generate tests using the saved KT + website URLs
        console.log(`[KT] Generating tests for ${repo} using saved KT + configured URLs...`);
        await agent.ensureTests(repo);

        const updated = await agent.getKT(repo);
        const tests = updated?.tests;
        console.log(
          `[KT] Done for ${repo}: ${(tests?.api.length || 0)} API tests, ${(tests?.playwright.length || 0)} UI tests`
        );
      } catch (err) {
        console.error("[KT] Generation failed:", err);
      }
    })();
  });

  // --- API: PR Mode ---
  app.post("/api/pr/test", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const { repo, prNumber } = req.body;
    if (!repo || !prNumber) {
      return json(res, { error: "repo and prNumber required" }, 400);
    }
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      repo,
      prNumber,
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    (async () => {
      try {
        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();
        const report = await agent.handlePR({ repo, prNumber });
        console.log(`[PR] Generated ${report.testsGenerated.length} tests for PR #${prNumber}`);

        if (report.testsGenerated.length > 0) {
          const hasApi = report.testsGenerated.some((t) => t.type === "backend");
          const hasUi = report.testsGenerated.some((t) => t.type === "frontend");
          await runTests({
            jobId,
            triggerType: "auto",
            runApi: hasApi,
            runUi: hasUi,
            repo,
            branch: report.headBranch,
          });
        }
      } catch (err) {
        console.error("[PR] Test failed:", err);
      }
    })();
  });

  // --- API: PR Webhook (GitHub/Gitea compatible) ---
  app.post("/api/webhook/pr", async (req: Request, res: Response) => {
    const payload = req.body;
    // GitHub format
    const action = payload.action;
    const pr = payload.pull_request;
    if (!pr || !["opened", "synchronize", "reopened"].includes(action)) {
      return json(res, { skipped: true, reason: "Not a PR open/update event" });
    }

    const repoFullName = payload.repository?.full_name;
    const prNumber = pr.number;

    if (!repoFullName || !prNumber) {
      return json(res, { error: "Could not extract repo/PR info" }, 400);
    }

    if (isTestRunning()) {
      return json(res, { queued: false, reason: "Tests already running" }, 409);
    }

    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      repo: repoFullName,
      prNumber,
    });
    (async () => {
      try {
        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();
        const report = await agent.handlePR({ repo: repoFullName, prNumber });
        if (report.testsGenerated.length > 0) {
          const hasApi = report.testsGenerated.some((t) => t.type === "backend");
          const hasUi = report.testsGenerated.some((t) => t.type === "frontend");
          await runTests({
            jobId,
            triggerType: "auto",
            runApi: hasApi,
            runUi: hasUi,
            repo: repoFullName,
            branch: report.headBranch,
            author: pr.user?.login || pr.user?.username,
          });
        }
      } catch (err) {
        console.error("[WEBHOOK] PR test failed:", err);
      }
    })();
  });

  // --- API: Test Request Mode ---
  app.post("/api/test/request", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const { repo, module, type, apiBaseUrl, uiBaseUrl } = req.body;
    if (!repo) {
      return json(res, { error: "repo required" }, 400);
    }
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      repo,
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    (async () => {
      try {
        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();
        const result = await agent.handleTestRequest({
          repo,
          module,
          type,
          apiBaseUrl,
          uiBaseUrl,
        });
        console.log(
          `[TEST-REQ] Generated ${result.testsGenerated.length} tests for ${repo}` +
            (result.ktUpdated ? " (KT updated)" : "")
        );
        if (result.testsGenerated.length > 0) {
          const hasApi = result.testsGenerated.some((t) => t.type === "backend");
          const hasUi = result.testsGenerated.some((t) => t.type === "frontend");
          await runTests({
            jobId,
            triggerType: "auto",
            runApi: hasApi,
            runUi: hasUi,
            repo,
          });
        }
      } catch (err) {
        console.error("[TEST-REQ] Failed:", err);
      }
    })();
  });

  // --- POST /api/test/generate (async - generate and run from prompt, returns jobId immediately) ---
  app.post("/api/test/generate", async (req: Request, res: Response) => {
    if (isTestRunning()) {
      return json(res, { error: "Tests already running" }, 409);
    }
    const data = req.body;
    if (!data?.url || !data?.type || !data?.context || !data?.repo) {
      return json(res, { error: "Missing required fields: url, type, context, repo" }, 400);
    }
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    (async () => {
      try {
        const config = await loadConfig();
        const agent = createAgent();
        (agent as any).config = config;
        await agent.bootstrap();
        const prompt: TestPrompt = {
          url: data.url,
          context: data.context,
          type: data.type,
          apiBaseUrl: data.apiBaseUrl ?? data.baseUrl,
          sampleResponse: data.sampleResponse,
          secretsAndParams: data.secretsAndParams,
        };
        const tests = await agent.generateTests({ prompt, repoHint: data.repo });
        const hasApi = tests.some((t) => t.type === "backend");
        const hasUi = tests.some((t) => t.type === "frontend");
        await runTests({
          jobId,
          triggerType: "auto",
          runApi: hasApi,
          runUi: hasUi,
        });
      } catch (err) {
        console.error("[TEST] Generate failed:", err);
      }
    })();
  });

  // --- POST /test (legacy - generate and run from prompt, synchronous) ---
  app.post("/test", async (req: Request, res: Response) => {
    const data = req.body;
    if (!data?.url || !data?.type || !data?.context) {
      return json(res, { error: "Missing required fields: url, type, context" }, 400);
    }
    try {
      const config = await loadConfig();
      const agent = createAgent();
      (agent as any).config = config;
      await agent.bootstrap();
      const prompt: TestPrompt = {
        url: data.url,
        context: data.context,
        type: data.type,
        apiBaseUrl: data.apiBaseUrl ?? data.baseUrl,
        sampleResponse: data.sampleResponse,
        secretsAndParams: data.secretsAndParams,
      };
      const tests = await agent.generateTests({ prompt, repoHint: data.repo });
      const jobId = generateJobId();
      const hasApi = tests.some((t) => t.type === "backend");
      const hasUi = tests.some((t) => t.type === "frontend");
      const result = await runTests({
        jobId,
        triggerType: "auto",
        runApi: hasApi,
        runUi: hasUi,
      });
      json(res, {
        success: result.success,
        testsGenerated: tests.length,
        jobId,
        reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
      });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : "Unknown error" }, 500);
    }
  });

  // --- Report routes (job-based) ---
  const serveReportIndex = async (req: Request, res: Response, jobId?: string) => {
    const baseDir = jobId ? join(REPORT_BASE, jobId) : REPORT_BASE;
    const indexPath = join(baseDir, "index.html");
    const apiReportPath = jobId ? join(RESULTS_DIR, jobId, "api-report.json") : join(RESULTS_DIR, "api-report.json");
    const playwrightResultsPath = jobId ? join(RESULTS_DIR, jobId, "results.json") : join(RESULTS_DIR, "results.json");

    const hasApiReport = existsSync(apiReportPath);
    const hasPlaywrightHtml = existsSync(indexPath);

    // Check if Playwright had actual tests (not just "No tests found")
    let playwrightHasTests = false;
    if (hasPlaywrightHtml && existsSync(playwrightResultsPath)) {
      try {
        const results = JSON.parse(await readFile(playwrightResultsPath, "utf-8"));
        playwrightHasTests = results.suites?.length > 0;
      } catch { /* treat as no tests */ }
    }

    // No reports at all — check run history for summary stats
    if (!hasApiReport && !hasPlaywrightHtml) {
      return serveRunSummaryPage(res, jobId);
    }

    // Playwright exists but empty, no API report — show run summary from history
    if (!hasApiReport && hasPlaywrightHtml && !playwrightHasTests) {
      return serveRunSummaryPage(res, jobId);
    }

    // API-only run (no Playwright tests ran, or Playwright empty)
    if (hasApiReport && !playwrightHasTests) {
      return serveApiReportPage(res, apiReportPath, jobId, playwrightHasTests && hasPlaywrightHtml);
    }

    // Playwright has actual tests - serve Playwright HTML
    if (hasPlaywrightHtml && playwrightHasTests) {
      let html = await readFile(indexPath, "utf-8");
      const rootHref = "/";
      const fullHref = jobId ? `${rootHref}report/${jobId}/` : `${rootHref}report/`;
      const baseTag = `<base href="${fullHref}">`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}`);
      } else {
        html = html.replace(/<head\s/, `<head ${baseTag} `);
      }
      if (jobId) {
        html = html.replace(/\/report\/data\//g, `/report/${jobId}/data/`);
        html = html.replace(/\/report\/trace\//g, `/report/${jobId}/trace/`);
        html = html.replace(/href="\/report\/data\//g, `href="/report/${jobId}/data/`);
        html = html.replace(/href="\/report\/trace\//g, `href="/report/${jobId}/trace/`);
        html = html.replace(/src="\/report\/data\//g, `src="/report/${jobId}/data/`);
        html = html.replace(/src="\/report\/trace\//g, `src="/report/${jobId}/trace/`);
      }
      res.status(200).type("html").send(html);
      return;
    }

    return serveReportPage(res, jobId);
  };

  app.get("/report", (req: Request, res: Response) => serveReportIndex(req, res));
  app.get("/report/", (req: Request, res: Response) => serveReportIndex(req, res));
  app.get("/report/:jobId", (req: Request, res: Response) => serveReportIndex(req, res, req.params.jobId as string));
  app.get("/report/:jobId/", (req: Request, res: Response) => serveReportIndex(req, res, req.params.jobId as string));

  // Serve test-results for artifacts (like playwright-server)
  app.use("/test-results", express.static(RESULTS_DIR, { index: false, redirect: false }));
  app.use("/report/test-results", express.static(RESULTS_DIR, { index: false, redirect: false }));

  // Data/trace routes MUST come before /report static - handle attachments (screenshots, traces as .zip in data/)
  app.get(/^\/report\/([^/]+)\/data\/(.+)$/, async (req: Request, res: Response) => {
    const jobId = req.params[0] as string;
    const relPath = (req.params[1] as string).replace(/\.\./g, "");
    const bases = [
      join(REPORT_BASE, jobId, "data"),
      join(RESULTS_DIR, jobId, "pw-artifacts"),
      join(RESULTS_DIR, jobId),
    ];
    for (const base of bases) {
      const filePath = resolve(join(base, relPath));
      const resolvedBase = resolve(base);
      if ((filePath.startsWith(resolvedBase + sep) || filePath === resolvedBase) && existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send("Not found");
  });

  app.get(/^\/report\/([^/]+)\/trace\/(.+)$/, async (req: Request, res: Response) => {
    const jobId = req.params[0] as string;
    const relPath = (req.params[1] as string).replace(/\.\./g, "");
    const bases = [
      join(REPORT_BASE, jobId, "trace"),
      join(REPORT_BASE, jobId, "data"),
      join(RESULTS_DIR, jobId, "pw-artifacts"),
      join(RESULTS_DIR, jobId),
    ];
    for (const base of bases) {
      const filePath = resolve(join(base, relPath));
      const resolvedBase = resolve(base);
      if ((filePath.startsWith(resolvedBase + sep) || filePath === resolvedBase) && existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    res.status(404).send("Not found");
  });

  app.use("/report", express.static(REPORT_BASE, { index: false }));

  app.get("/report/:jobId/api", async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;
    const apiPath = join(RESULTS_DIR, jobId, "api-report.json");
    if (!existsSync(apiPath)) {
      return res.status(404).send("No API report for this job");
    }
    const data = await readFile(apiPath, "utf-8");
    res.type("json").send(data);
  });

  async function serveApiReportPage(res: Response, apiReportPath: string, jobId?: string, hasPlaywrightLink?: boolean) {
    let report: any;
    try {
      report = JSON.parse(await readFile(apiReportPath, "utf-8"));
    } catch {
      return serveReportPage(res, jobId);
    }

    const totalTests = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    const failed = report.numFailedTests ?? 0;
    const skipped = report.numPendingTests ?? 0;
    const totalSuites = report.numTotalTestSuites ?? 0;
    const passedSuites = report.numPassedTestSuites ?? 0;
    const failedSuites = report.numFailedTestSuites ?? 0;
    const duration = report.testResults?.reduce((sum: number, r: any) => sum + ((r.endTime || 0) - (r.startTime || 0)), 0) || 0;
    const durationStr = duration > 0 ? `${(duration / 1000).toFixed(1)}s` : '--';
    const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0';

    // Build test file rows
    const fileRows = (report.testResults || []).map((file: any) => {
      const fileName = (file.name || '').split('/').pop() || file.name;
      const fileStatus = file.status === 'passed' ? 'passed' : 'failed';
      const assertions = file.assertionResults || [];
      const filePassed = assertions.filter((a: any) => a.status === 'passed').length;
      const fileFailed = assertions.filter((a: any) => a.status === 'failed').length;

      const testRows = assertions.map((a: any) => {
        const ancestors = (a.ancestorTitles || []).join(' > ');
        const label = ancestors ? `${ancestors} > ${a.title}` : a.title;
        const statusIcon = a.status === 'passed' ? '&#10003;' : '&#10007;';
        const statusColor = a.status === 'passed' ? '#4ade80' : '#f87171';
        const dMs = a.duration || 0;
        const failMsg = a.status === 'failed' && a.failureMessages?.length
          ? `<pre class="fail-msg">${escapeHtml(a.failureMessages.join('\n')).slice(0, 2000)}</pre>`
          : '';
        return `<tr class="test-row ${a.status}">
          <td class="test-status" style="color:${statusColor}">${statusIcon}</td>
          <td class="test-name">${escapeHtml(label)}</td>
          <td class="test-dur">${dMs}ms</td>
        </tr>${failMsg ? `<tr class="fail-row"><td colspan="3">${failMsg}</td></tr>` : ''}`;
      }).join('');

      const statusBadge = fileStatus === 'passed'
        ? '<span class="badge pass">PASS</span>'
        : '<span class="badge fail">FAIL</span>';

      return `<div class="file-section">
        <div class="file-header" onclick="this.parentElement.classList.toggle('open')">
          ${statusBadge}
          <span class="file-name">${escapeHtml(fileName)}</span>
          <span class="file-stats">
            <span class="stat-pass">${filePassed} passed</span>
            ${fileFailed > 0 ? `<span class="stat-fail">${fileFailed} failed</span>` : ''}
          </span>
          <span class="chevron">&#9660;</span>
        </div>
        <table class="test-table">${testRows}</table>
      </div>`;
    }).join('');

    const playwrightLink = hasPlaywrightLink && jobId
      ? `<a href="/report/${jobId}/" class="link-btn">View Playwright Report</a>` : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Test Report${jobId ? ` — ${jobId}` : ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0d11; color: #c9cdd4; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 20px; font-weight: 600; color: #e1e3e6; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #555d6e; margin-bottom: 24px; }
  .subtitle code { background: #181b22; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #8b92a0; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .stat-card { background: #12151b; border: 1px solid #1e2229; border-radius: 10px; padding: 16px; }
  .stat-card .label { font-size: 11px; color: #555d6e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .stat-card .value { font-size: 26px; font-weight: 700; }
  .stat-card .value.pass { color: #4ade80; }
  .stat-card .value.fail { color: #f87171; }
  .stat-card .value.total { color: #e1e3e6; }
  .stat-card .value.skip { color: #facc15; }
  .stat-card .value.rate { color: #60a5fa; }
  .stat-card .value.time { color: #c084fc; }
  .bar { height: 6px; background: #1e2229; border-radius: 3px; overflow: hidden; margin-bottom: 28px; display: flex; }
  .bar .pass-bar { background: #4ade80; }
  .bar .fail-bar { background: #f87171; }
  .bar .skip-bar { background: #facc15; }
  .file-section { background: #12151b; border: 1px solid #1e2229; border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
  .file-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; user-select: none; }
  .file-header:hover { background: #181b22; }
  .file-name { font-size: 13px; font-weight: 500; color: #e1e3e6; flex: 1; }
  .file-stats { font-size: 12px; display: flex; gap: 10px; }
  .stat-pass { color: #4ade80; }
  .stat-fail { color: #f87171; }
  .chevron { font-size: 10px; color: #555d6e; transition: transform 0.2s; }
  .file-section.open .chevron { transform: rotate(180deg); }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .badge.pass { background: #4ade8020; color: #4ade80; }
  .badge.fail { background: #f8717120; color: #f87171; }
  .test-table { width: 100%; border-collapse: collapse; display: none; }
  .file-section.open .test-table { display: table; }
  .test-row td { padding: 8px 16px; font-size: 12px; border-top: 1px solid #1e222920; }
  .test-status { width: 28px; text-align: center; font-size: 14px; }
  .test-name { color: #c9cdd4; }
  .test-dur { width: 70px; text-align: right; color: #555d6e; font-size: 11px; font-variant-numeric: tabular-nums; }
  .fail-row td { padding: 0 16px 12px; }
  .fail-msg { background: #f8717110; border: 1px solid #f8717130; border-radius: 6px; padding: 10px 14px; font-size: 11px; color: #f87171; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; font-family: 'SF Mono', Menlo, monospace; }
  .link-btn { display: inline-block; margin-top: 20px; padding: 8px 16px; background: #1e2229; border: 1px solid #2a2f38; border-radius: 6px; color: #60a5fa; text-decoration: none; font-size: 13px; }
  .link-btn:hover { background: #252a34; }
</style>
</head>
<body>
<div class="container">
  <h1>API Test Report</h1>
  <p class="subtitle">${jobId ? `<code>${jobId}</code> &middot; ` : ''}${totalSuites} test files &middot; ${totalTests} tests &middot; ${durationStr}</p>

  <div class="stats">
    <div class="stat-card"><div class="label">Total</div><div class="value total">${totalTests}</div></div>
    <div class="stat-card"><div class="label">Passed</div><div class="value pass">${passed}</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="value fail">${failed}</div></div>
    <div class="stat-card"><div class="label">Skipped</div><div class="value skip">${skipped}</div></div>
    <div class="stat-card"><div class="label">Pass Rate</div><div class="value rate">${passRate}%</div></div>
    <div class="stat-card"><div class="label">Duration</div><div class="value time">${durationStr}</div></div>
  </div>

  <div class="bar">
    <div class="pass-bar" style="width:${totalTests > 0 ? (passed / totalTests) * 100 : 0}%"></div>
    <div class="fail-bar" style="width:${totalTests > 0 ? (failed / totalTests) * 100 : 0}%"></div>
    <div class="skip-bar" style="width:${totalTests > 0 ? (skipped / totalTests) * 100 : 0}%"></div>
  </div>

  ${fileRows}
  ${playwrightLink}
</div>
</body>
</html>`;
    res.status(200).type("html").send(html);
  }

  async function serveRunSummaryPage(res: Response, jobId?: string) {
    // Try to get stats from run history
    const history = await loadRunHistory();
    const run = jobId ? history.find((r) => r.jobId === jobId) : history[0];

    if (!run || (run.total === 0 && run.passed === 0 && run.failed === 0)) {
      res.status(200).type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Report ${jobId || ""}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0d11;color:#c9cdd4;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
h1{font-size:20px;color:#e1e3e6;margin-bottom:8px;} p{color:#555d6e;font-size:14px;} code{background:#181b22;padding:2px 8px;border-radius:4px;font-size:12px;color:#8b92a0;}</style>
</head><body><div><h1>No report available</h1><p>${jobId ? `Job <code>${jobId}</code> — ` : ''}Run tests first to generate a report.</p></div></body></html>`);
      return;
    }

    const passed = run.passed ?? 0;
    const failed = run.failed ?? 0;
    const total = run.total ?? 0;
    const skipped = run.skipped ?? 0;
    const durationStr = run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '--';
    const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';
    const statusColor = run.status === 'passed' ? '#4ade80' : run.status === 'failed' ? '#f87171' : '#facc15';

    res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Test Run Summary — ${jobId || ''}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0d11;color:#c9cdd4;min-height:100vh;}
.c{max-width:640px;margin:0 auto;padding:48px 24px;}.h1{font-size:20px;font-weight:600;color:#e1e3e6;margin-bottom:4px;}
.sub{font-size:13px;color:#555d6e;margin-bottom:28px;}.sub code{background:#181b22;padding:2px 8px;border-radius:4px;font-size:11px;color:#8b92a0;}
.status{display:inline-block;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600;text-transform:uppercase;background:${statusColor}20;color:${statusColor};margin-bottom:20px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;}
.s{background:#12151b;border:1px solid #1e2229;border-radius:10px;padding:16px;text-align:center;}
.s .l{font-size:11px;color:#555d6e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
.s .v{font-size:28px;font-weight:700;}
.pass{color:#4ade80;}.fail{color:#f87171;}.skip{color:#facc15;}.tot{color:#e1e3e6;}.rate{color:#60a5fa;}.time{color:#c084fc;}
.bar{height:6px;background:#1e2229;border-radius:3px;overflow:hidden;display:flex;margin-bottom:20px;}
.bar .bp{background:#4ade80;}.bar .bf{background:#f87171;}.bar .bs{background:#facc15;}
.note{font-size:12px;color:#555d6e;margin-top:16px;padding:12px;background:#12151b;border:1px solid #1e2229;border-radius:8px;}
</style></head><body><div class="c">
<h1 class="h1">Test Run Summary</h1>
<p class="sub"><code>${jobId || 'unknown'}</code> &middot; ${run.startTime ? new Date(run.startTime).toLocaleString() : ''} &middot; ${durationStr}</p>
<div class="status">${run.status}</div>
<div class="stats">
  <div class="s"><div class="l">Passed</div><div class="v pass">${passed}</div></div>
  <div class="s"><div class="l">Failed</div><div class="v fail">${failed}</div></div>
  <div class="s"><div class="l">Total</div><div class="v tot">${total}</div></div>
</div>
<div class="bar">
  <div class="bp" style="width:${total > 0 ? (passed / total) * 100 : 0}%"></div>
  <div class="bf" style="width:${total > 0 ? (failed / total) * 100 : 0}%"></div>
  <div class="bs" style="width:${total > 0 ? (skipped / total) * 100 : 0}%"></div>
</div>
<div class="note">Detailed test report (api-report.json) was not preserved for this run. Future runs will show full per-test results here.${run.repo ? ` Repo: <strong>${run.repo}</strong>` : ''}</div>
</div></body></html>`);
  }

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function serveReportPage(res: Response, jobId?: string) {
    const apiPath = jobId ? join(RESULTS_DIR, jobId, "api-report.json") : join(RESULTS_DIR, "api-report.json");
    let apiReport: object | null = null;
    if (existsSync(apiPath)) {
      try {
        apiReport = JSON.parse(await readFile(apiPath, "utf-8"));
      } catch {
        apiReport = null;
      }
    }
    const baseDir = jobId ? join(REPORT_BASE, jobId) : REPORT_BASE;
    const uiExists = existsSync(join(baseDir, "index.html"));
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Test Report</title></head><body>
<h1>Test Report</h1>
${uiExists ? `<p><a href="/report/${jobId || ""}">View Playwright Report</a></p>` : ""}
${apiReport ? `<pre>${JSON.stringify(apiReport, null, 2)}</pre>` : "<p>No report data</p>"}
</body></html>`;
    res.type("html").send(html);
  }

  app.get("/", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      `Auto Testing Server\n\n` +
        `API: GET /api/tests, /api/runs, /api/schedule, /api/kt\n` +
        `POST /api/test/trigger, /api/test/run-files, /api/test/add-cases, /api/test/cancel\n` +
        `POST /api/pr/test, /api/webhook/pr, /api/test/request\n` +
        `POST /api/kt/generate\n` +
        `GET /report, /report/:jobId\n`
    );
  });

  startScheduler(runScheduledTests);

  app.listen(port, () => {
    console.log(`\n🚀 Auto Testing Server: http://localhost:${port}`);
    console.log(`   API: /api/tests, /api/runs, /api/schedule`);
    console.log(`   Report: /report, /report/:jobId\n`);
  });
}
