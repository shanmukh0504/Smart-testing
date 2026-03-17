/**
 * Gitea API client - implements GitProvider
 */

import type { GitRepo, GitFile, GitProvider, PullRequest, PRDiffFile } from "./git-provider.js";

/** @deprecated Use GitRepo from git-provider */
export type GiteaRepo = GitRepo;

/** @deprecated Use GitFile from git-provider */
export type GiteaFile = GitFile;

export class GiteaClient implements GitProvider {
  private baseUrl: string;
  private token: string;
  private org: string;

  constructor(options: {
    baseUrl: string;
    token: string;
    org: string;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.org = options.org;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Gitea API error ${response.status}: ${text}`
      );
    }

    if (response.headers.get("content-type")?.includes("application/json")) {
      return response.json() as Promise<T>;
    }
    return response.text() as unknown as T;
  }

  /**
   * Get a single repository by owner and name
   */
  async getRepo(owner: string, repo: string): Promise<GitRepo> {
    const r = await this.request<GitRepo>(`/api/v1/repos/${owner}/${repo}`);
    // Ensure full_name and name are always set
    if (!r.full_name) r.full_name = `${owner}/${repo}`;
    if (!r.name) r.name = repo;
    return r;
  }

  /**
   * List all repositories in the organization
   */
  async listOrgRepos(options?: {
    page?: number;
    limit?: number;
  }): Promise<GitRepo[]> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 100;
    const result = await this.request<GitRepo[] | GitRepo>(
      `/api/v1/orgs/${this.org}/repos?page=${page}&limit=${limit}`
    );
    // Gitea may return a single object or non-array in edge cases
    if (!result) return [];
    const repos = Array.isArray(result) ? result : [result];
    // Ensure full_name is always set
    for (const r of repos) {
      if (!r.full_name && r.name) r.full_name = `${this.org}/${r.name}`;
    }
    return repos;
  }

  /**
   * Fetch all org repos (with pagination) and return top N by recent activity
   */
  async getRecentRepos(limit: number = 120): Promise<GitRepo[]> {
    let allRepos: GitRepo[] = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const repos = await this.listOrgRepos({ page, limit: perPage });
      if (!repos || repos.length === 0) break;
      allRepos = allRepos.concat(repos);
      if (repos.length < perPage) break;
      page++;
    }

    // Sort by pushed_at (most recent first)
    allRepos.sort((a, b) => {
      const dateA = new Date(a.pushed_at || a.updated_at).getTime();
      const dateB = new Date(b.pushed_at || b.updated_at).getTime();
      return dateB - dateA;
    });

    return allRepos.slice(0, limit);
  }

  /**
   * Get file contents from a repository
   */
  async getFile(
    owner: string,
    repo: string,
    filePath: string,
    ref: string = "HEAD"
  ): Promise<string> {
    const path = `/api/v1/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
    const file = await this.request<GitFile>(path);

    if (file.type !== "file" || !file.content) {
      throw new Error(`Not a file or empty: ${filePath}`);
    }

    // Gitea returns base64 encoded content
    if (file.encoding === "base64") {
      return Buffer.from(file.content, "base64").toString("utf-8");
    }
    return file.content;
  }

  /**
   * List directory contents
   */
  async listDir(
    owner: string,
    repo: string,
    dirPath: string = "",
    ref: string = "HEAD"
  ): Promise<GitFile[]> {
    const path = dirPath
      ? `/api/v1/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}`
      : `/api/v1/repos/${owner}/${repo}/contents?ref=${ref}`;
    const result = await this.request<GitFile[] | GitFile>(path);
    const files = Array.isArray(result) ? result : [result];
    return files;
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const pr = await this.request<any>(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      head_branch: pr.head?.ref || pr.head?.label || "",
      base_branch: pr.base?.ref || pr.base?.label || "",
      state: pr.merged ? "merged" : pr.state,
      user: pr.user?.login || pr.user?.username || "",
      html_url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    };
  }

  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<PRDiffFile[]> {
    const files = await this.request<any[]>(`/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    return (files || []).map((f) => ({
      filename: f.filename,
      status: (f.status || "modified") as PRDiffFile["status"],
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch,
    }));
  }

  async compareBranches(owner: string, repo: string, base: string, head: string): Promise<PRDiffFile[]> {
    // Gitea uses git compare API
    const result = await this.request<any>(`/api/v1/repos/${owner}/${repo}/compare/${base}...${head}`);
    return (result.files || []).map((f: any) => ({
      filename: f.filename,
      status: (f.status || "modified") as PRDiffFile["status"],
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch,
    }));
  }

  /**
   * Get clone URL with token for private repos
   */
  getCloneUrl(repo: GitRepo): string {
    const url = new URL(repo.clone_url);
    url.username = this.token;
    url.password = "";
    return url.toString();
  }
}
