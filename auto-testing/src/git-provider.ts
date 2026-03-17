/**
 * Git provider abstraction - single point to switch between GitHub and Gitea
 *
 * Env vars: GIT_PROVIDER (github|gitea), GIT_BASE_URL, GIT_TOKEN, GIT_ORG
 */

import { GiteaClient } from "./gitea-client.js";
import { GitHubClient } from "./github-client.js";

export interface GitRepo {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
  size: number;
  private: boolean;
}

export interface GitFile {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
  size?: number;
  content?: string;
  encoding?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head_branch: string;
  base_branch: string;
  state: "open" | "closed" | "merged";
  user: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface PRDiffFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitProvider {
  getRepo(owner: string, repo: string): Promise<GitRepo>;
  getRecentRepos(limit?: number): Promise<GitRepo[]>;
  getFile(owner: string, repo: string, filePath: string, ref?: string): Promise<string>;
  listDir(owner: string, repo: string, dirPath?: string, ref?: string): Promise<GitFile[]>;
  getCloneUrl(repo: GitRepo): string;
  /** Get pull request details */
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest>;
  /** Get files changed in a pull request */
  getPRDiff(owner: string, repo: string, prNumber: number): Promise<PRDiffFile[]>;
  /** Compare two branches and get changed files */
  compareBranches(owner: string, repo: string, base: string, head: string): Promise<PRDiffFile[]>;
}

export type GitProviderType = "github" | "gitea";

/**
 * Create GitProvider from env vars.
 * Env: GIT_PROVIDER (github|gitea), GIT_BASE_URL, GIT_TOKEN, GIT_ORG
 */
export function createGitProvider(): GitProvider {
  const provider = (process.env.GIT_PROVIDER || "gitea").toLowerCase();
  const baseUrl = (process.env.GIT_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.GIT_TOKEN;
  const org = process.env.GIT_ORG;

  if (!token) {
    throw new Error("GIT_TOKEN environment variable is required");
  }
  if (!org) {
    throw new Error("GIT_ORG environment variable is required");
  }

  if (provider === "github") {
    return new GitHubClient({
      baseUrl: baseUrl || "https://api.github.com",
      token,
      org,
    });
  }

  if (provider === "gitea") {
    if (!baseUrl) {
      throw new Error("GIT_BASE_URL is required for Gitea (e.g. https://version.btcfi.wtf)");
    }
    return new GiteaClient({
      baseUrl,
      token,
      org,
    });
  }

  throw new Error(
    `Invalid GIT_PROVIDER="${provider}". Use "github" or "gitea".`
  );
}
