/**
 * Auto Testing Agent - Programmatic API
 */

export { AutoTestingAgent } from "./agent.js";
export type { AgentOptions, RunOptions, PRModeOptions, PRTestReport, TestRequestOptions, TestRequestResult } from "./agent.js";
export { createGitProvider } from "./git-provider.js";
export type { GitProvider, GitRepo, GitFile, GitProviderType, PullRequest, PRDiffFile } from "./git-provider.js";
export { GiteaClient } from "./gitea-client.js";
export type { GiteaRepo, GiteaFile } from "./gitea-client.js";
export { GitHubClient } from "./github-client.js";
export { RepoAnalyzer } from "./repo-analyzer.js";
export type { RepoContext } from "./repo-analyzer.js";
export { TestGenerator } from "./test-generator.js";
export type { TestPrompt, GeneratedTest } from "./test-generator.js";
export { KTGenerator } from "./kt-generator.js";
export { loadKT, saveKT, listKTs, deleteKT, isModuleStale, mergeTestSuites } from "./kt-store.js";
export type { RepoKT, KTDocument, KTModule, KTApi, KTUIComponent, KTTestSuite } from "./kt-store.js";
export { RepoTestConfigSchema } from "./config.js";
export type { RepoTestConfig } from "./config.js";
