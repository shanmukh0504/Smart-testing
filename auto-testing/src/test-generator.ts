/**
 * AI-powered test generator using Claude.
 * KT-aware: uses Knowledge Transfer documents for richer, targeted test generation.
 * All repo context comes from the KT document — no separate RepoContext needed.
 */

import type { ClaudeClient } from "./claude-client.js";
import type { KTDocument } from "./kt-store.js";

export interface TestPrompt {
  /** URL of UI or API to test */
  url: string;
  /** Context to help identify which repo this belongs to */
  context: string;
  /** Type: frontend (UI) or backend (API) */
  type: "frontend" | "backend";
  /** Base URL for API (if backend) */
  apiBaseUrl?: string;
  /** Sample successful API response - use for correct assertions (backend) */
  sampleResponse?: object;
  /** Secrets, params, headers, body values needed to run the tests */
  secretsAndParams?: string;
  /** KT document for this repo (injected by agent if available) */
  kt?: KTDocument;
  /** PR diff context - changed files and patches (injected by agent for PR mode) */
  diffContext?: string;
}

export interface GeneratedTest {
  filename: string;
  content: string;
  type: "frontend" | "backend";
}

export class TestGenerator {
  private client: ClaudeClient;

  constructor(client: ClaudeClient) {
    this.client = client;
  }

  // ─── KT Context Builder ─────────────────────────────────────

  private buildKTContext(kt?: KTDocument): string {
    if (!kt) return "";

    const parts: string[] = [];

    parts.push(`\n## Knowledge Transfer (KT) Document`);
    parts.push(`Architecture: ${kt.architecture}`);

    if (kt.modules.length > 0) {
      parts.push(`\nModules (${kt.modules.length}):`);
      for (const m of kt.modules) {
        parts.push(`  - ${m.name} [${m.path}]: ${m.description}`);
      }
    }

    if (kt.apis.length > 0) {
      parts.push(`\nKnown API Endpoints (${kt.apis.length}):`);
      for (const a of kt.apis) {
        let line = `  - ${a.method} ${a.endpoint}: ${a.description}`;
        if (a.params?.length) line += `\n      Route params: ${a.params.join(", ")}`;
        if (a.queryParams?.length) line += `\n      Query params: ${a.queryParams.join(", ")}`;
        if (a.bodyFields?.length) line += `\n      Body fields: ${a.bodyFields.join(", ")}`;
        if (a.authRequired) line += `\n      Auth: required`;
        if (a.responseShape) line += `\n      Response shape: ${a.responseShape}`;
        parts.push(line);
      }
    }

    if (kt.ui_components.length > 0) {
      parts.push(`\nUI Components (${kt.ui_components.length}):`);
      for (const c of kt.ui_components) {
        let line = `  - ${c.name} [${c.path}]: ${c.description}`;
        if (c.testIds?.length) line += `\n      Test IDs: ${c.testIds.join(", ")}`;
        if (c.ariaLabels?.length) line += `\n      ARIA labels: ${c.ariaLabels.join(", ")}`;
        if (c.htmlIds?.length) line += `\n      HTML IDs: ${c.htmlIds.join(", ")}`;
        if (c.placeholders?.length) line += `\n      Placeholders: ${c.placeholders.join(", ")}`;
        if (c.textContent?.length) line += `\n      Text content: ${c.textContent.slice(0, 10).join(", ")}`;
        if (c.formFields?.length) line += `\n      Form fields: ${c.formFields.join(", ")}`;
        parts.push(line);
      }
    }

    return parts.join("\n").slice(0, 8000);
  }

  // ─── Frontend Tests ─────────────────────────────────────────

  async generateFrontendTests(
    prompt: TestPrompt
  ): Promise<GeneratedTest[]> {
    const kt = prompt.kt;
    const ktContext = this.buildKTContext(kt);
    const secretsContext = prompt.secretsAndParams
      ? `\n## Secrets, Params & Auth for Tests\nUse these values in the generated tests where applicable:\n${prompt.secretsAndParams}`
      : "";

    const repoName = kt?.repoName || "unknown";
    const repoFullName = kt?.repoFullName || "unknown";
    const description = kt?.description || "N/A";
    const techStack = kt?.techStack || "Unknown";
    const readmeContent = kt?.readmeContent || "";

    const systemPrompt = `You are a senior QA automation engineer. Your job is to generate production-quality Playwright UI tests for ANY web application.

## Repository Information
- Name: ${repoName} (${repoFullName})
- Description: ${description}
- Tech Stack: ${techStack}
- Target URL: ${prompt.url}

## Product Context
${readmeContent.slice(0, 4000)}
${ktContext}
${secretsContext}

## Your Task
Generate MINIMAL but HIGH-COVERAGE Playwright UI tests. Use the KT document to understand what pages and components exist.

## Test Strategy — Be Efficient
Do NOT write redundant tests. Each test should verify something DIFFERENT. Aim for MAXIMUM coverage with MINIMUM test count.

For each page/feature, write:
1. **Happy path** (1-2 tests) — page loads, key elements render, primary user flow works
2. **Failure/error state** (1 test) — invalid input, empty state, or error boundary
3. **Navigation** (1 test only for the whole app) — verify key routes are reachable

Do NOT test the same element twice. Do NOT write separate tests for "page loads" and "content renders" — combine them into one.

## Rules
1. Use \`@playwright/test\` — import { test, expect } from '@playwright/test'
2. Every test MUST start with \`await page.goto('${prompt.url}')\` or a subpath
3. Use resilient selectors: prefer \`getByRole\`, \`getByText\`, \`getByLabel\`, \`getByTestId\` over CSS selectors
4. Add meaningful test names that describe the user intent, not the implementation
5. Group related tests in \`test.describe\` blocks by feature or page
6. Handle async operations: use \`waitForSelector\`, \`waitForResponse\`, or \`waitForLoadState\` before assertions
7. Use \`expect(locator).toBeVisible()\` over \`toHaveCount\` where possible
8. For SPA/React/Vue apps: wait for hydration — add \`await page.waitForLoadState('networkidle')\` after navigation
9. Keep tests independent — no test should depend on another test's state
10. Add timeouts for slow-loading elements: \`expect(locator).toBeVisible({ timeout: 10000 })\`
11. **CRITICAL — Use KT-provided selectors ONLY. NEVER guess selectors.** When the KT provides:
    - Test IDs → use \`page.getByTestId('id')\`
    - HTML IDs → use \`page.locator('#id')\`
    - Placeholders → use \`page.getByPlaceholder('text')\`
    - ARIA labels → use \`page.getByLabel('label')\`
    - Text content → use \`page.getByText('text')\` or \`page.getByRole('button', { name: 'text' })\`
    - If the KT does NOT list selectors for a component, DO NOT write tests that click or assert on elements you cannot identify — skip that test or test only page load
12. Generate multiple test files grouped by feature/page if the app is large

## Output Format
Return ONLY a JSON object:
{ "tests": [{ "filename": "feature-name.ui.spec.ts", "content": "...typescript code..." }] }

Filenames MUST end with \`.ui.spec.ts\`. Use descriptive filenames based on the feature (e.g. "auth-flow.ui.spec.ts", "dashboard-widgets.ui.spec.ts").`;

    const userMessage = `Generate comprehensive Playwright UI tests for: ${prompt.url}\n\nContext: ${prompt.context}${prompt.diffContext ? `\n\nChanged code (PR diff):\n${prompt.diffContext}` : ""}`;

    const text = await this.client.chat({
      system: systemPrompt,
      message: userMessage,
      maxTokens: 16384,
    });

    return this.parseGeneratedTests(text, "frontend");
  }

  // ─── Backend / API Tests ────────────────────────────────────

  async generateBackendTests(
    prompt: TestPrompt,
    apiBaseUrl: string
  ): Promise<GeneratedTest[]> {
    const kt = prompt.kt;
    const ktContext = this.buildKTContext(kt);
    const secretsContext = prompt.secretsAndParams
      ? `\n## Secrets, Params & Auth for Tests\nUse these EXACT values in the generated tests for authentication, headers, query params, body fields, or any other configuration:\n${prompt.secretsAndParams}`
      : "";

    const repoName = kt?.repoName || "unknown";
    const repoFullName = kt?.repoFullName || "unknown";
    const description = kt?.description || "N/A";
    const techStack = kt?.techStack || "Unknown";
    const readmeContent = kt?.readmeContent || "";

    const systemPrompt = `You are a senior API test engineer. Your job is to generate production-quality API tests for ANY backend service using Vitest.

## Repository Information
- Name: ${repoName} (${repoFullName})
- Description: ${description}
- Tech Stack: ${techStack}
- API Base URL: ${apiBaseUrl}

## Product Context
${readmeContent.slice(0, 3000)}
${ktContext}
${secretsContext}

## Your Task
Generate MINIMAL but HIGH-COVERAGE API tests. Use the KT document (if provided) to understand:
- What endpoints exist, their HTTP methods, and what they do
- The expected request/response formats
- Authentication requirements

## Test Strategy — Be Efficient
Do NOT write redundant tests. Each test should verify something DIFFERENT. Aim for MAXIMUM coverage with MINIMUM test count.

For EACH endpoint, write exactly these tests (no more, no less):
1. **Happy path** (1 test) — valid request with correct params returns expected status and response shape
2. **Failure path** (1-2 tests) — invalid input (missing required param, wrong type) returns appropriate error status
3. **Edge case** (1 test) — boundary condition specific to this endpoint (empty string, special chars, or missing auth)

That's 3-4 tests per endpoint. Do NOT write separate tests for things that can be checked in one test (e.g. check both status code AND response shape in the same happy path test).

## Rules
1. Use \`vitest\` — import { describe, it, expect } from 'vitest'
2. Use native \`fetch\` for HTTP requests — no axios or other libraries
3. Define BASE_URL as a constant: \`const BASE_URL = '${apiBaseUrl}'\`
4. ALWAYS read response body as text FIRST, then parse — this avoids JSON parse errors on non-JSON responses:
   \`\`\`
   const res = await fetch(\`\${BASE_URL}/endpoint\`);
   const body = await res.text();
   // For success assertions:
   if (res.status !== 200) throw new Error(\`Expected 200, got \${res.status}. Response: \${body}\`);
   const data = JSON.parse(body);
   \`\`\`
5. For error responses, check Content-Type before parsing JSON:
   \`\`\`
   const ct = res.headers.get('content-type');
   if (ct?.includes('application/json')) {
     const data = JSON.parse(body);
     expect(data).toHaveProperty('error');
   } else {
     expect(res.status).toBeGreaterThanOrEqual(400);
   }
   \`\`\`
6. Include the API response in error messages for debugging — when an assertion fails, the report should show what the API actually returned
7. Use descriptive test names: "should return paginated results with limit parameter" not "test GET /users"
8. Group tests by endpoint in \`describe\` blocks
9. If the KT lists specific endpoints, test ALL of them — don't skip any
10. If sampleResponse is provided, use its exact structure for assertions
11. For POST/PUT endpoints, construct realistic request bodies based on the API documentation
12. Add proper headers: Content-Type: application/json for JSON request bodies
13. Generate multiple test files grouped by resource/domain if the API is large
14. **CRITICAL — Use KT-provided params ONLY. NEVER guess parameter names.** When the KT provides:
    - Query params → use EXACTLY those names in query strings (e.g. \`?page=1&fromChain=bitcoin\`)
    - Body fields → use EXACTLY those field names in request bodies
    - Route params → use EXACTLY those param names in URL paths
    - Response shape → use its structure for assertions
    - If the KT does NOT list params for an endpoint, only test the endpoint with no params and verify the response status

## Output Format
Return ONLY a JSON object:
{ "tests": [{ "filename": "resource-name.api.spec.ts", "content": "...typescript code..." }] }

Filenames MUST end with \`.api.spec.ts\`. Use descriptive filenames based on the resource (e.g. "users-api.api.spec.ts", "auth-api.api.spec.ts").`;

    const sampleStr = prompt.sampleResponse
      ? `\n\nSample successful response (use this exact structure for assertions):\n${JSON.stringify(prompt.sampleResponse, null, 2)}`
      : "";
    const userMessage = `Generate API tests for: ${apiBaseUrl}\n\nContext: ${prompt.context}\n\nTarget URL: ${prompt.url}${sampleStr}${prompt.diffContext ? `\n\nChanged code (PR diff):\n${prompt.diffContext}` : ""}`;

    const text = await this.client.chat({
      system: systemPrompt,
      message: userMessage,
      maxTokens: 16384,
    });

    return this.parseGeneratedTests(text, "backend");
  }

  // ─── Additional Tests (Add Cases) ──────────────────────────

  async generateAdditionalTests(
    userPrompt: string,
    existingTestsContent: string,
    type: "frontend" | "backend",
    apiBaseUrl?: string,
    options?: {
      endpoint?: string;
      sampleReq?: object;
      secretsAndParams?: string;
      kt?: KTDocument;
    }
  ): Promise<GeneratedTest[]> {
    const ktContext = this.buildKTContext(options?.kt);
    const endpointHint = options?.endpoint ? `\nTarget endpoint: ${options.endpoint}` : "";
    const sampleHint = options?.sampleReq ? `\nSample request/response:\n${JSON.stringify(options.sampleReq, null, 2)}` : "";
    const secretsHint = options?.secretsAndParams ? `\nSecrets, params & auth to use in tests:\n${options.secretsAndParams}` : "";
    const repoName = options?.kt?.repoName || "unknown";

    const systemPrompt = `You are a senior QA engineer adding new test cases to an existing test suite.

## Existing Tests (match this style exactly)
\`\`\`typescript
${existingTestsContent.slice(0, 8000)}
\`\`\`

## Repository: ${repoName}
${ktContext}

## User Request
${userPrompt}${endpointHint}${sampleHint}${secretsHint}

## Rules
1. Generate ONLY the new tests requested — do not duplicate existing tests
2. Match the EXACT same patterns from existing tests:
   - Same import style
   - Same BASE_URL / page.goto pattern
   - Same assertion patterns
   - Same describe/it structure
3. ${type === "backend"
    ? `Use vitest + fetch. BASE_URL = '${apiBaseUrl || "from existing tests"}'. Always read response as text first, then parse.`
    : "Use @playwright/test. Match the same page navigation and selector patterns."}
4. Use a unique filename that won't conflict with existing files
5. Write descriptive test names that explain the scenario being tested
6. If the KT document lists modules or endpoints relevant to the request, use that knowledge for precise test targeting

## Output Format
Return ONLY a JSON object:
{ "tests": [{ "filename": "descriptive-name.${type === "frontend" ? "ui" : "api"}.spec.ts", "content": "...typescript code..." }] }`;

    const userMessage = `Add these test cases: ${userPrompt}\n\nMatch the existing test style and structure.`;

    const text = await this.client.chat({
      system: systemPrompt,
      message: userMessage,
      maxTokens: 16384,
    });

    return this.parseGeneratedTests(text, type);
  }

  // ─── PR-Specific Test Generation ────────────────────────────

  async generatePRTests(
    prompt: TestPrompt,
    diffContext: string,
    kt: KTDocument,
    type: "frontend" | "backend",
    baseUrl: string,
    prInfo: { title: string; headBranch: string; baseBranch: string }
  ): Promise<GeneratedTest[]> {
    const ktContext = this.buildKTContext(kt);

    const repoName = kt.repoName || "unknown";
    const repoFullName = kt.repoFullName || "unknown";
    const techStack = kt.techStack || "Unknown";

    const systemPrompt = `You are a senior QA engineer reviewing a Pull Request and generating targeted tests for the changed code.

## PR Information
- Title: ${prInfo.title}
- Branch: ${prInfo.headBranch} → ${prInfo.baseBranch}

## Repository: ${repoName} (${repoFullName})
- Tech Stack: ${techStack}
- ${type === "backend" ? `API Base URL: ${baseUrl}` : `UI URL: ${baseUrl}`}

## KT Document (understand the full system before writing tests)
${ktContext}

## Changed Code (PR Diff)
${diffContext.slice(0, 10000)}

## Your Task
Analyze the PR diff and generate tests that specifically target the changes:

1. **Identify what changed**: Look at the diff to understand which modules, endpoints, components, or functions were modified
2. **Cross-reference with KT**: Use the KT document to understand HOW the changed code fits into the larger system
3. **Generate targeted tests**: Write tests that exercise the changed behavior, NOT the entire application
4. **Cover regression risks**: If a change touches shared code (utils, middleware, hooks), test downstream consumers
5. **Test both the change AND its integration**: If an endpoint handler changed, test the endpoint. If a component changed, test the page that uses it.

${type === "backend"
  ? `## Backend Test Rules
- Use vitest + native fetch
- const BASE_URL = '${baseUrl}'
- Read response as text first, then parse JSON
- Include response body in error messages
- Test the CHANGED endpoints specifically, plus any endpoints that depend on changed shared code`
  : `## Frontend Test Rules
- Use @playwright/test
- page.goto('${baseUrl}') or subpaths
- Use resilient selectors (getByRole, getByText, getByLabel)
- Wait for hydration with waitForLoadState('networkidle')
- Test the CHANGED components/pages specifically, plus any pages that render changed components`}

## Output Format
Return ONLY a JSON object:
{ "tests": [{ "filename": "pr-feature-name.${type === "frontend" ? "ui" : "api"}.spec.ts", "content": "...typescript code..." }] }`;

    const userMessage = `Generate ${type === "frontend" ? "UI" : "API"} tests for PR: "${prInfo.title}"\n\nFocus on the changed code shown in the diff.`;

    const text = await this.client.chat({
      system: systemPrompt,
      message: userMessage,
      maxTokens: 16384,
    });

    return this.parseGeneratedTests(text, type);
  }

  // ─── Helpers ────────────────────────────────────────────────

  private parseGeneratedTests(
    text: string,
    type: "frontend" | "backend"
  ): GeneratedTest[] {
    // Try to extract JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text;

    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.tests && Array.isArray(parsed.tests)) {
        const suffix = type === "frontend" ? ".ui.spec.ts" : ".api.spec.ts";
        return parsed.tests.map((t: { filename: string; content: string }) => ({
          filename: t.filename.endsWith(suffix)
            ? t.filename
            : t.filename.replace(/\.(spec\.)?ts?$/, "") + suffix,
          content: t.content,
          type: type,
        }));
      }
    } catch {
      // Fallback: try to extract tests from malformed/truncated JSON
      const suffix = type === "frontend" ? ".ui.spec.ts" : ".api.spec.ts";
      const extracted = this.extractTestsFromRawText(text, suffix);
      if (extracted.length > 0) return extracted;

      // Last resort: treat as single test
      const filename = type === "frontend" ? "ui.spec.ts" : "api.spec.ts";
      return [{ filename, content: text, type }];
    }

    return [];
  }

  /** Extract test objects from raw text when JSON parse fails (e.g. truncated) */
  private extractTestsFromRawText(text: string, suffix: string): GeneratedTest[] {
    const results: GeneratedTest[] = [];
    const re = new RegExp(
      `"filename"\\s*:\\s*"([^"]+${suffix.replace(".", "\\.")})"\\s*,\\s*"content"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const content = m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (content.includes("test(") || content.includes("test.describe(") || content.includes("describe(")) {
        results.push({ filename: m[1], content, type: suffix.includes("ui") ? "frontend" : "backend" });
      }
    }
    return results;
  }
}
