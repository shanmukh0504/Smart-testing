/**
 * Report server - serves test results at /report
 */

import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";

const PORT = parseInt(process.env.REPORT_PORT || "8080", 10);
const RESULTS_DIR = join(process.cwd(), "test-results");

async function serveReport(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost`);
  const path = url.pathname;

  if (path === "/report" || path === "/report/") {
    return serveReportPage(res);
  }
  if (path === "/report/api") {
    return serveApiReport(res);
  }
  if (path.startsWith("/report/ui")) {
    return servePlaywrightReport(req, res, path);
  }
  if (path.startsWith("/report/data/")) {
    return servePlaywrightData(res, path);
  }
  if (path.startsWith("/report/trace")) {
    return servePlaywrightTrace(res, path);
  }
  // Fallback: /report/<hash>.<ext> (attachments without data/ prefix)
  const attachmentMatch = path.match(/^\/report\/([a-f0-9]+\.[a-z0-9]+)$/);
  if (attachmentMatch) {
    return servePlaywrightAttachmentByHash(res, attachmentMatch[1]);
  }

  res.writeHead(404);
  res.end("Not found");
}

async function serveReportPage(res: import("http").ServerResponse) {
  let apiReport: object | null = null;
  const apiPath = join(RESULTS_DIR, "api-report.json");
  if (existsSync(apiPath)) {
    try {
      apiReport = JSON.parse(await readFile(apiPath, "utf-8"));
    } catch {
      apiReport = null;
    }
  }

  const uiExists = existsSync(join(process.cwd(), "playwright-report", "index.html"));

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #1a1a2e; color: #eee; }
    h1 { color: #00d9ff; }
    .card { background: #16213e; border-radius: 8px; padding: 1.5rem; margin: 1rem 0; }
    a { color: #00d9ff; }
    .pass { color: #4ade80; }
    .fail { color: #f87171; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #333; }
    code { background: #0f0f23; padding: 0.2em 0.4em; border-radius: 4px; }
    .test-row { cursor: pointer; user-select: none; }
    .test-row:hover { background: #1e2a4a; }
    .test-row td:first-child { color: #00d9ff; }
    .test-details { display: none; }
    .test-details.open { display: table-row; }
    .test-details td { background: #0f0f23; padding: 1rem; vertical-align: top; border-radius: 4px; font-size: 0.9em; }
    .test-details pre { margin: 0.5rem 0; white-space: pre-wrap; word-break: break-all; }
    .detail-section { margin: 0.75rem 0; }
    .detail-label { color: #00d9ff; font-weight: 600; margin-bottom: 0.25rem; }
    .actual { color: #f87171; }
    .expected { color: #4ade80; }
    .expand-icon { display: inline-block; width: 1em; margin-right: 0.5rem; transition: transform 0.2s; }
    .test-row.expanded .expand-icon { transform: rotate(90deg); }
  </style>
</head>
<body>
  <h1>📊 Test Report</h1>
  <div class="card">
    <h2>Quick Links</h2>
    ${uiExists ? '<p><a href="/report/ui">View Playwright UI Report</a></p>' : '<p>No UI report yet. Run UI tests first.</p>'}
    <p><a href="/report/api">View API Report (JSON)</a></p>
  </div>
  ${apiReport ? renderApiSummary(apiReport) : ""}
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

function parseAssertionError(msg: string): { actual?: string; expected?: string } {
  const m = msg.match(/expected\s+(.+?)\s+to\s+be\s+(.+?)(?:\s+\/\/|$)/);
  if (m) return { actual: m[1].trim(), expected: m[2].trim() };
  return {};
}

function parseApiResponse(msg: string): string | undefined {
  const m = msg.match(/(?:API Response|Response body|Response):\s*([\s\S]*?)(?:\n\s+at\s|$)/);
  if (m) {
    const body = m[1].trim();
    if (body.length > 0 && body.length < 10000) return body;
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderApiSummary(data: object): string {
  const d = data as {
    numPassedTests?: number;
    numFailedTests?: number;
    testResults?: Array<{
      assertionResults?: Array<{
        fullName: string;
        status: string;
        duration?: number;
        failureMessages?: string[];
      }>;
    }>;
  };
  const passed = d.numPassedTests ?? 0;
  const failed = d.numFailedTests ?? 0;
  const all: Array<{
    name: string;
    status: string;
    duration?: number;
    failureMessages?: string[];
  }> = [];
  for (const file of d.testResults || []) {
    for (const a of file.assertionResults || []) {
      all.push({
        name: a.fullName,
        status: a.status,
        duration: a.duration,
        failureMessages: a.failureMessages,
      });
    }
  }

  const rows = all
    .map((r, i) => {
      const detailsId = `details-${i}`;
      let detailsHtml = "";
      if (r.status === "failed" && r.failureMessages?.length) {
        const firstMsg = r.failureMessages[0];
        const parsed = parseAssertionError(firstMsg);
        const apiResponse = parseApiResponse(firstMsg);
        detailsHtml = `
        <tr class="test-details" id="${detailsId}"><td colspan="3">
          ${parsed.actual != null || parsed.expected != null ? `
          <div class="detail-section">
            <div class="detail-label">Actual vs Expected</div>
            ${parsed.actual != null ? `<div class="actual">Actual: ${escapeHtml(parsed.actual)}</div>` : ""}
            ${parsed.expected != null ? `<div class="expected">Expected: ${escapeHtml(parsed.expected)}</div>` : ""}
          </div>
          ` : ""}
          ${apiResponse ? `
          <div class="detail-section">
            <div class="detail-label">Output Response</div>
            <pre class="api-response">${escapeHtml(apiResponse)}</pre>
          </div>
          ` : ""}
          <div class="detail-section">
            <div class="detail-label">Diagnostic</div>
            <pre>${escapeHtml(r.failureMessages.join("\n\n"))}</pre>
          </div>
        </td></tr>`;
      } else {
        detailsHtml = `
        <tr class="test-details" id="${detailsId}"><td colspan="3">
          <div class="detail-section">
            <div class="detail-label">Status</div>
            <div class="pass">Passed</div>
            <div>Duration: ${Math.round(r.duration ?? 0)}ms</div>
          </div>
        </td></tr>`;
      }
      return `<tr class="test-row" onclick="this.classList.toggle('expanded');var d=this.nextElementSibling;if(d)d.classList.toggle('open')" title="Click to expand details">
        <td><span class="expand-icon">▶</span>${escapeHtml(r.name)}</td>
        <td class="${r.status}">${r.status}</td>
        <td>${Math.round(r.duration ?? 0)}ms</td>
      </tr>${detailsHtml}`;
    })
    .join("");

  return `
  <div class="card">
    <h2>API Test Summary</h2>
    <p><span class="pass">✓ ${passed} passed</span> ${failed ? `<span class="fail">✗ ${failed} failed</span>` : ""}</p>
    <p style="font-size: 0.9em; color: #888;">▶ Click any test name to expand details (Actual vs Expected, Output Response, Diagnostic)</p>
    <table>
      <thead><tr><th>Test</th><th>Status</th><th>Duration</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function serveApiReport(res: import("http").ServerResponse) {
  const apiPath = join(RESULTS_DIR, "api-report.json");
  if (!existsSync(apiPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No API report found. Run API tests first.");
    return;
  }
  const data = await readFile(apiPath, "utf-8");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(data);
}

async function servePlaywrightReport(
  _req: import("http").IncomingMessage,
  res: import("http").ServerResponse,
  path: string
) {
  const base = join(process.cwd(), "playwright-report");
  const relPath = path === "/report/ui" || path === "/report/ui/"
    ? "index.html"
    : path.replace("/report/ui", "").replace(/^\//, "");
  const filePath = join(base, relPath);

  if (!filePath.startsWith(base) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const content = await readFile(filePath);
  const ext = filePath.split(".").pop() || "";
  const ct =
    ext === "html" ? "text/html" :
    ext === "js" ? "application/javascript" :
    ext === "css" ? "text/css" :
    ext === "json" ? "application/json" :
    ext === "png" ? "image/png" :
    ext === "zip" ? "application/zip" : "application/octet-stream";

  res.writeHead(200, { "Content-Type": ct });
  res.end(content);
}

async function servePlaywrightData(res: import("http").ServerResponse, path: string) {
  const base = join(process.cwd(), "playwright-report");
  const relPath = path.replace("/report/data/", "data/");
  const filePath = join(base, relPath);

  if (!filePath.startsWith(base) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const content = await readFile(filePath);
  const ext = filePath.split(".").pop() || "";
  const ct =
    ext === "png" ? "image/png" :
    ext === "zip" ? "application/zip" :
    ext === "md" ? "text/markdown" :
    ext === "json" ? "application/json" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  res.end(content);
}

async function servePlaywrightAttachmentByHash(res: import("http").ServerResponse, filename: string) {
  const base = resolve(process.cwd(), "playwright-report", "data");
  const filePath = resolve(base, filename);
  if (!filePath.startsWith(base) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const content = await readFile(filePath);
  const ext = filePath.split(".").pop() || "";
  const ct =
    ext === "png" ? "image/png" :
    ext === "zip" ? "application/zip" :
    ext === "webm" ? "video/webm" :
    ext === "md" ? "text/markdown" :
    ext === "json" ? "application/json" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  res.end(content);
}

async function servePlaywrightTrace(res: import("http").ServerResponse, path: string) {
  const base = resolve(process.cwd(), "playwright-report", "trace");
  const relPath = path === "/report/trace" || path === "/report/trace/"
    ? "index.html"
    : path.replace("/report/trace", "").replace(/^\//, "");
  const filePath = resolve(base, relPath);

  if (!filePath.startsWith(base) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const content = await readFile(filePath);
  const ext = filePath.split(".").pop() || "";
  const ct =
    ext === "html" ? "text/html" :
    ext === "js" ? "application/javascript" :
    ext === "css" ? "text/css" :
    ext === "json" ? "application/json" :
    ext === "svg" ? "image/svg+xml" :
    ext === "webmanifest" ? "application/manifest+json" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  res.end(content);
}

export function startReportServer(port: number = PORT): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer(serveReport);
    server.listen(port, () => {
      console.log(`\n📊 Report server: http://localhost:${port}/report`);
      resolve();
    });
  });
}
