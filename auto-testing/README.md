# Auto Testing Agent

AI-powered automatic testing agent that generates and runs frontend (Playwright) and backend (API) tests based on your repositories and prompts.

## Features

- **Git Integration**: Supports GitHub and Gitea (switch via `GIT_PROVIDER`)
- **Recent Activity**: Analyzes the 120 most recently active repos
- **README Context**: Extracts product context from README files
- **API Docs**: Discovers API documentation from markdown files
- **AI Test Generation**: Uses Claude to generate comprehensive tests
- **Config-driven**: Specify which repos to test and base URLs
- **Dual Output**: Playwright for UI, Vitest for API tests

## Setup

1. **Install dependencies**

```bash
npm install
```

2. **Configure environment**

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Required variables in `.env`:

- `GIT_PROVIDER` - `"github"` or `"gitea"` (default: gitea)
- `GIT_TOKEN` - Your personal access token (GitHub or Gitea)
- `GIT_ORG` - Organization/owner name
- `ANTHROPIC_API_KEY` - Your Anthropic API key for Claude
- `GIT_BASE_URL` - For Gitea: your instance URL (e.g. `https://version.btcfi.wtf`). For GitHub: leave empty (uses api.github.com) or set for GitHub Enterprise

**Example for Gitea:**
```env
GIT_PROVIDER=gitea
GIT_BASE_URL=https://version.btcfi.wtf
GIT_ORG=your-org
GIT_TOKEN=your_gitea_token
```

**Example for GitHub:**
```env
GIT_PROVIDER=github
GIT_BASE_URL=
GIT_ORG=your-org
GIT_TOKEN=ghp_your_github_token
```

3. **Create test config**

Copy `config/test-config.example.json` to `config/test-config.json` and customize:

```json
{
  "repos": ["org/my-frontend-app", "org/my-backend-api"],
  "apiBaseUrls": {
    "org/my-backend-api": "https://api.example.com"
  },
  "uiBaseUrls": {
    "org/my-frontend-app": "https://app.example.com"
  },
  "recentReposLimit": 120
}
```

Use `org/repo` format (GitHub or Gitea).

## Usage

### Server mode (curl to run tests)

Start the server, then send a POST request with your prompt:

```bash
# Start server (runs in background)
npm run server

# In another terminal - run tests via curl
curl -X POST http://localhost:8080/test \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://testnet.api.garden.finance/v2/quote?from=ethereum_sepolia:wbtc&to=ethereum_sepolia:eth&from_amount=50000&indicative=true",
    "type": "backend",
    "context": "Garden Finance Quote API, org/quote",
    "apiBaseUrl": "https://testnet.api.garden.finance",
    "repo": "org/quote"
  }'
```

Response includes the report URL:
```json
{
  "success": true,
  "testsGenerated": 1,
  "message": "Tests complete. Open http://localhost:8080/report to view results.",
  "reportUrl": "http://localhost:8080/report"
}
```

View results at **http://localhost:8080/report**

### Bootstrap (fetch repos and analyze)

```bash
npm run bootstrap
```

### Generate tests

**Frontend (UI) tests:**

```bash
npm run generate -- \
  --url "https://app.example.com/dashboard" \
  --type frontend \
  --context "Dashboard page of the main app, shows user stats and charts"
```

**Backend (API) tests:**

```bash
npm run generate -- \
  --url "https://api.example.com/users" \
  --type backend \
  --context "User API endpoints" \
  --api-base "https://api.example.com"
```

### Run tests

```bash
# Run all tests (UI + API)
npm run test:run

# Run only UI tests
npm run test:ui

# Run only API tests
npm run test:api
```

## Project Structure

```
auto-testing/
├── config/
│   ├── test-config.json      # Your config (repos, base URLs)
│   └── test-config.example.json
├── src/
│   ├── agent.ts              # Main orchestrator
│   ├── cli.ts                # CLI entry point
│   ├── config.ts             # Config schema
│   ├── git-provider.ts       # GitHub/Gitea abstraction (single switch point)
│   ├── gitea-client.ts       # Gitea API client
│   ├── github-client.ts      # GitHub API client
│   ├── repo-analyzer.ts      # README + API doc extraction
│   ├── repo-cloner.ts        # Clone repos for context
│   ├── server.ts             # HTTP API server
│   ├── test-generator.ts     # Claude-powered test generation
│   └── test-runner.ts        # Vitest + Playwright runner
├── generated-tests/          # Output: generated test files
├── playwright.config.ts
└── vitest.api.config.ts
```

## Scripts

All scripts use `tsx` (no build step). Edit code, restart, and changes apply.

| Script | Description |
|--------|-------------|
| `npm run server` | Start HTTP server (POST /test, GET /report) |
| `npm run bootstrap` | Fetch repos and build context |
| `npm run generate` | Generate tests from prompt |
| `npm run test` | Generate and run tests |
| `npm run test:run` | Run existing generated tests |
| `npm run test:ui` | Run Playwright tests only |
| `npm run test:api` | Run Vitest API tests only |
| `npm run report` | Start report server |

## Security

**Never commit `.env` or tokens.** The `.env` file is gitignored. Use environment variables for secrets in CI/CD.

## Troubleshooting

- **Gitea behind Cloudflare Access**: Ensure you run from a network that can reach the Gitea instance (e.g. office WiFi, VPN).
- **No repos found**: Check `GIT_TOKEN` has correct scopes (Gitea: `read:repository`, `read:organization`; GitHub: `repo`).
- **Invalid GIT_PROVIDER**: Ensure `GIT_PROVIDER` is exactly `github` or `gitea`.
- **Claude errors**: Verify `ANTHROPIC_API_KEY` is valid and has sufficient quota.
