# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

AI-powered automatic testing platform that generates and runs Playwright (UI) and Vitest (API) tests using Claude. Consists of two independent projects:

- **auto-testing/** — Node.js/Express backend: AI test generation, test execution, job management, cron scheduling
- **testing-dashboard/** — React/Vite frontend: dashboard UI for monitoring and controlling test runs

---

## Commands

### auto-testing (backend)

```bash
cd auto-testing
npm install
npm run build          # TypeScript compilation (tsc)
npm run server         # Start HTTP server on port 8080
npm run bootstrap      # Fetch repos from Git provider and analyze
npm run generate       # Generate tests (--url, --type, --context flags)
npm run test           # Generate and run tests
npm run test:run       # Run existing generated tests (UI + API)
npm run test:ui        # Run Playwright UI tests only
npm run test:api       # Run Vitest API tests only (vitest.api.config.ts)
npm run report         # Start report server
```

All scripts use `tsx` for direct TypeScript execution — no build step needed for development.

### testing-dashboard (frontend)

```bash
cd testing-dashboard
npm install
npm run dev            # Vite dev server on port 5173 (proxies /api to auto-testing)
npm run build          # TypeScript check + Vite production build
npm run lint           # ESLint
npm run preview        # Preview production build
```

### Running the full stack

```bash
# Terminal 1: Backend
cd auto-testing && npm run server

# Terminal 2: Frontend
cd testing-dashboard && npm run dev
# Open http://localhost:5173
```

---

## Architecture

### auto-testing

The backend follows a pipeline: **Git Provider → Repo Analyzer → Test Generator → Test Runner → Report Server**.

- **`agent.ts`** — Main orchestrator (`AutoTestingAgent`). Coordinates bootstrap, test generation, and test case addition. Entry point for all test workflows.
- **`server.ts`** — Express API server. All REST endpoints live here. Starts the cron scheduler on boot. CORS enabled for all origins.
- **`cli.ts`** — Commander-based CLI. Wraps agent methods as subcommands (`bootstrap`, `generate`, `run`, `server`).
- **`git-provider.ts`** — Abstract `GitProvider` interface with factory function `createGitProvider()`. Switches between GitHub (`github-client.ts`) and Gitea (`gitea-client.ts`) based on `GIT_PROVIDER` env var.
- **`repo-analyzer.ts`** — Extracts README content, API docs, tech stack, and source snippets. Works both via Git API (`analyzeFromApi`) and local clone (`analyzeFromLocal`).
- **`test-generator.ts`** — Calls Claude API to generate test code. Produces `.ui.spec.ts` (Playwright) or `.api.spec.ts` (Vitest) files. Also supports `generateAdditionalTests()` for appending new cases.
- **`test-runner.ts`** — Executes Playwright and Vitest as child processes. Manages job state, run history (`test-results/run-history.json`), progress tracking, cancellation, and 24h report cleanup.
- **`schedule.ts`** — Cron scheduling via `node-cron`. Config persisted in `test-results/schedule.json`. Default: every 4 hours UTC.
- **`config.ts`** — Zod schema for `config/test-config.json` (repos, apiBaseUrls, uiBaseUrls, recentReposLimit).

Generated tests are written to `generated-tests/{repo-name}/` with naming convention `*.ui.spec.ts` or `*.api.spec.ts`. Test results are stored in job directories: `test-results/job-{timestamp}-{id}/` and `playwright-report/job-{timestamp}-{id}/`.

### testing-dashboard

Single-page React app with Tailwind CSS (Grafana-inspired dark theme).

- **`App.tsx`** — Monolithic component with all state and UI. Polls backend every 3 seconds. Sections: overview, history, tests, add-cases, generate, schedule.
- **`api.ts`** — Fetch wrapper for all backend endpoints. Uses `VITE_API_URL` env var or falls back to Vite dev proxy.
- **`vite.config.ts`** — Proxies `/api`, `/report`, `/test` to backend (default `http://localhost:8080`).

---

## Environment Variables

### auto-testing (.env)
- `GIT_PROVIDER` — `"github"` or `"gitea"`
- `GIT_BASE_URL` — Required for Gitea, optional for GitHub Enterprise
- `GIT_ORG` — Organization/owner name
- `GIT_TOKEN` — Git provider access token
- `ANTHROPIC_API_KEY` — Claude API key
- `CLAUDE_MODEL` — Optional model override (default: claude-sonnet-4-20250514)
- `PORT` — Server port (default: 8080)

### testing-dashboard (.env)
- `VITE_API_URL` — Backend URL (default: http://localhost:8080, proxied in dev)

---

## Key Conventions

- TypeScript ESM throughout (`"type": "module"` in both projects, `.js` extensions in imports)
- Test files follow strict naming: `*.ui.spec.ts` for Playwright, `*.api.spec.ts` for Vitest
- Job IDs follow format `job-{timestamp}-{id}` (generated in `job-id.ts`)
- Config file at `config/test-config.json` drives which repos to test and their base URLs
- Reports auto-cleanup after 24 hours

---

## Agent Behavior

You are an intelligent test engineering agent. You operate in two modes: **PR Mode** and **Test Request Mode**. Follow the instructions below precisely for each mode.

---

### 🧠 Shared Behavior: Knowledge Transfer (KT) Generation

Before doing anything in either mode, check if a KT (Knowledge Transfer document) already exists in memory for the given repository.

**If KT does not exist:**
- Scan the repository from the `main` branch only
- Analyze folder structure, modules, services, APIs, and UI components
- Generate a comprehensive KT document covering:
  - Project overview and architecture
  - All modules and their responsibilities
  - **API endpoints (if backend)**: For each endpoint, extract ALL required params, optional params, request body schema (field names, types, required/optional), response format (JSON example), auth type (bearer/apiKey/none), and auth header name
  - **UI component tree (if frontend)**: For each component, extract ALL buttons with their visible text, CSS classes/styles, data-testid, aria-label, and type. Also extract key element styles (CSS classes on containers, sections) and distinguishing factors (unique text, colors, layout patterns) that help identify the component in the UI
  - Data flow and dependencies
- Store the KT in `memory/<repo-name>/<repo-name>.json`
- Record `kt.generated_at` as the current timestamp
- Generate a full test suite for all modules:
  - Unit + integration tests for each module
  - Playwright UI tests if frontend is detected
  - API tests (request/response validation, edge cases) if backend is detected
- Store all generated tests in memory associated with the repo

**If KT already exists:**
- Compare `kt.generated_at` against the last commit timestamp on the repo's `main` branch
- **If `kt.generated_at` < `main` branch last updated time** → the KT is stale:
  - Re-scan only the files/modules that changed on `main` since `kt.generated_at`
  - Update the affected parts of the KT in memory
  - Update `kt.generated_at` to the current timestamp
  - Log what changed in the KT update log
- **If `kt.generated_at` >= `main` branch last updated time** → KT is up to date, load and proceed

> ⚠️ **KT is only ever updated based on the `main` branch.** It is never updated during a PR review, since the PR may or may not get merged. See PR Mode rules below.

---

### Mode 1: PR Mode

**Trigger:** A pull request is opened or updated against `main`

#### Steps:

1. **KT Check** — Run the shared KT check above for the target repo
   > The KT staleness check here only reads `main` to decide if the KT needs refreshing **before** the PR analysis. The PR diff itself **never** triggers a KT update — the PR may not get merged. KT is updated only when changes land on `main`.

2. **Git Diff Analysis**
   - Fetch the diff between the PR branch and `main`
   - Identify all changed files, functions, classes, endpoints, and components

3. **Test Generation for Changes**
   - For each changed module/file:
     - Generate new test cases covering the changed logic
     - If frontend change: generate Playwright tests for affected UI flows
     - If backend change: generate API tests for affected endpoints
   - Add generated tests to the existing test suite stored in memory for this repo

4. **Test Execution**
   - Run all newly generated tests against the PR branch
   - Capture pass/fail results, errors, and coverage

5. **Report Generation**
   - Output a structured PR Test Report containing:
     - Summary: total tests run, passed, failed, skipped
     - Per-module breakdown
     - Failing test details with error messages and stack traces
     - Coverage delta (what's covered vs. what's not)
     - Recommendations for any untested edge cases

---

### Mode 2: Test Request Mode

**Trigger:** A test generation request is made for a specific module or feature

#### Steps:

1. **KT Check** — Run the shared KT check above for the target repo. This handles both the case where KT doesn't exist yet and where it is stale relative to `main`. No separate staleness check needed here — the shared step covers it.

2. **Test Generation**
   - Check `memory/<repo-name>/settings.json` for the `repoType` field to determine if this is a frontend or backend repo
   - If `repoType` is `"backend"`: generate API tests (Vitest). Use stored auth credentials and endpoint parameter values from `settings.json` when running tests
   - If `repoType` is `"frontend"`: generate UI tests (Playwright). Use stored button styles, element classes, and distinguishing factors from the KT to write reliable selectors
   - If `repoType` is not set, auto-detect from the KT (has APIs → backend, has UI components → frontend, or both)
   - Generate tests for the requested module:
     - Unit tests for all functions/methods
     - Integration tests for module interactions
     - Playwright UI tests if the module has frontend components
     - API tests if the module exposes endpoints
   - Merge new tests into the existing test suite for this repo in memory (no duplicates)

3. **Output**
   - Return the newly generated tests
   - Confirm whether the KT was updated and summarize what changed

---

### 🗂️ Memory Schema (per repo)

KT documents are stored in `memory/<repo-name>/<repo-name>.json`.
Repo settings are stored in `memory/<repo-name>/settings.json`.

#### KT Document (`memory/<repo-name>/<repo-name>.json`)

```json
{
  "kt": {
    "generated_at": "<timestamp>",
    "architecture": "...",
    "modules": [ { "name": "...", "description": "...", "path": "...", "last_modified": "..." } ],
    "apis": [
      {
        "endpoint": "/api/path",
        "method": "GET|POST|PUT|DELETE",
        "description": "what the endpoint does",
        "requiredParams": [{ "name": "param_name", "type": "string", "required": true, "description": "purpose" }],
        "optionalParams": [{ "name": "param_name", "type": "string", "required": false, "description": "purpose" }],
        "requestBody": { "fields": [{ "name": "field", "type": "string", "required": true, "description": "purpose" }] },
        "responseFormat": "{ JSON example or schema of response }",
        "authType": "bearer|apiKey|none",
        "authHeader": "Authorization|X-API-Key"
      }
    ],
    "ui_components": [
      {
        "name": "ComponentName",
        "path": "src/components/Component.tsx",
        "description": "what it renders",
        "buttons": [{ "text": "Button Text", "className": "btn-primary bg-blue-500", "testId": "submit-btn", "type": "submit" }],
        "elementStyles": [{ "selector": "div.container", "classes": "flex bg-gray-100", "text": "visible text" }],
        "distinguishingFactors": ["Has blue Submit button", "Contains search input with placeholder 'Search...'"]
      }
    ]
  },
  "tests": {
    "unit": [],
    "integration": [],
    "playwright": [],
    "api": []
  }
}
```

#### Repo Settings (`memory/<repo-name>/settings.json`)

```json
{
  "repoType": "frontend|backend",
  "auth": {
    "type": "bearer|apiKey|none",
    "headerName": "Authorization",
    "value": "token_value"
  },
  "endpointParams": {
    "GET /api/v1/price/usd": {
      "order_pair": "BTC/ETH"
    }
  }
}
```

The `repoType` determines whether the agent generates UI (Playwright) or API (Vitest) tests.
For backend repos, `auth` and `endpointParams` provide the required auth credentials and parameter values needed to run the generated tests.
For frontend repos, the KT stores button styles, text content, CSS classes, and other distinguishing factors to help identify components during Playwright test generation.

---

### ⚙️ Rules

- Always read from `main` branch for KT generation and staleness checks — never from feature branches
- **KT is updated only when:**
  - It does not exist yet for a repo, or
  - A request comes in for a repo and `kt.generated_at` < `main` branch's last updated time, or
  - A PR is merged into `main` (treat this as a new `main` state — next request will trigger a staleness update)
- **KT is never updated during a PR review** — PRs may not get merged; always wait for changes to land on `main`
- Never duplicate tests — check existing tests before adding new ones
- Always run tests after generation in PR Mode and report results
- If a repo has both frontend and backend, handle both test types
- If you cannot determine the framework (React, Express, Django, etc.), infer it from `package.json`, `requirements.txt`, or equivalent config files