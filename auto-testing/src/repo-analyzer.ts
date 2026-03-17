/**
 * Analyzes repositories to extract README content and API documentation
 */

import type { GitProvider, GitRepo } from "./git-provider.js";
import { glob } from "glob";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface RepoContext {
  fullName: string;
  name: string;
  description: string;
  readmeContent: string;
  apiDocs: ApiDoc[];
  structure: string[];
  techStack: string;
  /** Source code snippets from cloned repo (routes, handlers, etc.) */
  sourceSnippets?: string;
}

export interface ApiDoc {
  filePath: string;
  content: string;
}

const README_PATTERNS = [
  "README.md",
  "README.MD",
  "readme.md",
  "Readme.md",
];

const API_DOC_PATTERNS = [
  "**/API.md",
  "**/api.md",
  "**/docs/**/*.md",
  "**/api-docs/**/*.md",
  "**/openapi*.md",
  "**/swagger*.md",
];

export class RepoAnalyzer {
  constructor(private git: GitProvider) {}

  /**
   * Analyze a repo via Git API (without cloning)
   */
  async analyzeFromApi(repo: GitRepo): Promise<RepoContext> {
    const [owner, repoName] = repo.full_name.split("/");
    const defaultBranch = repo.default_branch || "main";

    let readmeContent = "";
    for (const pattern of README_PATTERNS) {
      try {
        readmeContent = await this.git.getFile(
          owner,
          repoName,
          pattern,
          defaultBranch
        );
        break;
      } catch {
        // Try next pattern
      }
    }

    const apiDocs: ApiDoc[] = [];
    const structure: string[] = [];

    try {
      const rootFiles = await this.git.listDir(owner, repoName, "", defaultBranch);
      structure.push(...rootFiles.map((f) => f.path));

      // Look for common doc locations
      const docPaths = ["docs", "api-docs", "api", "src"];
      for (const docPath of docPaths) {
        try {
          const files = await this.git.listDir(
            owner,
            repoName,
            docPath,
            defaultBranch
          );
          for (const file of files) {
            if (file.type === "file" && file.name.endsWith(".md")) {
              try {
                const content = await this.git.getFile(
                  owner,
                  repoName,
                  file.path,
                  defaultBranch
                );
                apiDocs.push({ filePath: file.path, content });
              } catch {
                // Skip unreadable files
              }
            }
          }
        } catch {
          // Directory might not exist
        }
      }
    } catch {
      // Ignore structure fetch errors
    }

    const techStack = this.inferTechStack(repo, readmeContent, structure);

    return {
      fullName: repo.full_name,
      name: repoName,
      description: repo.description || "",
      readmeContent: readmeContent || "(No README found)",
      apiDocs,
      structure: structure.slice(0, 50),
      techStack,
    };
  }

  /**
   * Analyze a cloned repo from local filesystem
   */
  async analyzeFromLocal(repoPath: string, fullName: string): Promise<RepoContext> {
    let readmeContent = "";
    for (const pattern of README_PATTERNS) {
      const p = join(repoPath, pattern);
      if (existsSync(p)) {
        readmeContent = await readFile(p, "utf-8");
        break;
      }
    }

    const apiDocs: ApiDoc[] = [];
    const mdFiles = await glob("**/*.md", { cwd: repoPath });
    for (const file of mdFiles) {
      if (
        file.toLowerCase().includes("api") ||
        file.toLowerCase().includes("doc")
      ) {
        const content = await readFile(join(repoPath, file), "utf-8");
        apiDocs.push({ filePath: file, content });
      }
    }

    const structure = await glob("*", { cwd: repoPath });
    const techStack = this.inferTechStack(
      { full_name: fullName, description: "" } as GitRepo,
      readmeContent,
      structure
    );

    const sourceSnippets = await this.extractSourceSnippets(repoPath);

    return {
      fullName,
      name: fullName.split("/").pop() || "",
      description: "",
      readmeContent: readmeContent || "(No README found)",
      apiDocs,
      structure,
      techStack,
      sourceSnippets,
    };
  }

  private async extractSourceSnippets(repoPath: string): Promise<string> {
    const snippets: string[] = [];
    const patterns = [
      "**/routes*.{ts,tsx,js,jsx}",
      "**/api*.{ts,tsx,js,jsx}",
      "**/router*.{ts,tsx,js,jsx}",
      "**/openapi*.{json,yaml,yml}",
      "**/swagger*.{json,yaml,yml}",
    ];
    for (const pattern of patterns) {
      try {
        const files = await glob(pattern, { cwd: repoPath });
        for (const f of files.slice(0, 3)) {
          const content = await readFile(join(repoPath, f), "utf-8");
          snippets.push(`### ${f}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\``);
        }
      } catch {
        /* ignore */
      }
    }
    return snippets.join("\n\n").slice(0, 8000);
  }

  private inferTechStack(
    repo: GitRepo,
    readme: string,
    structure: string[]
  ): string {
    const hints: string[] = [];
    const all = `${repo.description} ${readme} ${structure.join(" ")}`.toLowerCase();

    if (all.includes("react") || structure.includes("package.json")) hints.push("React/Node");
    if (all.includes("vue")) hints.push("Vue");
    if (all.includes("angular")) hints.push("Angular");
    if (all.includes("next")) hints.push("Next.js");
    if (all.includes("fastapi") || all.includes("flask")) hints.push("Python/FastAPI");
    if (all.includes("express") || all.includes("nestjs")) hints.push("Node/Express");
    if (all.includes("go ") || all.includes("golang")) hints.push("Go");
    if (structure.includes("requirements.txt")) hints.push("Python");
    if (structure.includes("go.mod")) hints.push("Go");
    if (structure.includes("Cargo.toml")) hints.push("Rust");

    return hints.length > 0 ? hints.join(", ") : "Unknown";
  }
}
