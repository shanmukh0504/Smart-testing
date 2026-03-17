const API_ORIGIN = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : '';
const API_BASE = API_ORIGIN ? `${API_ORIGIN}/api` : '/api';

export function reportUrl(jobId: string): string {
  return API_ORIGIN ? `${API_ORIGIN}/report/${jobId}` : `/report/${jobId}`;
}

export function apiReportJsonUrl(jobId: string): string {
  return API_ORIGIN ? `${API_ORIGIN}/report/${jobId}/api` : `/report/${jobId}/api`;
}

export interface RunHistoryEntry {
  jobId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  startTime: string;
  endTime?: string;
  triggerType: 'manual' | 'scheduled' | 'auto' | 'add-cases';
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  repo?: string;
  branch?: string;
  author?: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  cronExpression: string;
  lastRun?: string;
  lastSuccessfulRun?: string;
  nextRun?: string;
}

export interface RepoWithType {
  name: string;
  type: 'backend' | 'frontend';
}

export interface TestsResponse {
  repos: string[];
  testsByRepo: Record<string, string[]>;
  reposWithType: RepoWithType[];
}

export interface RunProgress {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  completed: number;
  pending: number;
}

export interface KTSummary {
  generated_at: string;
  modules: number;
  apis: number;
  ui_components: number;
  tests: {
    api: number;
    playwright: number;
    unit: number;
    integration: number;
  };
}

export interface KTListResponse {
  repos: string[];
  kts: Record<string, KTSummary>;
  settings?: Record<string, RepoSettings>;
}

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
  requiredParams?: KTApiParam[];
  optionalParams?: KTApiParam[];
  requestBody?: { fields: KTApiParam[] };
  responseFormat?: string;
  authType?: string;
  authHeader?: string;
  params?: string[];
  queryParams?: string[];
  bodyFields?: string[];
  authRequired?: boolean;
}

export interface KTUIButton {
  text: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  type?: string;
}

export interface KTUIComponent {
  name: string;
  path: string;
  description: string;
  buttons?: KTUIButton[];
  elementStyles?: { selector: string; classes: string; text?: string }[];
  distinguishingFactors?: string[];
  testIds?: string[];
  ariaLabels?: string[];
}

export interface RepoSettings {
  repoType: 'frontend' | 'backend';
  auth?: {
    type: 'bearer' | 'apiKey' | 'none';
    headerName?: string;
    value?: string;
  };
  endpointParams?: Record<string, Record<string, string>>;
}

export interface KTDetail {
  kt: {
    generated_at: string;
    architecture: string;
    modules: KTModule[];
    apis: KTApi[];
    ui_components: KTUIComponent[];
  };
  tests: {
    unit: string[];
    integration: string[];
    playwright: string[];
    api: string[];
  };
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export const api = {
  // Existing endpoints
  getTests: () => fetchJSON<TestsResponse>(`${API_BASE}/tests`),

  getRuns: (params?: { limit?: number; status?: string; trigger?: string; dateFrom?: string; dateTo?: string }) => {
    const q = new URLSearchParams(params as Record<string, string>).toString();
    return fetchJSON<{ runs: RunHistoryEntry[] }>(`${API_BASE}/runs${q ? `?${q}` : ''}`);
  },

  getCurrentRun: () =>
    fetchJSON<{ running: boolean; jobId?: string; progress?: RunProgress }>(`${API_BASE}/runs/current`),

  getLastRun: () =>
    fetchJSON<{ lastRun: { date: string; status: string } | null; lastSuccessfulRun: { date: string } | null }>(`${API_BASE}/last-run`),

  getSchedule: () => fetchJSON<ScheduleConfig>(`${API_BASE}/schedule`),

  updateSchedule: (config: Partial<ScheduleConfig>) =>
    fetchJSON<ScheduleConfig>(`${API_BASE}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),

  triggerTest: () =>
    fetchJSON<{ jobId: string; status?: string; reportUrl: string }>(`${API_BASE}/test/trigger`, { method: 'POST' }),

  rerunTests: () =>
    fetchJSON<{ jobId: string; status?: string; reportUrl: string }>(`${API_BASE}/test/rerun`, { method: 'POST' }),

  rerunFailedTests: () =>
    fetchJSON<{ jobId: string; status?: string; reportUrl: string }>(`${API_BASE}/test/rerun-failed`, { method: 'POST' }),

  cancelTest: () =>
    fetchJSON<{ cancelled: boolean }>(`${API_BASE}/test/cancel`, { method: 'POST' }),

  generateTests: (params: {
    url: string;
    type: 'frontend' | 'backend';
    context: string;
    repo: string;
    apiBaseUrl?: string;
    sampleResponse?: object;
    secretsAndParams?: string;
  }) =>
    fetchJSON<{ jobId: string; status?: string; reportUrl: string }>(`${API_BASE}/test/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  addTestCases: (params: {
    userPrompt: string;
    repo: string;
    apiBaseUrl?: string;
    endpoint?: string;
    sampleReq?: object;
    secretsAndParams?: string;
  }) =>
    fetchJSON<{ jobId: string; status?: string; reportUrl: string }>(`${API_BASE}/test/add-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  // New KT endpoints
  getKTList: () => fetchJSON<KTListResponse>(`${API_BASE}/kt`),

  getKTDetail: (repo: string) => fetchJSON<KTDetail>(`${API_BASE}/kt/${repo}`),

  generateKT: (repo: string, repoType?: 'frontend' | 'backend') =>
    fetchJSON<{ status: string; repo: string }>(`${API_BASE}/kt/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, ...(repoType && { repoType }) }),
    }),

  // New PR Mode endpoint
  testPR: (params: { repo: string; prNumber: number }) =>
    fetchJSON<{ jobId: string; status: string; repo: string; prNumber: number; reportUrl: string }>(`${API_BASE}/pr/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  // New Test Request endpoint
  testRequest: (params: {
    repo: string;
    module?: string;
    type?: 'frontend' | 'backend';
    apiBaseUrl?: string;
    uiBaseUrl?: string;
  }) =>
    fetchJSON<{ jobId: string; status: string; repo: string; reportUrl: string }>(`${API_BASE}/test/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  // Repo Settings
  getRepoSettings: (repo: string) =>
    fetchJSON<RepoSettings>(`${API_BASE}/repo/${repo}/settings`),

  saveRepoSettings: (repo: string, settings: RepoSettings) =>
    fetchJSON<RepoSettings>(`${API_BASE}/repo/${repo}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
};
