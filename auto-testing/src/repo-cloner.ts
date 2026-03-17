/**
 * Clone repos from Gitea using simple-git (no shell - sanitized)
 */

import { simpleGit } from "simple-git";
import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { GitProvider, GitRepo } from "./git-provider.js";

const REPOS_DIR = join(process.cwd(), "repos");

export async function cloneRepo(
  git: GitProvider,
  repo: GitRepo,
  shallow: boolean = true
): Promise<string> {
  const dirName = repo.full_name.replace(/\//g, "-");
  const targetPath = join(REPOS_DIR, dirName);

  if (existsSync(targetPath)) {
    try {
      const sg = simpleGit(targetPath);
      await sg.fetch();
      await sg.pull();
    } catch {
      // If pull fails, use existing clone
    }
    return targetPath;
  }

  await mkdir(REPOS_DIR, { recursive: true });
  const cloneUrl = git.getCloneUrl(repo);

  const sg = simpleGit();
  await sg.clone(cloneUrl, targetPath, shallow ? ["--depth", "1"] : []);

  return targetPath;
}
