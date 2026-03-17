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
    const jobId = generateJobId();
    json(res, {
      jobId,
      status: "started",
      reportUrl: `http://localhost:${serverPort}/report/${jobId}`,
    });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: true,
      runUi: true,
    }).catch((err) => console.error("[TEST] Run failed:", err));
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
    const jobId = generateJobId();
    json(res, { jobId, status: "started", reportUrl: `http://localhost:${serverPort}/report/${jobId}` });
    runTests({
      jobId,
      triggerType: "manual",
      runApi: true,
      runUi: true,
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
    const apiPath = jobId ? join(RESULTS_DIR, jobId, "api-report.json") : join(RESULTS_DIR, "api-report.json");

    if (!existsSync(indexPath) && !existsSync(apiPath)) {
      res.status(200).type("html").send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Report ${jobId || ""}</title></head><body>
        <h1>No report${jobId ? ` for job ${jobId}` : ""}</h1>
        <p>Run tests first. Reports available at /report/&lt;jobId&gt;</p>
        </body></html>
      `);
      return;
    }

    if (existsSync(indexPath)) {
      let html = await readFile(indexPath, "utf-8");
      const rootHref = "/";
      const fullHref = jobId ? `${rootHref}report/${jobId}/` : `${rootHref}report/`;
      const baseTag = `<base href="${fullHref}">`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}`);
      } else {
        html = html.replace(/<head\s/, `<head ${baseTag} `);
      }
      // Fix attachment/trace URLs - ensure jobId is in path for data/ and trace/
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
        `POST /api/test/trigger, /api/test/add-cases, /api/test/cancel\n` +
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
