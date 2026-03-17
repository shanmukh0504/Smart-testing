/**
 * Language-agnostic repo scanner.
 * Collects directory structure and source code snippets from a cloned repo.
 * Does NOT try to understand the code — that's Claude's job.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname } from "path";

/** Binary/generated extensions to skip */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".pyc", ".pyo", ".class", ".jar",
  ".wasm", ".map", ".min.js", ".min.css",
  ".lock", ".lockb",
]);

/** Directories to always skip */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  "vendor", ".cache", "coverage", ".turbo", ".vercel", ".output",
  "target", ".gradle", ".idea", ".vscode", ".vs",
  "venv", ".venv", "env", ".env", "__pypackages__",
  ".terraform", ".serverless",
]);

export interface ScannedRepoData {
  /** Directory tree (top 3 levels) */
  directoryTree: string;
  /** Source code from representative files */
  sourceSnippets: string;
}

export interface ExtractedButtonInfo {
  text: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  type?: string;
  role?: string;
}

export interface ExtractedElementStyle {
  selector: string;
  classes: string;
  text?: string;
}

export interface ExtractedUISelectors {
  testIds: string[];
  ariaLabels: string[];
  htmlIds: string[];
  placeholders: string[];
  textContent: string[];
  formFields: string[];
  buttons: ExtractedButtonInfo[];
  elementStyles: ExtractedElementStyle[];
}

export interface ExtractedAPIContract {
  routePath?: string;
  method?: string;
  params: string[];
  queryParams: string[];
  bodyFields: string[];
  authRequired: boolean;
  responseSnippet?: string;
}

/** UI file extensions */
const UI_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);

/** Patterns that indicate a file contains API route/service logic */
const API_FILE_PATTERNS = [
  /route/i, /api/i, /handler/i, /controller/i, /service/i, /server/i, /router/i,
];

export class DeterministicKTGenerator {
  /**
   * Scan a repo and collect directory tree + source code for Claude to analyze.
   */
  async scanRepo(repoPath: string): Promise<ScannedRepoData> {
    const directoryTree = await this.buildDirectoryTree(repoPath);
    const sourceSnippets = await this.collectSourceSnippets(repoPath);

    return { directoryTree, sourceSnippets };
  }

  /**
   * Build a directory tree string (top 3 levels, skips noise).
   */
  private async buildDirectoryTree(repoPath: string, depth = 0, maxDepth = 3): Promise<string> {
    if (depth > maxDepth) return "";
    const indent = "  ".repeat(depth);
    const lines: string[] = [];

    let entries;
    try {
      entries = await readdir(repoPath, { withFileTypes: true });
    } catch {
      return "";
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && depth === 0) continue;

      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        const subtree = await this.buildDirectoryTree(join(repoPath, entry.name), depth + 1, maxDepth);
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Collect source code from representative files — language-agnostic.
   * Strategy: discover what source files exist, read the most important ones
   * (entry points first, then shallow files, up to a size budget).
   */
  private async collectSourceSnippets(repoPath: string): Promise<string> {
    const snippets: string[] = [];
    let totalSize = 0;
    const maxTotal = 30000;

    // Phase 1: Well-known config/manifest files (language-agnostic list of filenames)
    const configFiles = await this.findFiles(repoPath, "", (name) =>
      [
        "package.json", "cargo.toml", "go.mod", "go.sum",
        "pyproject.toml", "setup.py", "requirements.txt",
        "gemfile", "build.gradle", "pom.xml", "mix.exs",
        "tsconfig.json", "deno.json", "bun.lockb",
        "docker-compose.yml", "dockerfile",
        "makefile", "cmakelists.txt",
      ].includes(name.toLowerCase())
    );
    for (const f of configFiles.slice(0, 5)) {
      const snippet = await this.readSnippet(repoPath, f, 2000);
      if (snippet && totalSize + snippet.length < maxTotal) {
        snippets.push(snippet);
        totalSize += snippet.length;
      }
    }

    // Phase 2: Entry point files (common names across languages)
    const entryNames = new Set([
      "main", "index", "app", "server", "mod", "lib",
      "routes", "router", "api", "handler", "controller",
    ]);
    const entryFiles = await this.findFiles(repoPath, "", (name) => {
      const base = name.replace(/\.[^.]+$/, "").toLowerCase();
      return entryNames.has(base);
    });
    for (const f of entryFiles.slice(0, 8)) {
      const snippet = await this.readSnippet(repoPath, f, 1500);
      if (snippet && totalSize + snippet.length < maxTotal) {
        snippets.push(snippet);
        totalSize += snippet.length;
      }
    }

    // Phase 3: All remaining source files, breadth-first (shallow first = more important)
    const allSource = await this.findAllSourceFiles(repoPath);
    // Skip files already collected
    const collected = new Set(configFiles.concat(entryFiles));
    const remaining = allSource.filter((f) => !collected.has(f));

    for (const f of remaining) {
      if (totalSize >= maxTotal) break;
      const snippet = await this.readSnippet(repoPath, f, 1000);
      if (snippet && totalSize + snippet.length < maxTotal) {
        snippets.push(snippet);
        totalSize += snippet.length;
      }
    }

    return snippets.join("\n\n");
  }

  /**
   * Find files in the repo matching a predicate (non-recursive, then 1 level deep).
   */
  private async findFiles(
    repoPath: string,
    subdir: string,
    predicate: (name: string) => boolean
  ): Promise<string[]> {
    const results: string[] = [];
    const base = subdir ? join(repoPath, subdir) : repoPath;

    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && predicate(entry.name)) {
          results.push(subdir ? `${subdir}/${entry.name}` : entry.name);
        }
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          try {
            const sub = await readdir(join(base, entry.name), { withFileTypes: true });
            for (const s of sub) {
              if (s.isFile() && predicate(s.name)) {
                const rel = subdir ? `${subdir}/${entry.name}/${s.name}` : `${entry.name}/${s.name}`;
                results.push(rel);
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    return results;
  }

  /**
   * Collect all source files breadth-first, skipping binary/generated files.
   */
  private async findAllSourceFiles(repoPath: string): Promise<string[]> {
    const files: string[] = [];
    const queue: string[] = [""];

    while (queue.length > 0 && files.length < 200) {
      const dir = queue.shift()!;
      const fullDir = dir ? join(repoPath, dir) : repoPath;

      let entries;
      try {
        entries = await readdir(fullDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.isDirectory())) continue;

        const rel = dir ? `${dir}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          queue.push(rel);
        } else if (entry.isFile() && this.isSourceFile(entry.name)) {
          files.push(rel);
        }
      }
    }

    return files;
  }

  /**
   * Check if a file is likely source code (not binary, not generated).
   */
  private isSourceFile(name: string): boolean {
    const ext = extname(name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return false;
    if (name.endsWith(".min.js") || name.endsWith(".min.css")) return false;
    // If no extension, check for common extensionless source files
    if (!ext) {
      const lower = name.toLowerCase();
      return ["makefile", "dockerfile", "rakefile", "procfile", "gemfile"].includes(lower);
    }
    return true;
  }

  private async readSnippet(repoPath: string, file: string, maxChars: number): Promise<string | null> {
    try {
      const fullPath = join(repoPath, file);
      const s = await stat(fullPath);
      // Skip files larger than 100KB (likely generated)
      if (s.size > 100_000) return null;
      const content = await readFile(fullPath, "utf-8");
      if (content.length === 0) return null;
      return `### ${file}\n\`\`\`\n${content.slice(0, maxChars)}\n\`\`\``;
    } catch {
      return null;
    }
  }

  // ─── Static UI Selector Extraction ──────────────────────────

  /**
   * Extract testable UI selectors from component files (zero AI cost).
   * Scans for data-testid, aria-label, id, placeholder, text content, form fields.
   */
  async extractUISelectors(repoPath: string): Promise<Map<string, ExtractedUISelectors>> {
    const result = new Map<string, ExtractedUISelectors>();
    const allFiles = await this.findAllSourceFiles(repoPath);
    const uiFiles = allFiles.filter((f) => UI_EXTENSIONS.has(extname(f).toLowerCase()));

    for (const file of uiFiles) {
      let content: string;
      try {
        const fullPath = join(repoPath, file);
        const s = await stat(fullPath);
        if (s.size > 100_000) continue;
        content = await readFile(fullPath, "utf-8");
        if (!content) continue;
      } catch {
        continue;
      }

      const selectors: ExtractedUISelectors = {
        testIds: [],
        ariaLabels: [],
        htmlIds: [],
        placeholders: [],
        textContent: [],
        formFields: [],
        buttons: [],
        elementStyles: [],
      };

      // data-testid="X" and data-test-id="X"
      for (const m of content.matchAll(/data-test-?id=["']([^"']+)["']/g)) {
        selectors.testIds.push(m[1]);
      }
      // Also handle JSX expression with string literal: data-testid={"X"}
      for (const m of content.matchAll(/data-test-?id=\{["']([^"']+)["']\}/g)) {
        selectors.testIds.push(m[1]);
      }

      // aria-label="X"
      for (const m of content.matchAll(/aria-label=["']([^"']+)["']/g)) {
        selectors.ariaLabels.push(m[1]);
      }

      // id="X" (only HTML element ids, skip imports/variables)
      // Match id= that appears inside JSX tags (preceded by whitespace, not in an import/const context)
      for (const m of content.matchAll(/\sid=["']([^"']+)["']/g)) {
        selectors.htmlIds.push(m[1]);
      }
      for (const m of content.matchAll(/\sid=\{["']([^"']+)["']\}/g)) {
        selectors.htmlIds.push(m[1]);
      }

      // placeholder="X"
      for (const m of content.matchAll(/placeholder=["']([^"']+)["']/g)) {
        selectors.placeholders.push(m[1]);
      }
      for (const m of content.matchAll(/placeholder=\{["']([^"']+)["']\}/g)) {
        selectors.placeholders.push(m[1]);
      }

      // Static text in buttons, links, headings (only plain text, not JSX expressions)
      for (const m of content.matchAll(/<button[^>]*>([^<{]+)<\/button>/gi)) {
        const text = m[1].trim();
        if (text && text.length <= 80) selectors.textContent.push(`button: ${text}`);
      }
      for (const m of content.matchAll(/<a[^>]*>([^<{]+)<\/a>/gi)) {
        const text = m[1].trim();
        if (text && text.length <= 80) selectors.textContent.push(`link: ${text}`);
      }
      for (const m of content.matchAll(/<h([1-6])[^>]*>([^<{]+)<\/h\1>/gi)) {
        const text = m[2].trim();
        if (text && text.length <= 80) selectors.textContent.push(`heading: ${text}`);
      }

      // Extract buttons with their styles, classes, and attributes
      for (const m of content.matchAll(/<button([^>]*)>([^<{]*(?:<[^>]*>[^<{]*)*)<\/button>/gi)) {
        const attrs = m[1];
        const innerText = m[2].replace(/<[^>]*>/g, "").trim();
        if (!innerText || innerText.length > 80) continue;
        const btn: ExtractedButtonInfo = { text: innerText };
        const classMatch = attrs.match(/class(?:Name)?=["']([^"']+)["']/);
        if (classMatch) btn.className = classMatch[1];
        const classExprMatch = attrs.match(/class(?:Name)?=\{[`"']([^`"']+)[`"']\}/);
        if (classExprMatch && !btn.className) btn.className = classExprMatch[1];
        const testIdMatch = attrs.match(/data-test-?id=["']([^"']+)["']/);
        if (testIdMatch) btn.testId = testIdMatch[1];
        const ariaMatch = attrs.match(/aria-label=["']([^"']+)["']/);
        if (ariaMatch) btn.ariaLabel = ariaMatch[1];
        const typeMatch = attrs.match(/type=["']([^"']+)["']/);
        if (typeMatch) btn.type = typeMatch[1];
        selectors.buttons.push(btn);
      }

      // Extract key styled elements (divs, sections with classes and visible text)
      for (const m of content.matchAll(/<(div|section|nav|header|footer|main|aside)([^>]*class(?:Name)?=["'][^"']+["'][^>]*)>/gi)) {
        const tag = m[1];
        const attrs = m[2];
        const classMatch = attrs.match(/class(?:Name)?=["']([^"']+)["']/);
        if (classMatch && classMatch[1].length > 5) {
          selectors.elementStyles.push({
            selector: tag,
            classes: classMatch[1],
          });
        }
      }

      // Form field names: <input name="X">, <select name="X">, <textarea name="X">
      for (const m of content.matchAll(/<(?:input|select|textarea)[^>]*\sname=["']([^"']+)["']/gi)) {
        selectors.formFields.push(m[1]);
      }

      // Deduplicate all arrays
      selectors.testIds = [...new Set(selectors.testIds)];
      selectors.ariaLabels = [...new Set(selectors.ariaLabels)];
      selectors.htmlIds = [...new Set(selectors.htmlIds)];
      selectors.placeholders = [...new Set(selectors.placeholders)];
      selectors.textContent = [...new Set(selectors.textContent)];
      selectors.formFields = [...new Set(selectors.formFields)];
      // Deduplicate buttons by text
      const seenBtnTexts = new Set<string>();
      selectors.buttons = selectors.buttons.filter(b => {
        if (seenBtnTexts.has(b.text)) return false;
        seenBtnTexts.add(b.text);
        return true;
      });
      // Limit element styles to most meaningful (max 20)
      selectors.elementStyles = selectors.elementStyles.slice(0, 20);

      // Only store if we found something
      const hasData = selectors.testIds.length > 0 || selectors.ariaLabels.length > 0 ||
        selectors.htmlIds.length > 0 || selectors.placeholders.length > 0 ||
        selectors.textContent.length > 0 || selectors.formFields.length > 0 ||
        selectors.buttons.length > 0;

      if (hasData) {
        result.set(file, selectors);
      }
    }

    return result;
  }

  // ─── Static API Contract Extraction ─────────────────────────

  /**
   * Extract API contracts from route/service files (zero AI cost).
   * Scans for route defs, params, query params, body fields, auth, response shapes.
   * Also extracts TypeScript type/interface param definitions.
   */
  async extractAPIContracts(repoPath: string): Promise<Map<string, ExtractedAPIContract[]>> {
    const result = new Map<string, ExtractedAPIContract[]>();
    const allFiles = await this.findAllSourceFiles(repoPath);

    // Filter to likely API/service files (not UI components)
    const apiFiles = allFiles.filter((f) => {
      const ext = extname(f).toLowerCase();
      if (ext === ".tsx" || ext === ".jsx") return false; // skip UI components
      if (ext !== ".ts" && ext !== ".js") return false;
      // Match by filename or directory path
      return API_FILE_PATTERNS.some((p) => p.test(f));
    });

    for (const file of apiFiles) {
      let content: string;
      try {
        const fullPath = join(repoPath, file);
        const s = await stat(fullPath);
        if (s.size > 100_000) continue;
        content = await readFile(fullPath, "utf-8");
        if (!content) continue;
      } catch {
        continue;
      }

      const contracts: ExtractedAPIContract[] = [];

      // Express-style routes: app.get("/path", ...) or router.post("/path", ...)
      for (const m of content.matchAll(/(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/gi)) {
        const contract = this.buildContractFromRoute(m[1].toUpperCase(), m[2], content);
        contracts.push(contract);
      }

      // Next.js App Router: export async function GET/POST/etc
      for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
        const contract = this.buildContractFromRoute(m[1], file, content);
        contracts.push(contract);
      }

      // TypeScript type/interface with "Params" in name (catches SDK-style APIs)
      for (const m of content.matchAll(/(?:type|interface)\s+(\w*Params\w*)\s*=?\s*\{([^}]{1,500})\}/g)) {
        const typeName = m[1];
        const body = m[2];
        const fields: string[] = [];
        for (const field of body.matchAll(/(\w+)\s*[?:]?\s*:/g)) {
          fields.push(field[1]);
        }
        if (fields.length > 0) {
          contracts.push({
            routePath: undefined,
            method: undefined,
            params: [],
            queryParams: fields,
            bodyFields: [],
            authRequired: false,
            responseSnippet: `(from ${typeName})`,
          });
        }
      }

      // Extract standalone query param access patterns (for service files that don't have route defs)
      if (contracts.length === 0) {
        const queryParams: string[] = [];
        const bodyFields: string[] = [];

        for (const m of content.matchAll(/(?:req\.query|searchParams\.get|url\.searchParams\.get)\s*(?:\.\s*(\w+)|\(\s*["'](\w+)["']\s*\))/g)) {
          queryParams.push(m[1] || m[2]);
        }
        for (const m of content.matchAll(/req\.body\.(\w+)/g)) {
          bodyFields.push(m[1]);
        }
        // Destructuring from request body
        for (const m of content.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:req\.body|await\s+\w+\.json\(\))/g)) {
          for (const field of m[1].matchAll(/(\w+)/g)) {
            bodyFields.push(field[1]);
          }
        }

        if (queryParams.length > 0 || bodyFields.length > 0) {
          const authRequired = /(?:auth|protect|requireAuth|withAuth)\b/i.test(content);
          contracts.push({
            params: [],
            queryParams: [...new Set(queryParams)],
            bodyFields: [...new Set(bodyFields)],
            authRequired,
          });
        }
      }

      if (contracts.length > 0) {
        result.set(file, contracts);
      }
    }

    return result;
  }

  /**
   * Build an API contract from a route definition and its surrounding code.
   */
  private buildContractFromRoute(method: string, routePath: string, fileContent: string): ExtractedAPIContract {
    const params: string[] = [];
    // Extract route params: :param or [param]
    for (const m of routePath.matchAll(/:(\w+)/g)) params.push(m[1]);
    for (const m of routePath.matchAll(/\[(\w+)\]/g)) params.push(m[1]);

    const queryParams: string[] = [];
    for (const m of fileContent.matchAll(/(?:req\.query|searchParams\.get|url\.searchParams\.get)\s*(?:\.\s*(\w+)|\(\s*["'](\w+)["']\s*\))/g)) {
      queryParams.push(m[1] || m[2]);
    }

    const bodyFields: string[] = [];
    for (const m of fileContent.matchAll(/req\.body\.(\w+)/g)) {
      bodyFields.push(m[1]);
    }
    for (const m of fileContent.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*(?:req\.body|await\s+\w+\.json\(\))/g)) {
      for (const field of m[1].matchAll(/(\w+)/g)) {
        bodyFields.push(field[1]);
      }
    }

    const authRequired = /(?:auth|protect|requireAuth|withAuth)\b/i.test(fileContent);

    let responseSnippet: string | undefined;
    const resMatch = fileContent.match(/(?:res\.json|NextResponse\.json|return\s+.*\.json)\s*\(\s*(\{[^}]{1,200}\})/);
    if (resMatch) {
      responseSnippet = resMatch[1];
    }

    return {
      routePath,
      method,
      params: [...new Set(params)],
      queryParams: [...new Set(queryParams)],
      bodyFields: [...new Set(bodyFields)],
      authRequired,
      responseSnippet,
    };
  }
}
