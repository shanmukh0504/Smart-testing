# Auto Testing Dashboard

React + Vite + TypeScript dashboard for the Auto Testing system. Grafana-inspired dark theme.

## Features

- **Current Running Tests** – Progress bar, total/completed/remaining, start time, cancel
- **Manual Controls** – Run tests, rerun all, rerun failed only
- **Add Test Cases** – Describe extra tests; AI agent generates and appends to existing
- **Scheduler** – Enable/disable, cron expression, next run time
- **Last Run Info** – Last run date, last successful run
- **Past Test History** – Table with filters (status, trigger, date range)
- **Generated Tests** – List of repos and test files

## Environment

Create `.env` (see `.env.example`):

```
VITE_API_URL=http://localhost:8080
```

When set, API and report requests go directly to this URL. When unset, the dev server proxies `/api`, `/report`, `/test` to `http://localhost:8080`.

## Run

1. Start the auto-testing server: `cd ../auto-testing && npm run server`
2. Start the dashboard: `npm run dev`
3. Open http://localhost:5173
