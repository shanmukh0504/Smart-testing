/**
 * Schedule storage and cron for test runs (every 4h from 0:00 UTC)
 */

import cron from "node-cron";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface ScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  lastRun?: string;
  lastSuccessfulRun?: string;
  nextRun?: string;
}

const SCHEDULE_FILE = join(process.cwd(), "test-results", "schedule.json");
const DEFAULT_CRON = "0 0,4,8,12,16,20 * * *"; // Every 4 hours from 0:00 UTC

let cronTask: cron.ScheduledTask | null = null;
let runCallback: (() => Promise<void>) | null = null;

export async function loadSchedule(): Promise<ScheduleConfig> {
  if (!existsSync(SCHEDULE_FILE)) {
    return {
      enabled: true,
      cronExpression: DEFAULT_CRON,
    };
  }
  try {
    const raw = await readFile(SCHEDULE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled ?? true,
      cronExpression: parsed.cronExpression ?? DEFAULT_CRON,
      lastRun: parsed.lastRun,
      lastSuccessfulRun: parsed.lastSuccessfulRun,
      nextRun: parsed.nextRun,
    };
  } catch {
    return { enabled: true, cronExpression: DEFAULT_CRON };
  }
}

export async function saveSchedule(config: Partial<ScheduleConfig>): Promise<ScheduleConfig> {
  const current = await loadSchedule();
  const updated = { ...current, ...config };
  const dir = join(process.cwd(), "test-results");
  if (!existsSync(dir)) {
    const { mkdir } = await import("fs/promises");
    await mkdir(dir, { recursive: true });
  }
  await writeFile(SCHEDULE_FILE, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

export function getNextRun(cronExpression: string): string {
  const parts = cronExpression.split(" ");
  if (parts.length < 5) return "";
  const now = new Date();
  const minutePart = parts[0];
  const hourPart = parts[1];
  const minutes = minutePart.includes(",") ? minutePart.split(",").map((x) => parseInt(x, 10)) : [parseInt(minutePart, 10) || 0];
  const hours = hourPart.includes(",") ? hourPart.split(",").map((x) => parseInt(x, 10)).sort((a, b) => a - b) : [parseInt(hourPart, 10) || 0];
  const nowHour = now.getUTCHours();
  const nowMin = now.getUTCMinutes();
  for (const h of hours) {
    for (const m of minutes) {
      const next = new Date(now);
      next.setUTCHours(h, m, 0, 0);
      if (next > now) return next.toISOString();
    }
  }
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(hours[0], minutes[0], 0, 0);
  return next.toISOString();
}

export function startScheduler(callback: () => Promise<void>): void {
  runCallback = callback;
  loadSchedule().then((config) => {
    if (config.enabled && runCallback) {
      cronTask = cron.schedule(config.cronExpression, async () => {
        if (runCallback) {
          await runCallback();
        }
      }, { timezone: "UTC" });
      console.log(`[SCHEDULER] Cron started: ${config.cronExpression} (UTC)`);
    }
  });
}

export function stopScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  runCallback = null;
}

export function updateSchedulerCron(cronExpression: string): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (runCallback) {
    cronTask = cron.schedule(cronExpression, async () => {
      if (runCallback) await runCallback();
    }, { timezone: "UTC" });
  }
}
