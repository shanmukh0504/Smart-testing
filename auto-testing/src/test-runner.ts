/**
 * Test runner with job-based storage and cleanup (playwright-server style)
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getJobTimestamp } from "./job-id.js";

export type TriggerType = "manual" | "scheduled" | "auto" | "add-cases";

export interface TestRunSummary {
  jobId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  startTime: string;
  endTime?: string;
  triggerType: TriggerType;
  status: "running" | "passed" | "failed" | "cancelled";
  repo?: string;
  branch?: string;
  author?: string;
}

export interface RunHistoryEntry extends TestRunSummary {
  estimatedCompletionTime?: string;
}

const JOB_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_HISTORY_FILE = "run-history.json";

function getHistoryPath(): string {
  return path.join(process.cwd(), "test-results", RUN_HISTORY_FILE);
}

export async function loadRunHistory(): Promise<RunHistoryEntry[]> {
  const p = getHistoryPath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveRunHistory(entries: RunHistoryEntry[]): Promise<void> {
  const dir = path.dirname(getHistoryPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getHistoryPath(), JSON.stringify(entries, null, 2), "utf-8");
}

async function cleanupOldJobReports(): Promise<void> {
  const cwd = process.cwd();
  const outputBaseDir = path.join(cwd, process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results");
  const reportBaseDir = path.join(cwd, process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report");
  const cutoff = Date.now() - JOB_REPORT_TTL_MS;

  const cleanupInBase = async (baseDir: string, label: string) => {
    if (!fs.existsSync(baseDir)) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[REPORT] Failed to read ${label} base directory ${baseDir}:`, err);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobId = entry.name;
      if (!jobId.startsWith("job-")) continue;
      const ts = getJobTimestamp(jobId);
      if (ts == null || ts > cutoff) continue;

      const fullPath = path.join(baseDir, jobId);
      try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        console.log(`[REPORT] Removed expired ${label} for ${jobId}: ${fullPath}`);
      } catch (err) {
        console.warn(`[REPORT] Failed to remove expired ${label} for ${jobId}: ${fullPath}`, err);
      }
    }
  };

  await Promise.all([
    cleanupInBase(outputBaseDir, "test-results"),
    cleanupInBase(reportBaseDir, "playwright-report"),
  ]);
}

let isRunning = false;
let currentJobId: string | null = null;
let abortController: AbortController | null = null;

export function isTestRunning(): boolean {
  return isRunning;
}

export function getCurrentJobId(): string | null {
  return currentJobId;
}

export function cancelRunningTest(): boolean {
  if (!abortController || !isRunning) return false;
  abortController.abort();
  return true;
}

export interface RunProgress {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  completed: number;
  pending: number;
}

function writeProgress(jobId: string, progress: RunProgress): void {
  const dir = path.join(process.cwd(), process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results", jobId);
  const file = path.join(dir, "progress.json");
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(progress), "utf-8");
  } catch { /* ignore */ }
}

function parseProgressFromOutput(stdout: string): Partial<RunProgress> {
  const passedMatch = stdout.match(/(\d+)\s+passed/);
  const failedMatch = stdout.match(/(\d+)\s+failed/);
  const skippedMatch = stdout.match(/(\d+)\s+skipped/);
  let totalMatch = stdout.match(/(\d+)\s+total/);
  if (!totalMatch) {
    const parenMatches = [...stdout.matchAll(/\((\d+)\)/g)];
    if (parenMatches.length) totalMatch = parenMatches[parenMatches.length - 1];
  }
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
  const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed + skipped;
  const completed = passed + failed + skipped;
  return { passed, failed, skipped, total, completed, pending: Math.max(0, total - completed) };
}

function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onProgress?: (jobId: string, progress: RunProgress) => void
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const jobId = env.JOB_ID;

  return new Promise((resolve) => {
    const opts: Parameters<typeof spawn>[2] = {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    };
    if (signal) (opts as any).signal = signal;
    const proc = spawn(cmd, args, opts);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      process.stdout.write(d);
      if (jobId && onProgress) {
        const parsed = parseProgressFromOutput(stdout);
        if (parsed.total !== undefined || parsed.passed !== undefined || parsed.failed !== undefined) {
          const total = parsed.total ?? parsed.completed ?? 0;
          const completed = parsed.completed ?? (parsed.passed ?? 0) + (parsed.failed ?? 0) + (parsed.skipped ?? 0);
          onProgress(jobId, {
            total,
            passed: parsed.passed ?? 0,
            failed: parsed.failed ?? 0,
            skipped: parsed.skipped ?? 0,
            completed,
            pending: Math.max(0, total - completed),
          });
        }
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(d);
      if (jobId && onProgress) {
        const parsed = parseProgressFromOutput(stdout + stderr);
        if (parsed.total !== undefined || parsed.passed !== undefined || parsed.failed !== undefined) {
          const total = parsed.total ?? parsed.completed ?? 0;
          const completed = parsed.completed ?? (parsed.passed ?? 0) + (parsed.failed ?? 0) + (parsed.skipped ?? 0);
          onProgress(jobId, {
            total,
            passed: parsed.passed ?? 0,
            failed: parsed.failed ?? 0,
            skipped: parsed.skipped ?? 0,
            completed,
            pending: Math.max(0, total - completed),
          });
        }
      }
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
    proc.on("error", () => {
      resolve({ exitCode: 1, stdout, stderr });
    });
  });
}

function parseVitestOutput(stdout: string): { passed: number; failed: number; skipped: number; total: number } {
  const passedMatch = stdout.match(/(\d+)\s+passed/);
  const failedMatch = stdout.match(/(\d+)\s+failed/);
  const skippedMatch = stdout.match(/(\d+)\s+skipped/);
  const totalMatch = stdout.match(/(\d+)\s+total/);
  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
    total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
  };
}

function parsePlaywrightOutput(stdout: string): { passed: number; failed: number; skipped: number; total: number } {
  const passedMatch = stdout.match(/(\d+)\s+passed/);
  const failedMatch = stdout.match(/(\d+)\s+failed/);
  const skippedMatch = stdout.match(/(\d+)\s+skipped/);
  const totalMatch = stdout.match(/(\d+)\s+passed.*?(\d+)\s+total/);
  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
    total: totalMatch ? parseInt(totalMatch[2], 10) : 0,
  };
}

export interface RunTestsOptions {
  jobId: string;
  triggerType: TriggerType;
  runApi?: boolean;
  runUi?: boolean;
  rerunFailedOnly?: boolean;
  repo?: string;
  branch?: string;
  author?: string;
}

export interface RunTestsResult {
  jobId: string;
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  startTime: string;
  endTime: string;
  triggerType: TriggerType;
  status: "passed" | "failed" | "cancelled";
}

export async function runTests(options: RunTestsOptions): Promise<RunTestsResult> {
  const { jobId, triggerType, runApi = true, runUi = true, rerunFailedOnly = false, repo, branch, author } = options;

  if (isRunning) {
    throw new Error("Tests are already running");
  }

  isRunning = true;
  currentJobId = jobId;
  abortController = new AbortController();
  const startTime = new Date().toISOString();

  const history: RunHistoryEntry[] = await loadRunHistory();
  const runningEntry: RunHistoryEntry = {
    jobId,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    startTime,
    triggerType,
    status: "running",
    repo,
    branch,
    author,
  };
  history.unshift(runningEntry);
  await saveRunHistory(history);

  writeProgress(jobId, { total: 0, passed: 0, failed: 0, skipped: 0, completed: 0, pending: 0 });

  const env: NodeJS.ProcessEnv = {
    JOB_ID: jobId,
  };

  // Ensure job output dir exists for vitest/playwright
  const outputBase = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
  const jobOutputDir = path.join(process.cwd(), outputBase, jobId);
  if (!fs.existsSync(jobOutputDir)) {
    fs.mkdirSync(jobOutputDir, { recursive: true });
  }

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalTests = 0;
  const startMs = Date.now();
  let cancelled = false;

  const updateProgress = (passed: number, failed: number, skipped: number, total: number) => {
    const progress: RunProgress = {
      total,
      passed,
      failed,
      skipped,
      completed: passed + failed + skipped,
      pending: Math.max(0, total - passed - failed - skipped),
    };
    writeProgress(jobId, progress);
  };

  try {
    if (runApi) {
      const { exitCode, stdout } = await runCommand(
        "npx",
        ["vitest", "run", "--config", "vitest.api.config.ts"],
        env,
        abortController.signal,
        (jid, prog) => {
          updateProgress(prog.passed, prog.failed, prog.skipped, prog.total);
        }
      );
      const stats = parseVitestOutput(stdout);
      totalPassed += stats.passed;
      totalFailed += stats.failed;
      totalSkipped += stats.skipped;
      totalTests += stats.total;
      updateProgress(totalPassed, totalFailed, totalSkipped, totalTests);
      if (exitCode !== 0 && !abortController.signal.aborted) {
        // API failed, continue to UI if requested
      }
    }

    if (runUi && !abortController.signal.aborted) {
      const playwrightArgs = ["playwright", "test"];
      if (rerunFailedOnly) playwrightArgs.push("--last-failed");
      const { exitCode, stdout } = await runCommand(
        "npx",
        playwrightArgs,
        env,
        abortController.signal,
        (jid, prog) => {
          const p = prog.passed + totalPassed;
          const f = prog.failed + totalFailed;
          const s = prog.skipped + totalSkipped;
          const t = totalTests + prog.total;
          updateProgress(p, f, s, t);
        }
      );
      const stats = parsePlaywrightOutput(stdout);
      totalPassed += stats.passed;
      totalFailed += stats.failed;
      totalSkipped += stats.skipped;
      totalTests += stats.total;
      updateProgress(totalPassed, totalFailed, totalSkipped, totalTests);
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      cancelled = true;
    } else {
      throw e;
    }
  } finally {
    isRunning = false;
    currentJobId = null;
    abortController = null;
  }

  const duration = Date.now() - startMs;
  const endTime = new Date().toISOString();

  const result: RunTestsResult = {
    jobId,
    success: !cancelled && totalFailed === 0,
    total: totalTests,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    duration,
    startTime,
    endTime,
    triggerType,
    status: cancelled ? "cancelled" : totalFailed === 0 ? "passed" : "failed",
  };

  // Update history entry
  const updated = await loadRunHistory();
  const idx = updated.findIndex((e) => e.jobId === jobId && e.status === "running");
  if (idx >= 0) {
    updated[idx] = {
      ...updated[idx],
      ...result,
      status: result.status,
      endTime: result.endTime,
    };
    await saveRunHistory(updated);
  }

  await cleanupOldJobReports();
  return result;
}
