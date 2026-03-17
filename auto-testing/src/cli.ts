#!/usr/bin/env node
/**
 * CLI for Auto Testing Agent
 */

import "dotenv/config";
import { Command } from "commander";
import { readFile } from "fs/promises";
import { resolve } from "path";
import chalk from "chalk";
import { AutoTestingAgent } from "./agent.js";
import { createGitProvider } from "./git-provider.js";
import { RepoTestConfigSchema } from "./config.js";
import type { TestPrompt } from "./test-generator.js";
import { startReportServer } from "./report-server.js";
import { startServer } from "./server.js";

const program = new Command();

program
  .name("auto-test")
  .description("AI-powered automatic testing agent for frontend and backend")
  .version("1.0.0");

program
  .command("bootstrap")
  .description("Fetch recent repos and build context from READMEs")
  .option("-c, --config <path>", "Path to test config", "config/test-config.json")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    console.log(chalk.blue("Bootstrapping: fetching repos and analyzing..."));
    await agent.bootstrap();
    const repos = agent.getRepoInfos();
    console.log(chalk.green(`Found ${repos.length} repos:`));
    repos.forEach((r) =>
      console.log(`  - ${r.fullName}${r.description ? ` — ${r.description}` : ""}`)
    );
  });

program
  .command("generate")
  .description("Generate tests from a prompt (URL + context)")
  .option("-u, --url <url>", "URL of UI or API to test")
  .option("-t, --type <type>", "frontend or backend")
  .option("-c, --context <text>", "Context to identify repo and what to test")
  .option("--config <path>", "Path to test config", "config/test-config.json")
  .option("--repo <name>", "Repo full name (owner/repo) to use")
  .option("--api-base <url>", "API base URL (for backend)")
  .option("-p, --prompt-file <path>", "Read prompt from JSON file: {url, type, context, apiBaseUrl?}")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    await agent.bootstrap();

    let prompt: TestPrompt;
    if (opts.promptFile) {
      const data = JSON.parse(
        await readFile(resolve(process.cwd(), opts.promptFile), "utf-8")
      );
      prompt = {
        url: data.url,
        context: data.context,
        type: data.type,
        apiBaseUrl: data.apiBaseUrl,
        sampleResponse: data.sampleResponse,
      };
    } else {
      if (!opts.url || !opts.type || !opts.context) {
        console.error(chalk.red("Error: --url, --type, and --context are required (or use --prompt-file)"));
        process.exit(1);
      }
      prompt = {
        url: opts.url,
        context: opts.context,
        type: opts.type as "frontend" | "backend",
        apiBaseUrl: opts.apiBase,
      };
    }

    console.log(chalk.blue("Generating tests..."));
    const tests = await agent.generateTests({
      prompt,
      repoHint: opts.repo,
    });
    console.log(chalk.green(`Generated ${tests.length} test file(s)`));
    tests.forEach((t) => console.log(`  - ${t.filename}`));
  });

program
  .command("generate-and-run")
  .description("Generate tests from prompt and run them (Playwright for UI, Vitest for API)")
  .option("-u, --url <url>", "URL of UI or API to test")
  .option("-t, --type <type>", "frontend or backend")
  .option("-c, --context <text>", "Context to identify repo and what to test")
  .option("--config <path>", "Path to test config", "config/test-config.json")
  .option("--repo <name>", "Repo full name (owner/repo) to use")
  .option("--api-base <url>", "API base URL (for backend)")
  .option("-p, --prompt-file <path>", "Read prompt from JSON file: {url, type, context, apiBaseUrl?}")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    await agent.bootstrap();

    let prompt: TestPrompt;
    if (opts.promptFile) {
      const data = JSON.parse(
        await readFile(resolve(process.cwd(), opts.promptFile), "utf-8")
      );
      prompt = {
        url: data.url,
        context: data.context,
        type: data.type,
        apiBaseUrl: data.apiBaseUrl,
        sampleResponse: data.sampleResponse,
      };
    } else {
      if (!opts.url || !opts.type || !opts.context) {
        console.error(chalk.red("Error: --url, --type, and --context are required (or use --prompt-file)"));
        process.exit(1);
      }
      prompt = {
        url: opts.url,
        context: opts.context,
        type: opts.type as "frontend" | "backend",
        apiBaseUrl: opts.apiBase,
      };
    }

    console.log(chalk.blue("Generating tests..."));
    const tests = await agent.generateTests({
      prompt,
      repoHint: opts.repo,
    });
    console.log(chalk.green(`Generated ${tests.length} test file(s)`));
    tests.forEach((t) => console.log(`  - ${t.filename}`));

    const { spawn } = await import("child_process");
    const run = (cmd: string, args: string[]) =>
      new Promise<number>((resolve) => {
        const proc = spawn(cmd, args, { stdio: "inherit", cwd: process.cwd() });
        proc.on("exit", (code: number | null) => resolve(code ?? 0));
      });

    let exitCode = 0;
    const hasApi = tests.some((t) => t.type === "backend");
    const hasUi = tests.some((t) => t.type === "frontend");

    if (hasApi) {
      console.log(chalk.blue("\nRunning API tests (Vitest)..."));
      exitCode = await run("npx", ["vitest", "run", "--config", "vitest.api.config.ts"]);
    }
    if (hasUi && exitCode === 0) {
      console.log(chalk.blue("\nRunning UI tests (Playwright)..."));
      exitCode = await run("npx", ["playwright", "test"]);
    }
    if (!hasApi && !hasUi) {
      console.log(chalk.yellow("No tests to run."));
    }
    if (hasApi || hasUi) {
      console.log(chalk.cyan("\n📊 Reports:"));
      if (hasApi) console.log(chalk.gray("  API:  test-results/api-report.json"));
      if (hasUi) console.log(chalk.gray("  UI:   playwright-report/index.html"));
      console.log(chalk.gray("  View: npm run report  →  http://localhost:8080/report"));
    }
    process.exit(exitCode);
  });

program
  .command("report")
  .description("Start report server at http://localhost:8080/report")
  .option("-p, --port <number>", "Port for report server", "8080")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    console.log(chalk.blue("Starting report server..."));
    await startReportServer(port);
    console.log(chalk.green("Report server running. Press Ctrl+C to stop."));
    await new Promise(() => {});
  });

program
  .command("server")
  .description("Start server: POST /test to run tests, GET /report to view results")
  .option("-p, --port <number>", "Port", process.env.PORT || "8080")
  .action((opts) => {
    const port = parseInt(opts.port, 10);
    startServer(port);
  });

program
  .command("kt")
  .description("Generate or view KT (Knowledge Transfer) document for a repo")
  .requiredOption("-r, --repo <name>", "Repo full name (owner/repo)")
  .option("--config <path>", "Path to test config", "config/test-config.json")
  .option("--view", "View existing KT without regenerating")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    await agent.bootstrap();

    if (opts.view) {
      const kt = await agent.getKT(opts.repo);
      if (!kt) {
        console.log(chalk.yellow(`No KT found for ${opts.repo}`));
        return;
      }
      console.log(chalk.green(`KT for ${opts.repo} (generated ${kt.kt.generated_at}):`));
      console.log(chalk.blue(`  Architecture: ${kt.kt.architecture.slice(0, 200)}...`));
      console.log(chalk.blue(`  Modules: ${kt.kt.modules.length}`));
      kt.kt.modules.forEach((m) => console.log(`    - ${m.name}: ${m.description}`));
      console.log(chalk.blue(`  APIs: ${kt.kt.apis.length}`));
      kt.kt.apis.forEach((a) => console.log(`    - ${a.method} ${a.endpoint}: ${a.description}`));
      console.log(chalk.blue(`  UI Components: ${kt.kt.ui_components.length}`));
      kt.kt.ui_components.forEach((c) => console.log(`    - ${c.name}: ${c.description}`));
      console.log(chalk.blue(`  Tests: API=${kt.tests.api.length}, UI=${kt.tests.playwright.length}`));
      return;
    }

    console.log(chalk.blue(`Generating KT for ${opts.repo}...`));
    const { kt, freshlyGenerated } = await agent.ensureKT(opts.repo);
    if (freshlyGenerated) {
      console.log(chalk.green(`Generated new KT for ${opts.repo}`));
    } else {
      console.log(chalk.green(`Loaded existing KT for ${opts.repo} (generated ${kt.kt.generated_at})`));
    }
    console.log(`  Modules: ${kt.kt.modules.length}`);
    console.log(`  APIs: ${kt.kt.apis.length}`);
    console.log(`  UI Components: ${kt.kt.ui_components.length}`);
  });

program
  .command("pr")
  .description("PR Mode: Analyze a PR and generate tests for changed files")
  .requiredOption("-r, --repo <name>", "Repo full name (owner/repo)")
  .requiredOption("-n, --pr-number <number>", "PR number")
  .option("--config <path>", "Path to test config", "config/test-config.json")
  .option("--run", "Run generated tests after generation")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    await agent.bootstrap();

    console.log(chalk.blue(`Analyzing PR #${opts.prNumber} for ${opts.repo}...`));
    const report = await agent.handlePR({
      repo: opts.repo,
      prNumber: parseInt(opts.prNumber, 10),
    });

    console.log(chalk.green(`\nPR #${report.prNumber}: ${report.headBranch} -> ${report.baseBranch}`));
    console.log(`  Changed files: ${report.summary.totalChangedFiles}`);
    console.log(`    Added: ${report.summary.addedFiles}, Modified: ${report.summary.modifiedFiles}, Removed: ${report.summary.removedFiles}`);
    console.log(`  Tests generated: ${report.summary.testsCreated}`);
    report.testsGenerated.forEach((t) => console.log(`    - ${t.filename}`));

    if (opts.run && report.testsGenerated.length > 0) {
      const { generateJobId } = await import("./job-id.js");
      const { runTests } = await import("./test-runner.js");
      const jobId = generateJobId();
      const hasApi = report.testsGenerated.some((t) => t.type === "backend");
      const hasUi = report.testsGenerated.some((t) => t.type === "frontend");
      console.log(chalk.blue("\nRunning generated tests..."));
      const result = await runTests({
        jobId,
        triggerType: "auto",
        runApi: hasApi,
        runUi: hasUi,
        repo: opts.repo,
        branch: report.headBranch,
      });
      console.log(chalk.green(`\nResults: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`));
    }
  });

program
  .command("test-request")
  .description("Test Request Mode: Generate tests for a specific module/feature")
  .requiredOption("-r, --repo <name>", "Repo full name (owner/repo)")
  .option("-m, --module <name>", "Specific module name to test")
  .option("-t, --type <type>", "Test type: frontend or backend")
  .option("--api-base <url>", "API base URL override")
  .option("--ui-base <url>", "UI base URL override")
  .option("--config <path>", "Path to test config", "config/test-config.json")
  .option("--run", "Run generated tests after generation")
  .action(async (opts) => {
    const config = await loadConfig(opts.config);
    const agent = createAgent(config);
    await agent.bootstrap();

    console.log(chalk.blue(`Test request for ${opts.repo}${opts.module ? ` module: ${opts.module}` : ""}...`));
    const result = await agent.handleTestRequest({
      repo: opts.repo,
      module: opts.module,
      type: opts.type as "frontend" | "backend" | undefined,
      apiBaseUrl: opts.apiBase,
      uiBaseUrl: opts.uiBase,
    });

    console.log(chalk.green(`\nTests generated: ${result.testsGenerated.length}`));
    result.testsGenerated.forEach((t) => console.log(`  - ${t.filename}`));
    if (result.ktUpdated) {
      console.log(chalk.yellow(`KT updated: ${result.ktUpdateSummary || "yes"}`));
    }

    if (opts.run && result.testsGenerated.length > 0) {
      const { generateJobId } = await import("./job-id.js");
      const { runTests } = await import("./test-runner.js");
      const jobId = generateJobId();
      const hasApi = result.testsGenerated.some((t) => t.type === "backend");
      const hasUi = result.testsGenerated.some((t) => t.type === "frontend");
      console.log(chalk.blue("\nRunning generated tests..."));
      const testResult = await runTests({
        jobId,
        triggerType: "auto",
        runApi: hasApi,
        runUi: hasUi,
        repo: opts.repo,
      });
      console.log(chalk.green(`\nResults: ${testResult.passed} passed, ${testResult.failed} failed, ${testResult.skipped} skipped`));
    }
  });

program
  .command("run")
  .description("Run generated tests")
  .option("--ui", "Run only UI (Playwright) tests")
  .option("--api", "Run only API tests")
  .action(async (opts) => {
    const runApi = opts.api || (!opts.ui && !opts.api);
    const runUi = opts.ui || (!opts.ui && !opts.api);

    const { spawn } = await import("child_process");
    const run = (cmd: string, args: string[]) =>
      new Promise<number>((resolve) => {
        const proc = spawn(cmd, args, { stdio: "inherit", cwd: process.cwd() });
        proc.on("exit", (code: number | null) => resolve(code ?? 0));
      });

    let exitCode = 0;
    if (runApi) {
      console.log(chalk.blue("Running API tests..."));
      exitCode = await run("npx", ["vitest", "run", "--config", "vitest.api.config.ts"]);
    }
    if (runUi && exitCode === 0) {
      console.log(chalk.blue("Running UI tests..."));
      exitCode = await run("npx", ["playwright", "test"]);
    }
    if (runApi || runUi) {
      console.log(chalk.cyan("\n📊 Reports:"));
      if (runApi) console.log(chalk.gray("  API:  test-results/api-report.json"));
      if (runUi) console.log(chalk.gray("  UI:   playwright-report/index.html"));
      console.log(chalk.gray("  View: npm run report  →  http://localhost:8080/report"));
    }
    process.exit(exitCode);
  });

async function loadConfig(path: string) {
  const fullPath = resolve(process.cwd(), path);
  try {
    const raw = await readFile(fullPath, "utf-8");
    const parsed = JSON.parse(raw);
    return RepoTestConfigSchema.parse(parsed);
  } catch (err) {
    console.warn(
      chalk.yellow(`Config not found or invalid at ${path}, using defaults`)
    );
    return RepoTestConfigSchema.parse({});
  }
}

function createAgent(config: ReturnType<typeof RepoTestConfigSchema.parse>) {
  return new AutoTestingAgent({
    gitProvider: createGitProvider(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeModel: process.env.CLAUDE_MODEL,
    config,
  });
}

program.parse();
