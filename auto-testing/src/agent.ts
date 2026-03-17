/**
 * Main orchestrator - Auto Testing Agent
 * Supports two modes: PR Mode and Test Request Mode
 * Includes KT (Knowledge Transfer) generation and persistence
 *
 * All repo context flows through the KT document — no separate RepoAnalyzer needed.
 */

import type { GitProvider, PRDiffFile } from "./git-provider.js";
import { TestGenerator, TestPrompt, GeneratedTest } from "./test-generator.js";
import { KTGenerator } from "./kt-generator.js";
import { createClaudeClient } from "./claude-client.js";
import {
  loadKT,
  saveKT,
  isModuleStale,
  mergeTestSuites,
  loadRepoSettings,
  type RepoKT,
  type KTDocument,
  type KTTestSuite,
  type KTApi,
  type KTUIComponent,
  type RepoMetadata,
} from "./kt-store.js";
import { cloneRepo } from "./repo-cloner.js";
import type { RepoTestConfig } from "./config.js";
import { writeFile, mkdir, readdir, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface AgentOptions {
  gitProvider: GitProvider;
  anthropicApiKey?: string;
  claudeModel?: string;
  config: RepoTestConfig;
  outputDir?: string;
}

export interface RunOptions {
  /** User prompt: URL + context */
  prompt: TestPrompt;
  /** Optional: specific repo full name to use */
  repoHint?: string;
}

export interface PRModeOptions {
  /** Repository full name (owner/repo) */
  repo: string;
  /** PR number */
  prNumber: number;
}

export interface PRTestReport {
  repo: string;
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  changedFiles: PRDiffFile[];
  testsGenerated: GeneratedTest[];
  summary: {
    totalChangedFiles: number;
    addedFiles: number;
    modifiedFiles: number;
    removedFiles: number;
    testsCreated: number;
  };
  ktUpdated: boolean;
}

export interface TestRequestOptions {
  /** Repository full name (owner/repo) */
  repo: string;
  /** Specific module or feature to test */
  module?: string;
  /** Test type */
  type?: "frontend" | "backend";
  /** API base URL override */
  apiBaseUrl?: string;
  /** UI base URL override */
  uiBaseUrl?: string;
}

export interface TestRequestResult {
  repo: string;
  testsGenerated: GeneratedTest[];
  ktUpdated: boolean;
  ktUpdateSummary?: string;
}

/** Lightweight repo info cached during bootstrap */
interface RepoInfo {
  fullName: string;
  name: string;
  description: string;
}

export class AutoTestingAgent {
  private git: GitProvider;
  private generator: TestGenerator;
  private ktGenerator: KTGenerator;
  private config: RepoTestConfig;
  private outputDir: string;
  private repoInfoCache: Map<string, RepoInfo> = new Map();
  private repoClonePaths: Map<string, string> = new Map();

  constructor(options: AgentOptions) {
    this.git = options.gitProvider;

    const client = createClaudeClient(options.anthropicApiKey, options.claudeModel);
    this.generator = new TestGenerator(client);
    this.ktGenerator = new KTGenerator(client);

    this.config = options.config;
    this.outputDir = options.outputDir || "./generated-tests";
  }

  // ─── Repo Metadata ──────────────────────────────────────────

  /**
   * Build RepoMetadata by fetching from git provider and reading README.
   */
  private async getRepoMetadata(repoFullName: string): Promise<RepoMetadata> {
    const [owner, repoName] = repoFullName.split("/");
    const gitRepo = await this.git.getRepo(owner, repoName);

    let readmeContent = "";

    // Try from local clone first
    const clonePath = this.repoClonePaths.get(repoFullName);
    if (clonePath) {
      for (const name of ["README.md", "README.MD", "readme.md", "Readme.md"]) {
        const p = join(clonePath, name);
        if (existsSync(p)) {
          readmeContent = await readFile(p, "utf-8");
          break;
        }
      }
    }

    // Fall back to git API
    if (!readmeContent) {
      const branch = gitRepo.default_branch || "main";
      for (const name of ["README.md", "README.MD", "readme.md", "Readme.md"]) {
        try {
          readmeContent = await this.git.getFile(owner, repoName, name, branch);
          break;
        } catch { /* try next */ }
      }
    }

    return {
      fullName: gitRepo.full_name,
      name: repoName,
      description: gitRepo.description || "",
      readmeContent: readmeContent || "(No README found)",
    };
  }

  // ─── KT Management ────────────────────────────────────────────

  /**
   * Ensure KT exists for a repo. If not, generate and save it from main branch.
   * This ONLY handles KT generation/persistence — tests are generated separately via ensureTests().
   * Returns the KT document and whether it was freshly generated.
   */
  async ensureKT(repoFullName: string): Promise<{ kt: RepoKT; freshlyGenerated: boolean }> {
    const existing = await loadKT(repoFullName);
    if (existing) {
      console.log(`[KT] Loaded existing KT for ${repoFullName} (generated ${existing.kt.generated_at})`);
      return { kt: existing, freshlyGenerated: false };
    }

    console.log(`[KT] No KT found for ${repoFullName}. Generating from main branch...`);

    // Ensure we have a clone
    let clonePath = this.repoClonePaths.get(repoFullName);
    if (!clonePath) {
      try {
        const [owner, repoName] = repoFullName.split("/");
        const gitRepo = await this.git.getRepo(owner, repoName);
        clonePath = await cloneRepo(this.git, gitRepo);
        this.repoClonePaths.set(repoFullName, clonePath);
        console.log(`[KT] Cloned repo to ${clonePath}`);
      } catch (err) {
        console.warn(`[KT] Could not clone repo for KT scanning:`, err);
      }
    }

    const metadata = await this.getRepoMetadata(repoFullName);

    // Generate KT document (scanner collects data, AI analyzes it)
    const ktDoc = await this.ktGenerator.generateKT(metadata, clonePath);
    console.log(
      `[KT] Generated KT: ${ktDoc.modules.length} modules, ${ktDoc.apis.length} APIs, ${ktDoc.ui_components.length} UI components`
    );

    // Save KT immediately with empty test suite — tests are generated separately
    const repoKT: RepoKT = {
      kt: ktDoc,
      tests: { unit: [], integration: [], playwright: [], api: [] },
    };
    await saveKT(repoFullName, repoKT);
    console.log(`[KT] Saved KT to memory for ${repoFullName}`);

    return { kt: repoKT, freshlyGenerated: true };
  }

  /**
   * Generate tests for a repo that already has a KT but no tests.
   * Called when "Generate Knowledge" is pressed and KT exists but tests are missing.
   */
  async ensureTests(repoFullName: string): Promise<void> {
    const existing = await loadKT(repoFullName);
    if (!existing) {
      console.warn(`[KT] No KT found for ${repoFullName}, cannot generate tests without KT`);
      return;
    }

    const testSuite = await this.generateFullTestSuite(repoFullName, existing.kt);

    // Merge new tests with any existing ones and save
    const merged = mergeTestSuites(existing.tests, testSuite);
    await saveKT(repoFullName, { ...existing, tests: merged });
    console.log(
      `[KT] Generated tests for ${repoFullName}: ${testSuite.api.length} API, ${testSuite.playwright.length} UI`
    );
  }

  /**
   * Generate a full test suite for all modules in a repo.
   * Generates per-group (API group / UI component group) and saves each file immediately.
   */
  private async generateFullTestSuite(
    repoFullName: string,
    ktDoc: KTDocument
  ): Promise<KTTestSuite> {
    const suite: KTTestSuite = { unit: [], integration: [], playwright: [], api: [] };

    const repoName = ktDoc.repoName || repoFullName.split("/").pop() || "";
    const repoDir = repoName.replace(/\//g, "-");

    // Clear existing test files before generating fresh ones
    const dir = join(this.outputDir, repoDir);
    await mkdir(dir, { recursive: true });
    try {
      const existing = await readdir(dir);
      for (const f of existing) {
        if (f.endsWith(".spec.ts")) await rm(join(dir, f));
      }
    } catch { /* dir might not exist */ }

    // Generate API tests — one call per API group, saved immediately
    const apiBaseUrl =
      this.config.apiBaseUrls[repoFullName] ||
      this.config.apiBaseUrls[repoName];
    if (apiBaseUrl && ktDoc.apis.length > 0) {
      const apiGroups = this.groupAPIs(ktDoc.apis);
      for (const [groupName, apis] of apiGroups) {
        try {
          console.log(`[KT] Generating API tests: ${groupName} (${apis.length} endpoints)`);
          const scopedKT: KTDocument = { ...ktDoc, apis };
          const prompt: TestPrompt = {
            url: apiBaseUrl,
            context: `API tests for the "${groupName}" feature. Test these specific endpoints: ${apis.map(a => `${a.method} ${a.endpoint}`).join(", ")}. ${ktDoc.description}`,
            type: "backend",
            apiBaseUrl,
            kt: scopedKT,
          };
          const tests = await this.generator.generateBackendTests(prompt, apiBaseUrl);
          // Force filenames based on group name — Claude often returns generic "api.spec.ts"
          for (let i = 0; i < tests.length; i++) {
            tests[i].filename = tests.length === 1
              ? `${groupName}.api.spec.ts`
              : `${groupName}-${i + 1}.api.spec.ts`;
          }
          await this.appendTests(tests, repoDir);
          suite.api.push(...tests.map((t) => t.filename));
          console.log(`[KT] Saved API test(s) for ${groupName}: ${tests.map(t => t.filename).join(", ")}`);
        } catch (err) {
          console.warn(`[KT] Failed to generate API tests for ${groupName}:`, err);
        }
      }
    }

    // Generate UI tests — one call per component group, saved immediately
    const uiBaseUrl =
      this.config.uiBaseUrls[repoFullName] ||
      this.config.uiBaseUrls[repoName];
    if (uiBaseUrl && ktDoc.ui_components.length > 0) {
      const uiGroups = this.groupComponents(ktDoc.ui_components);
      for (const [groupName, components] of uiGroups) {
        try {
          console.log(`[KT] Generating UI tests: ${groupName} (${components.length} components)`);
          const scopedKT: KTDocument = { ...ktDoc, ui_components: components };
          const prompt: TestPrompt = {
            url: uiBaseUrl,
            context: `UI tests for the "${groupName}" feature. Test these specific components: ${components.map(c => c.name).join(", ")}. ${ktDoc.description}`,
            type: "frontend",
            kt: scopedKT,
          };
          const tests = await this.generator.generateFrontendTests(prompt);
          // Force filenames based on group name — Claude often returns generic "ui.spec.ts"
          for (let i = 0; i < tests.length; i++) {
            tests[i].filename = tests.length === 1
              ? `${groupName}.ui.spec.ts`
              : `${groupName}-${i + 1}.ui.spec.ts`;
          }
          await this.appendTests(tests, repoDir);
          suite.playwright.push(...tests.map((t) => t.filename));
          console.log(`[KT] Saved UI test(s) for ${groupName}: ${tests.map(t => t.filename).join(", ")}`);
        } catch (err) {
          console.warn(`[KT] Failed to generate UI tests for ${groupName}:`, err);
        }
      }
    }

    return suite;
  }

  /**
   * Group API endpoints by logical feature (SDK method group or REST path prefix).
   */
  private groupAPIs(apis: KTApi[]): Map<string, KTApi[]> {
    const groups = new Map<string, KTApi[]>();
    for (const api of apis) {
      const endpoint = api.endpoint;
      let groupName: string;

      if (endpoint.includes(".")) {
        // SDK-style: "orderbook.getOrders" → "get-orders", "orderbook.search (address)" → "search"
        const method = endpoint.split(".").pop() || endpoint;
        const clean = method.replace(/\s*\(.*\)/, ""); // strip "(address)" etc
        groupName = clean.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
      } else {
        // REST-style: "/api/users/list" → "users"
        const parts = endpoint.replace(/\[.*?\]/g, "").split("/").filter(Boolean);
        groupName = parts.find((p: string) => !["api", "v1", "v2", "v3"].includes(p)) || parts[0] || "api";
      }

      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(api);
    }
    return groups;
  }

  /**
   * Group UI components by their directory path.
   */
  private groupComponents(components: KTUIComponent[]): Map<string, KTUIComponent[]> {
    const groups = new Map<string, KTUIComponent[]>();
    for (const comp of components) {
      const parts = comp.path.split("/");
      // Find the meaningful directory name (skip src/, components/)
      const meaningful = parts.slice(0, -1).filter((p: string) => !["src", "components"].includes(p));
      const groupName = (meaningful.length > 0 ? meaningful[meaningful.length - 1] : parts[0] || "root").toLowerCase();

      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(comp);
    }
    return groups;
  }

  // ─── PR Mode ──────────────────────────────────────────────────

  /**
   * PR Mode: Analyze a pull request, generate tests for changes, and report.
   * 1. Ensure KT exists
   * 2. Fetch PR diff
   * 3. Generate tests for changed files
   * 4. Return report (test execution handled by caller)
   */
  async handlePR(options: PRModeOptions): Promise<PRTestReport> {
    const { repo, prNumber } = options;
    const [owner, repoName] = repo.split("/");

    console.log(`[PR] Processing PR #${prNumber} for ${repo}`);

    // Step 1: KT check
    const { kt } = await this.ensureKT(repo);

    // Step 2: Git diff analysis
    const pr = await this.git.getPullRequest(owner, repoName, prNumber);
    const changedFiles = await this.git.getPRDiff(owner, repoName, prNumber);

    console.log(
      `[PR] PR #${prNumber}: "${pr.title}" (${pr.head_branch} -> ${pr.base_branch})`
    );
    console.log(`[PR] ${changedFiles.length} files changed`);

    const added = changedFiles.filter((f) => f.status === "added");
    const modified = changedFiles.filter((f) => f.status === "modified");
    const removed = changedFiles.filter((f) => f.status === "removed");

    // Step 3: Generate tests for changes
    const diffContext = this.buildDiffContext(changedFiles, kt.kt);
    const testsGenerated: GeneratedTest[] = [];

    const hasBackendChanges = changedFiles.some((f) =>
      this.isBackendFile(f.filename)
    );
    const hasFrontendChanges = changedFiles.some((f) =>
      this.isFrontendFile(f.filename)
    );

    const prInfo = { title: pr.title, headBranch: pr.head_branch, baseBranch: pr.base_branch };

    if (hasBackendChanges) {
      const apiBaseUrl =
        this.config.apiBaseUrls[repo] ||
        this.config.apiBaseUrls[repoName];
      if (apiBaseUrl) {
        const backendTests = await this.generator.generatePRTests(
          { url: apiBaseUrl, context: "", type: "backend", apiBaseUrl, kt: kt.kt },
          diffContext,
          kt.kt,
          "backend",
          apiBaseUrl,
          prInfo
        );
        testsGenerated.push(...backendTests);
      }
    }

    if (hasFrontendChanges) {
      const uiBaseUrl =
        this.config.uiBaseUrls[repo] ||
        this.config.uiBaseUrls[repoName];
      if (uiBaseUrl) {
        const frontendTests = await this.generator.generatePRTests(
          { url: uiBaseUrl, context: "", type: "frontend", kt: kt.kt },
          diffContext,
          kt.kt,
          "frontend",
          uiBaseUrl,
          prInfo
        );
        testsGenerated.push(...frontendTests);
      }
    }

    // Write all generated tests
    if (testsGenerated.length > 0) {
      await this.writeTests(testsGenerated, repoName);

      // Update KT test references (don't overwrite KT itself in PR mode)
      const newTestNames = testsGenerated.map((t) => t.filename);
      const updatedSuite = mergeTestSuites(kt.tests, {
        unit: [],
        integration: [],
        playwright: newTestNames.filter((f) => f.endsWith(".ui.spec.ts")),
        api: newTestNames.filter((f) => f.endsWith(".api.spec.ts")),
      });
      await saveKT(repo, { ...kt, tests: updatedSuite });
    }

    return {
      repo,
      prNumber,
      headBranch: pr.head_branch,
      baseBranch: pr.base_branch,
      changedFiles,
      testsGenerated,
      summary: {
        totalChangedFiles: changedFiles.length,
        addedFiles: added.length,
        modifiedFiles: modified.length,
        removedFiles: removed.length,
        testsCreated: testsGenerated.length,
      },
      ktUpdated: false, // PR mode doesn't update the KT itself
    };
  }

  private buildDiffContext(files: PRDiffFile[], kt: KTDocument): string {
    const parts: string[] = [];

    for (const file of files) {
      if (file.status === "removed") continue;
      const module = kt.modules.find(
        (m) => file.filename.startsWith(m.path) || file.filename.includes(m.name)
      );
      const moduleDesc = module ? ` (module: ${module.name} - ${module.description})` : "";
      parts.push(
        `### ${file.filename} [${file.status}]${moduleDesc}\n+${file.additions} -${file.deletions}${file.patch ? `\n\`\`\`\n${file.patch.slice(0, 1500)}\n\`\`\`` : ""}`
      );
    }

    return parts.join("\n\n").slice(0, 12000);
  }

  private isBackendFile(filename: string): boolean {
    const backendPatterns = [
      /\.(ts|js|go|py|rs|java)$/,
      /routes/i,
      /api/i,
      /controller/i,
      /handler/i,
      /service/i,
      /middleware/i,
      /model/i,
    ];
    const frontendPatterns = [/\.tsx$/, /\.jsx$/, /\.vue$/, /\.svelte$/];
    // If it matches frontend, it's not backend
    if (frontendPatterns.some((p) => p.test(filename))) return false;
    return backendPatterns.some((p) => p.test(filename));
  }

  private isFrontendFile(filename: string): boolean {
    const patterns = [
      /\.tsx$/,
      /\.jsx$/,
      /\.vue$/,
      /\.svelte$/,
      /\.css$/,
      /\.scss$/,
      /components\//i,
      /pages\//i,
      /views\//i,
    ];
    return patterns.some((p) => p.test(filename));
  }

  // ─── Test Request Mode ────────────────────────────────────────

  /**
   * Test Request Mode: Generate tests for a specific module/feature.
   * 1. Ensure KT exists
   * 2. Check staleness for the requested module
   * 3. Update KT if stale
   * 4. Generate tests
   */
  async handleTestRequest(options: TestRequestOptions): Promise<TestRequestResult> {
    const { repo, module: moduleName, type, apiBaseUrl, uiBaseUrl } = options;

    console.log(`[TEST-REQ] Test request for ${repo}${moduleName ? ` module: ${moduleName}` : ""}`);

    // Step 1: KT check
    const { kt, freshlyGenerated } = await this.ensureKT(repo);
    let ktUpdated = freshlyGenerated;
    let ktUpdateSummary: string | undefined;

    // Step 2: Staleness check (skip if KT was just generated)
    if (!freshlyGenerated && moduleName) {
      const ktModule = kt.kt.modules.find(
        (m) => m.name.toLowerCase() === moduleName.toLowerCase() ||
               m.path.toLowerCase().includes(moduleName.toLowerCase())
      );

      if (ktModule && ktModule.last_modified && isModuleStale(kt.kt, ktModule.last_modified)) {
        console.log(`[TEST-REQ] Module "${moduleName}" is stale. Updating KT...`);

        const clonePath = this.repoClonePaths.get(repo);
        if (clonePath) {
          const metadata = await this.getRepoMetadata(repo);
          const updatedKTDoc = await this.ktGenerator.updateModuleKT(
            kt.kt,
            { name: ktModule.name, path: ktModule.path },
            clonePath,
            metadata
          );
          kt.kt = updatedKTDoc;
          await saveKT(repo, kt);
          ktUpdated = true;
          ktUpdateSummary = `Updated KT for module "${moduleName}" - re-scanned due to staleness`;
        }
      }
    }

    // Step 3: Generate tests
    const [, repoName] = repo.split("/");
    const testsGenerated: GeneratedTest[] = [];

    const effectiveType = type || await this.inferTestType(repo);
    const moduleContext = moduleName
      ? `Generate tests specifically for the "${moduleName}" module/feature.`
      : `Generate comprehensive tests for all modules.`;

    if (effectiveType === "backend" || effectiveType === undefined) {
      const effectiveApiBaseUrl =
        apiBaseUrl ||
        this.config.apiBaseUrls[repo] ||
        this.config.apiBaseUrls[repoName];
      if (effectiveApiBaseUrl) {
        const prompt: TestPrompt = {
          url: effectiveApiBaseUrl,
          context: `${moduleContext}\n${kt.kt.description}`,
          type: "backend",
          apiBaseUrl: effectiveApiBaseUrl,
          kt: kt.kt,
        };
        const tests = await this.generator.generateBackendTests(
          prompt,
          effectiveApiBaseUrl
        );
        testsGenerated.push(...tests);
      }
    }

    if (effectiveType === "frontend" || effectiveType === undefined) {
      const effectiveUiBaseUrl =
        uiBaseUrl ||
        this.config.uiBaseUrls[repo] ||
        this.config.uiBaseUrls[repoName];
      if (effectiveUiBaseUrl) {
        const prompt: TestPrompt = {
          url: effectiveUiBaseUrl,
          context: `${moduleContext}\n${kt.kt.description}`,
          type: "frontend",
          kt: kt.kt,
        };
        const tests = await this.generator.generateFrontendTests(prompt);
        testsGenerated.push(...tests);
      }
    }

    // Write tests and update KT test references
    if (testsGenerated.length > 0) {
      await this.writeTests(testsGenerated, repoName);

      const newTestNames = testsGenerated.map((t) => t.filename);
      const updatedSuite = mergeTestSuites(kt.tests, {
        unit: [],
        integration: [],
        playwright: newTestNames.filter((f) => f.endsWith(".ui.spec.ts")),
        api: newTestNames.filter((f) => f.endsWith(".api.spec.ts")),
      });
      await saveKT(repo, { ...kt, tests: updatedSuite });
    }

    return {
      repo,
      testsGenerated,
      ktUpdated,
      ktUpdateSummary,
    };
  }

  private async inferTestType(
    repo: string
  ): Promise<"frontend" | "backend" | undefined> {
    // Check settings first - user explicitly set repo type
    const settings = await loadRepoSettings(repo);
    if (settings?.repoType) {
      console.log(`[AGENT] Using repo type from settings: ${settings.repoType}`);
      return settings.repoType;
    }

    const [, repoName] = repo.split("/");
    const hasApiUrl =
      this.config.apiBaseUrls[repo] || this.config.apiBaseUrls[repoName];
    const hasUiUrl =
      this.config.uiBaseUrls[repo] || this.config.uiBaseUrls[repoName];

    if (hasApiUrl && !hasUiUrl) return "backend";
    if (hasUiUrl && !hasApiUrl) return "frontend";
    return undefined; // both or neither - generate both types
  }

  // ─── Original Methods (preserved) ─────────────────────────────

  /**
   * Fetch recent repos and cache basic info for repo resolution
   */
  async bootstrap(): Promise<void> {
    const recentRepos = await this.git.getRecentRepos(
      this.config.recentReposLimit
    );

    // Filter out repos with missing names (Gitea can return incomplete data)
    const validRepos = recentRepos.filter((r) => r.full_name && r.name);

    const reposToAnalyze =
      this.config.repos.length > 0
        ? validRepos.filter((r) =>
            this.config.repos.some(
              (name) =>
                r.full_name === name ||
                r.full_name.endsWith("/" + name) ||
                r.name === name
            )
          )
        : validRepos.slice(0, Math.min(this.config.recentReposLimit, 120));

    for (const repo of reposToAnalyze) {
      const info: RepoInfo = {
        fullName: repo.full_name,
        name: repo.name,
        description: repo.description || "",
      };
      this.repoInfoCache.set(repo.full_name, info);
      this.repoInfoCache.set(repo.name, info);
    }
  }

  /**
   * Resolve which repo to use based on prompt
   */
  private resolveRepo(prompt: TestPrompt, hint?: string): RepoInfo | null {
    if (hint && this.repoInfoCache.has(hint)) {
      return this.repoInfoCache.get(hint)!;
    }

    for (const [key, info] of this.repoInfoCache) {
      if (
        prompt.context.toLowerCase().includes(info.name.toLowerCase()) ||
        prompt.context.toLowerCase().includes(key.toLowerCase())
      ) {
        return info;
      }
    }

    return this.repoInfoCache.values().next().value || null;
  }

  /**
   * Generate and write tests based on user prompt
   * Skips generation if test folder already exists with matching tests
   */
  async generateTests(options: RunOptions): Promise<GeneratedTest[]> {
    const { prompt, repoHint } = options;
    const repoInfo = this.resolveRepo(prompt, repoHint);

    if (!repoInfo) {
      throw new Error(
        "No repo context found. Run bootstrap() first or provide repoHint."
      );
    }

    const repoName = repoInfo.name;
    const repoFullName = repoInfo.fullName;

    const dir = join(this.outputDir, repoName.replace(/\//g, "-"));
    const expectedSuffix = prompt.type === "frontend" ? ".ui.spec.ts" : ".api.spec.ts";

    if (existsSync(dir)) {
      const existing = await readdir(dir);
      const matching = existing.filter((f) => f.endsWith(expectedSuffix));
      if (matching.length > 0) {
        return matching.map((filename) => ({
          filename,
          content: "",
          type: prompt.type,
        }));
      }
    }

    // Clone repo if needed
    if (!this.repoClonePaths.has(repoFullName)) {
      try {
        const [owner, name] = repoFullName.split("/");
        const gitRepo = await this.git.getRepo(owner, name);
        const clonePath = await cloneRepo(this.git, gitRepo);
        this.repoClonePaths.set(repoFullName, clonePath);
      } catch (err) {
        console.warn("Could not clone repo for context:", err);
      }
    }

    // Ensure KT exists and inject into prompt
    let ktDoc: KTDocument | undefined;
    try {
      const { kt } = await this.ensureKT(repoFullName);
      ktDoc = kt.kt;
    } catch (err) {
      console.warn("[KT] Failed to generate KT during test generation:", err);
    }

    const enrichedPrompt: TestPrompt = { ...prompt, kt: ktDoc };
    let tests: GeneratedTest[] = [];

    if (enrichedPrompt.type === "frontend") {
      tests = await this.generator.generateFrontendTests(enrichedPrompt);
    } else {
      const baseUrl =
        prompt.apiBaseUrl ||
        this.config.apiBaseUrls[repoFullName] ||
        this.config.apiBaseUrls[repoName];
      if (!baseUrl) {
        throw new Error(
          `No API base URL for ${repoFullName}. Add to config apiBaseUrls.`
        );
      }
      tests = await this.generator.generateBackendTests(
        enrichedPrompt,
        baseUrl
      );
    }

    await this.writeTests(tests, repoName);
    return tests;
  }

  private async writeTests(
    tests: GeneratedTest[],
    repoName: string
  ): Promise<void> {
    const dir = join(this.outputDir, repoName.replace(/\//g, "-"));
    await mkdir(dir, { recursive: true });

    // Clear existing tests for this repo to avoid duplicates
    try {
      const existing = await readdir(dir);
      for (const f of existing) {
        if (f.endsWith(".spec.ts")) await rm(join(dir, f));
      }
    } catch {
      // Dir might not exist yet
    }

    for (const test of tests) {
      const filePath = join(dir, test.filename);
      await writeFile(filePath, test.content);
    }
  }

  /**
   * Add extra test cases based on user request. Appends to existing generated-tests/<repo>.
   */
  async addTestCases(options: {
    userPrompt: string;
    repo: string;
    apiBaseUrl?: string;
    endpoint?: string;
    sampleReq?: object;
    secretsAndParams?: string;
  }): Promise<GeneratedTest[]> {
    const { userPrompt, repo, apiBaseUrl, endpoint, sampleReq, secretsAndParams } = options;

    // Load or generate KT for this repo
    const { kt } = await this.ensureKT(repo);

    const repoName = kt.kt.repoName || repo.split("/").pop() || repo;
    const dirName = repoName.replace(/\//g, "-");
    const dir = join(this.outputDir, dirName);

    if (!existsSync(dir)) {
      throw new Error(
        `No generated tests for repo ${repo}. Generate tests first.`
      );
    }

    const existing = await readdir(dir);
    const apiTests = existing.filter((f) => f.endsWith(".api.spec.ts"));
    const uiTests = existing.filter((f) => f.endsWith(".ui.spec.ts"));
    const hasApi = apiTests.length > 0;
    const hasUi = uiTests.length > 0;

    if (!hasApi && !hasUi) {
      throw new Error(`No test files found in ${dir}`);
    }

    const existingContent = hasApi
      ? await readFile(join(dir, apiTests[0]), "utf-8")
      : await readFile(join(dir, uiTests[0]), "utf-8");
    const type = hasApi ? "backend" : "frontend";

    const baseUrl =
      apiBaseUrl ||
      this.config.apiBaseUrls[repo] ||
      this.config.apiBaseUrls[kt.kt.repoFullName || ""] ||
      this.config.apiBaseUrls[repoName];

    if (type === "backend" && !baseUrl) {
      throw new Error(`No API base URL for ${repo}. Add to config apiBaseUrls.`);
    }

    const newTests = await this.generator.generateAdditionalTests(
      userPrompt,
      existingContent,
      type,
      baseUrl,
      { endpoint, sampleReq, secretsAndParams, kt: kt.kt }
    );

    await this.appendTests(newTests, dirName);
    return newTests;
  }

  private async appendTests(
    tests: GeneratedTest[],
    repoName: string
  ): Promise<void> {
    const dir = join(this.outputDir, repoName);
    await mkdir(dir, { recursive: true });

    for (const test of tests) {
      const filePath = join(dir, test.filename);
      await writeFile(filePath, test.content);
    }
  }

  /**
   * Get KT for a repo (for API/debugging)
   */
  async getKT(repoFullName: string): Promise<RepoKT | null> {
    return loadKT(repoFullName);
  }

  /**
   * Get all cached repo infos (for debugging/CLI display)
   */
  getRepoInfos(): RepoInfo[] {
    return Array.from(
      new Map(
        Array.from(this.repoInfoCache.entries()).filter(([k]) =>
          k.includes("/")
        )
      ).values()
    );
  }
}
