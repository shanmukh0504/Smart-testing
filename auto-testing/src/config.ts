import { z } from "zod";

export const RepoTestConfigSchema = z.object({
  repos: z.array(z.string()).default([]),
  apiBaseUrls: z.record(z.string()).default({}),
  uiBaseUrls: z.record(z.string()).default({}),
  recentReposLimit: z.number().default(120),
});

export type RepoTestConfig = z.infer<typeof RepoTestConfigSchema>;
