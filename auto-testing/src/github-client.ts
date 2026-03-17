/**
 * GitHub API client - implements GitProvider
 */

import type { GitRepo, GitFile, GitProvider, PullRequest, PRDiffFile } from "./git-provider.js";

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  updated_at: string;
  pushed_at: string | null;
  size: number;
  private: boolean;
}

interface GitHubContentFile {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
  size?: number;
  content?: string;
  encoding?: string;
}

export class GitHubClient implements GitProvider {
  private baseUrl: string;
  private token: string;
  private org: string;

  constructor(options: { baseUrl: string; token: string; org: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.org = options.org;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    if (response.headers.get("content-type")?.includes("application/json")) {
      return response.json() as Promise<T>;
    }
    return response.text() as unknown as T;
  }

  async getRepo(owner: string, repo: string): Promise<GitRepo> {
    const r = await this.request<GitHubRepo>(`/repos/${owner}/${repo}`);
    return this.toGitRepo(r);
  }

  async getRecentRepos(limit: number = 120): Promise<GitRepo[]> {
    let allRepos: GitRepo[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const result = await this.request<GitHubRepo[]>(
        `/orgs/${this.org}/repos?page=${page}&per_page=${perPage}&sort=pushed&direction=desc`
      );
      const repos = Array.isArray(result) ? result : [];
      if (repos.length === 0) break;
      allRepos = allRepos.concat(repos.map((r) => this.toGitRepo(r)));
      if (repos.length < perPage) break;
      page++;
    }

    return allRepos.slice(0, limit);
  }

  async getFile(
    owner: string,
    repo: string,
    filePath: string,
    ref: string = "HEAD"
  ): Promise<string> {
    const file = await this.request<GitHubContentFile>(
      `/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`
    );

    if (file.type !== "file" || !file.content) {
      throw new Error(`Not a file or empty: ${filePath}`);
    }

    if (file.encoding === "base64") {
      return Buffer.from(file.content, "base64").toString("utf-8");
    }
    return file.content;
  }

  async listDir(
    owner: string,
    repo: string,
    dirPath: string = "",
    ref: string = "HEAD"
  ): Promise<GitFile[]> {
    const path = dirPath
      ? `/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}`
      : `/repos/${owner}/${repo}/contents?ref=${ref}`;
    const result = await this.request<GitHubContentFile[] | GitHubContentFile>(path);
    const files = Array.isArray(result) ? result : [result];
    return files.map((f) => ({
      name: f.name,
      path: f.path,
      sha: f.sha,
      type: f.type,
      size: f.size,
      content: f.content,
      encoding: f.encoding,
    }));
  }

  getCloneUrl(repo: GitRepo): string {
    const url = new URL(repo.clone_url);
    url.username = this.token;
    url.password = "";
    return url.toString();
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const pr = await this.request<any>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      head_branch: pr.head?.ref || "",
      base_branch: pr.base?.ref || "",
      state: pr.merged ? "merged" : pr.state,
      user: pr.user?.login || "",
      html_url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    };
  }

  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<PRDiffFile[]> {
    const files = await this.request<any[]>(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    return files.map((f) => ({
      filename: f.filename,
      status: f.status as PRDiffFile["status"],
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch,
    }));
  }

  async compareBranches(owner: string, repo: string, base: string, head: string): Promise<PRDiffFile[]> {
    const result = await this.request<any>(`/repos/${owner}/${repo}/compare/${base}...${head}`);
    return (result.files || []).map((f: any) => ({
      filename: f.filename,
      status: f.status as PRDiffFile["status"],
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      patch: f.patch,
    }));
  }

  private toGitRepo(r: GitHubRepo): GitRepo {
    return {
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      description: r.description || "",
      html_url: r.html_url,
      clone_url: r.clone_url,
      ssh_url: r.ssh_url,
      default_branch: r.default_branch || "main",
      updated_at: r.updated_at,
      pushed_at: r.pushed_at || r.updated_at,
      size: r.size,
      private: r.private,
    };
  }
}
