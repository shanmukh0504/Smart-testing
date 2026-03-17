/**
 * KT (Knowledge Transfer) persistent storage per repo.
 * Stores KT documents in memory/{repo-name}/{repo-name}.json
 * Stores repo settings in memory/{repo-name}/settings.json
 */

import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const KT_DIR = join(process.cwd(), "memory");

export interface KTModule {
  name: string;
  description: string;
  path: string;
  last_modified: string;
}

export interface KTApiParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface KTApi {
  endpoint: string;
  method: string;
  description: string;
  params?: string[];
  queryParams?: string[];
  bodyFields?: string[];
  authRequired?: boolean;
  responseShape?: string;
  /** Structured required parameters */
  requiredParams?: KTApiParam[];
  /** Structured optional parameters */
  optionalParams?: KTApiParam[];
  /** Request body schema */
  requestBody?: { fields: KTApiParam[] };
  /** Response format example or schema */
  responseFormat?: string;
  /** Auth type: "bearer", "apiKey", "none" */
  authType?: string;
  /** Auth header name (e.g., "Authorization", "X-API-Key") */
  authHeader?: string;
}

export interface KTUIButton {
  text: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  type?: string;
  role?: string;
}

export interface KTUIComponent {
  name: string;
  path: string;
  description: string;
  testIds?: string[];
  ariaLabels?: string[];
  htmlIds?: string[];
  placeholders?: string[];
  textContent?: string[];
  formFields?: string[];
  /** Buttons with their styles and identifying info */
  buttons?: KTUIButton[];
  /** Key element styles/classes for identification */
  elementStyles?: { selector: string; classes: string; text?: string }[];
  /** Distinguishing factors for identifying this component in UI */
  distinguishingFactors?: string[];
}

/** Repo settings stored alongside KT */
export interface RepoSettings {
  /** Whether repo is frontend or backend */
  repoType: "frontend" | "backend";
  /** Auth configuration for backend repos */
  auth?: {
    type: "bearer" | "apiKey" | "none";
    headerName?: string;
    value?: string;
  };
  /** Per-endpoint param overrides: endpoint -> param values */
  endpointParams?: Record<string, Record<string, string>>;
}

export interface KTDocument {
  generated_at: string;
  architecture: string;
  modules: KTModule[];
  apis: KTApi[];
  ui_components: KTUIComponent[];
}

export interface KTTestSuite {
  unit: string[];
  integration: string[];
  playwright: string[];
  api: string[];
}

export interface RepoKT {
  kt: KTDocument;
  tests: KTTestSuite;
}

function getSafeName(repoName: string): string {
  return repoName.replace(/\//g, "-");
}

function getRepoDir(repoName: string): string {
  return join(KT_DIR, getSafeName(repoName));
}

function getKTPath(repoName: string): string {
  const safeName = getSafeName(repoName);
  return join(getRepoDir(repoName), `${safeName}.json`);
}

function getSettingsPath(repoName: string): string {
  return join(getRepoDir(repoName), "settings.json");
}

/** Legacy flat path for migration */
function getLegacyKTPath(repoName: string): string {
  const safeName = getSafeName(repoName);
  return join(KT_DIR, `${safeName}.json`);
}

export async function loadKT(repoName: string): Promise<RepoKT | null> {
  const p = getKTPath(repoName);
  // Try new path first, then legacy flat path
  const pathToRead = existsSync(p) ? p : getLegacyKTPath(repoName);
  if (!existsSync(pathToRead)) return null;
  try {
    const raw = await readFile(pathToRead, "utf-8");
    return JSON.parse(raw) as RepoKT;
  } catch {
    return null;
  }
}

export async function saveKT(repoName: string, data: RepoKT): Promise<void> {
  const dir = getRepoDir(repoName);
  await mkdir(dir, { recursive: true });
  const p = getKTPath(repoName);
  await writeFile(p, JSON.stringify(data, null, 2), "utf-8");
  // Clean up legacy flat file if it exists
  const legacy = getLegacyKTPath(repoName);
  if (existsSync(legacy) && legacy !== p) {
    try { await rm(legacy); } catch { /* ignore */ }
  }
}

export async function listKTs(): Promise<string[]> {
  if (!existsSync(KT_DIR)) return [];
  const entries = await readdir(KT_DIR, { withFileTypes: true });
  const repos: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Check if directory contains a KT json file
      const ktFile = join(KT_DIR, entry.name, `${entry.name}.json`);
      if (existsSync(ktFile)) {
        repos.push(entry.name);
      }
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      // Legacy flat files
      repos.push(entry.name.replace(".json", ""));
    }
  }
  return [...new Set(repos)];
}

export async function deleteKT(repoName: string): Promise<void> {
  const dir = getRepoDir(repoName);
  if (existsSync(dir)) {
    await rm(dir, { recursive: true });
  }
  // Also clean up legacy flat file
  const legacy = getLegacyKTPath(repoName);
  if (existsSync(legacy)) {
    await rm(legacy);
  }
}

// ─── Repo Settings ───────────────────────────────────────────

export async function loadRepoSettings(repoName: string): Promise<RepoSettings | null> {
  const p = getSettingsPath(repoName);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as RepoSettings;
  } catch {
    return null;
  }
}

export async function saveRepoSettings(repoName: string, settings: RepoSettings): Promise<void> {
  const dir = getRepoDir(repoName);
  await mkdir(dir, { recursive: true });
  const p = getSettingsPath(repoName);
  await writeFile(p, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Check if a module in the KT is stale (modified after KT generation)
 */
export function isModuleStale(kt: KTDocument, moduleLastModified: string): boolean {
  const ktTime = new Date(kt.generated_at).getTime();
  const moduleTime = new Date(moduleLastModified).getTime();
  return moduleTime > ktTime;
}

/**
 * Merge new tests into existing test suite without duplicates
 */
export function mergeTestSuites(existing: KTTestSuite, incoming: KTTestSuite): KTTestSuite {
  const dedup = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    unit: dedup(existing.unit, incoming.unit),
    integration: dedup(existing.integration, incoming.integration),
    playwright: dedup(existing.playwright, incoming.playwright),
    api: dedup(existing.api, incoming.api),
  };
}
