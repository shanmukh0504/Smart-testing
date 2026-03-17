/**
 * KT (Knowledge Transfer) document generator.
 * Hybrid approach: deterministic scanner collects source data,
 * Claude AI analyzes it for intelligent KT extraction.
 * Falls back to scanner-only if AI is unavailable.
 */

import { DeterministicKTGenerator, type ScannedRepoData, type ExtractedUISelectors, type ExtractedAPIContract, type ExtractedButtonInfo } from "./deterministic-kt-generator.js";
import type { ClaudeClient } from "./claude-client.js";
import type { RepoContext } from "./repo-analyzer.js";
import type { KTDocument, KTModule, KTApi, KTUIComponent, KTUIButton, KTApiParam } from "./kt-store.js";
import { basename } from "path";

export class KTGenerator {
  private scanner: DeterministicKTGenerator;
  private client: ClaudeClient;

  constructor(client: ClaudeClient) {
    this.scanner = new DeterministicKTGenerator();
    this.client = client;
  }

  /**
   * Generate a comprehensive KT document for a repository.
   * 1. Scans repo filesystem to collect source code and structure
   * 2. Feeds collected data to Claude for intelligent analysis
   * 3. Falls back to scanner-only results if AI fails
   */
  async generateKT(repoContext: RepoContext, repoPath?: string): Promise<KTDocument> {
    if (!repoPath) {
      console.log(`[KT] No local clone available, building minimal KT from repo context`);
      return this.buildMinimalKT(repoContext);
    }

    // Step 1: Deterministic scan to collect raw data
    console.log(`[KT] Scanning repo filesystem: ${repoPath}`);
    const scanned = await this.scanner.scanRepo(repoPath);
    console.log(`[KT] Scanner collected directory tree + source snippets`);

    // Step 2: Static extraction of selectors and API contracts (zero AI cost)
    console.log(`[KT] Extracting UI selectors and API contracts...`);
    const [uiSelectors, apiContracts] = await Promise.all([
      this.scanner.extractUISelectors(repoPath),
      this.scanner.extractAPIContracts(repoPath),
    ]);
    console.log(`[KT] Extracted selectors from ${uiSelectors.size} UI files, contracts from ${apiContracts.size} API files`);

    // Step 3: Feed scanned data to AI for intelligent analysis
    try {
      console.log(`[KT] Sending scanned data to AI for analysis...`);
      console.log(`[KT] Scanned data size: tree=${scanned.directoryTree.length} chars, snippets=${scanned.sourceSnippets.length} chars`);
      const aiKT = await this.analyzeWithAI(repoContext, scanned);
      console.log(
        `[KT] AI analysis complete: ${aiKT.modules.length} modules, ${aiKT.apis.length} APIs, ${aiKT.ui_components.length} UI components`
      );

      // Step 4: Merge static extractions into AI-produced KT
      this.mergeStaticExtractions(aiKT, uiSelectors, apiContracts);
      return aiKT;
    } catch (err) {
      console.warn(`[KT] AI analysis failed, using scanner results as fallback:`, err);
      const fallbackKT = this.buildKTFromScan(repoContext, scanned);
      this.mergeStaticExtractions(fallbackKT, uiSelectors, apiContracts);
      return fallbackKT;
    }
  }

  /**
   * Update KT by re-scanning and re-analyzing the repo.
   */
  async updateModuleKT(
    existingKT: KTDocument,
    moduleInfo: { name: string; path: string },
    repoPath: string,
    repoContext: RepoContext
  ): Promise<KTDocument> {
    console.log(`[KT] Re-scanning repo to update module "${moduleInfo.name}"`);
    return this.generateKT(repoContext, repoPath);
  }

  /**
   * Send collected repo data to Claude for intelligent KT extraction.
   */
  private async analyzeWithAI(repoContext: RepoContext, scanned: ScannedRepoData): Promise<KTDocument> {
    const systemPrompt = `You are a senior software architect analyzing a repository to create a Knowledge Transfer (KT) document.

You are given the repository's directory structure and actual source code snippets. Analyze the code to identify:
1. **Modules**: Distinct functional units (services, features, packages). Look at directory structure and imports.
2. **API endpoints**: REST/GraphQL endpoints. Look at route definitions, handler functions, API route files. Include the HTTP method, path, and FULL parameter details.
3. **UI components**: React/Vue/Svelte components. Look at exported components, page components, layouts. Include button details and distinguishing visual factors.

Repository: ${repoContext.fullName}
Description: ${repoContext.description}
Tech Stack: ${repoContext.techStack}
Structure: ${repoContext.structure.slice(0, 30).join(", ")}

README (excerpt):
${repoContext.readmeContent.slice(0, 3000)}

Directory tree:
${scanned.directoryTree}

Source code from key files:
${scanned.sourceSnippets.slice(0, 25000)}

Return a JSON object with exactly this structure (no markdown wrapping, ONLY the JSON object):
{
  "architecture": "High-level architecture description including patterns, frameworks, and design decisions",
  "modules": [
    { "name": "module-name", "description": "what it does and its responsibilities", "path": "src/module", "last_modified": "" }
  ],
  "apis": [
    {
      "endpoint": "/api/path",
      "method": "GET",
      "description": "what it does",
      "requiredParams": [{ "name": "param_name", "type": "string", "required": true, "description": "what this param is" }],
      "optionalParams": [{ "name": "param_name", "type": "string", "required": false, "description": "what this param is" }],
      "requestBody": { "fields": [{ "name": "field_name", "type": "string", "required": true, "description": "field purpose" }] },
      "responseFormat": "{ example JSON shape of the response }",
      "authType": "bearer or apiKey or none",
      "authHeader": "Authorization or X-API-Key etc"
    }
  ],
  "ui_components": [
    {
      "name": "ComponentName",
      "path": "src/components/Component.tsx",
      "description": "what it renders and its purpose",
      "buttons": [{ "text": "Button Text", "className": "btn-primary bg-blue-500", "type": "submit", "role": "button" }],
      "elementStyles": [{ "selector": "div.main-container", "classes": "flex items-center bg-gray-100", "text": "visible text if any" }],
      "distinguishingFactors": ["Has a blue Submit button with class btn-primary", "Contains a search input with placeholder 'Search...'"]
    }
  ]
}

IMPORTANT for API endpoints:
- List ALL required and optional parameters (path params, query params, headers)
- Include the full request body schema with field names, types, and whether each is required
- Include the response format as a JSON example or schema
- Specify auth type (bearer token, API key, none) and the header name used

IMPORTANT for UI components:
- List ALL buttons with their visible text, CSS classes/styles, and any data-testid or aria-label
- Include key element styles (CSS classes) that help visually identify and distinguish the component
- Add distinguishing factors: unique text, colors, layout patterns, icons that make this component identifiable

Be thorough — identify ALL modules, API endpoints, and UI components you can find in the provided code.
If a category has no items, return an empty array.`;

    const text = await this.client.chat({
      system: systemPrompt,
      message: `Analyze the repository source code and generate a comprehensive KT document for: ${repoContext.fullName}`,
      maxTokens: 8192,
    });

    console.log(`[KT] Raw AI response (first 500 chars): ${text.slice(0, 500)}`);
    console.log(`[KT] Raw AI response length: ${text.length} chars`);
    return this.parseKTResponse(text);
  }

  /**
   * Parse Claude's response into a KTDocument.
   * Falls back to empty KT if parsing fails.
   */
  private parseKTResponse(text: string): KTDocument {
    // Extract JSON from possible markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        generated_at: new Date().toISOString(),
        architecture: parsed.architecture || "",
        modules: (parsed.modules || []).map((m: any) => ({
          name: m.name || "",
          description: m.description || "",
          path: m.path || "",
          last_modified: m.last_modified || "",
        })) as KTModule[],
        apis: (parsed.apis || []).map((a: any) => ({
          endpoint: a.endpoint || "",
          method: a.method || "GET",
          description: a.description || "",
          ...(a.requiredParams?.length && { requiredParams: a.requiredParams }),
          ...(a.optionalParams?.length && { optionalParams: a.optionalParams }),
          ...(a.requestBody && { requestBody: a.requestBody }),
          ...(a.responseFormat && { responseFormat: a.responseFormat }),
          ...(a.authType && { authType: a.authType }),
          ...(a.authHeader && { authHeader: a.authHeader }),
        })) as KTApi[],
        ui_components: (parsed.ui_components || []).map((c: any) => ({
          name: c.name || "",
          path: c.path || "",
          description: c.description || "",
          ...(c.buttons?.length && { buttons: c.buttons }),
          ...(c.elementStyles?.length && { elementStyles: c.elementStyles }),
          ...(c.distinguishingFactors?.length && { distinguishingFactors: c.distinguishingFactors }),
        })) as KTUIComponent[],
      };
    } catch {
      console.warn(`[KT] Failed to parse AI response as JSON, returning minimal KT`);
      return {
        generated_at: new Date().toISOString(),
        architecture: text.slice(0, 2000),
        modules: [],
        apis: [],
        ui_components: [],
      };
    }
  }

  /**
   * Merge statically extracted UI selectors and API contracts into the KT document.
   * Matches by file path (exact first, then filename fallback).
   */
  private mergeStaticExtractions(
    kt: KTDocument,
    uiSelectors: Map<string, ExtractedUISelectors>,
    apiContracts: Map<string, ExtractedAPIContract[]>
  ): void {
    // Merge UI selectors into components
    for (const comp of kt.ui_components) {
      const selectors = uiSelectors.get(comp.path) || this.findByFilename(uiSelectors, comp.path);
      if (selectors) {
        if (selectors.testIds.length > 0) comp.testIds = selectors.testIds;
        if (selectors.ariaLabels.length > 0) comp.ariaLabels = selectors.ariaLabels;
        if (selectors.htmlIds.length > 0) comp.htmlIds = selectors.htmlIds;
        if (selectors.placeholders.length > 0) comp.placeholders = selectors.placeholders;
        if (selectors.textContent.length > 0) comp.textContent = selectors.textContent;
        if (selectors.formFields.length > 0) comp.formFields = selectors.formFields;
        // Merge button info from static extraction if AI didn't provide them
        if (selectors.buttons.length > 0 && (!comp.buttons || comp.buttons.length === 0)) {
          comp.buttons = selectors.buttons;
        }
        // Merge element styles
        if (selectors.elementStyles.length > 0 && (!comp.elementStyles || comp.elementStyles.length === 0)) {
          comp.elementStyles = selectors.elementStyles;
        }
      }
    }

    // Merge API contracts into endpoints
    // Collect all contracts into a flat list for matching
    const allContracts: ExtractedAPIContract[] = [];
    for (const contracts of apiContracts.values()) {
      allContracts.push(...contracts);
    }

    for (const api of kt.apis) {
      // Find a contract whose routePath matches this endpoint
      const match = allContracts.find((c) => {
        if (!c.routePath) return false;
        const normalizedRoute = c.routePath.replace(/^\//, "");
        const normalizedEndpoint = api.endpoint.replace(/^\//, "");
        return normalizedRoute === normalizedEndpoint || normalizedRoute.includes(normalizedEndpoint) || normalizedEndpoint.includes(normalizedRoute);
      });

      if (match) {
        if (match.params.length > 0) api.params = match.params;
        if (match.queryParams.length > 0) api.queryParams = match.queryParams;
        if (match.bodyFields.length > 0) api.bodyFields = match.bodyFields;
        if (match.authRequired) {
          api.authRequired = true;
          if (!api.authType) api.authType = "bearer";
          if (!api.authHeader) api.authHeader = "Authorization";
        }
        if (match.responseSnippet) api.responseShape = match.responseSnippet;
        // Build structured params from static extraction if AI didn't provide them
        if (!api.requiredParams?.length && match.params.length > 0) {
          api.requiredParams = match.params.map(p => ({ name: p, type: "string", required: true, description: `Path parameter: ${p}` }));
        }
        if (!api.optionalParams?.length && match.queryParams.length > 0) {
          api.optionalParams = match.queryParams.map(p => ({ name: p, type: "string", required: false, description: `Query parameter: ${p}` }));
        }
        if (!api.requestBody && match.bodyFields.length > 0) {
          api.requestBody = { fields: match.bodyFields.map(f => ({ name: f, type: "string", required: true, description: `Body field: ${f}` })) };
        }
      }

      // Also look for TypeScript param types (contracts without routePath)
      const paramType = allContracts.find((c) =>
        !c.routePath && c.queryParams.length > 0 && c.responseSnippet?.includes("Params")
      );
      if (paramType && !api.queryParams?.length) {
        api.queryParams = paramType.queryParams;
      }
    }

    const selectorCount = kt.ui_components.filter((c) =>
      c.testIds?.length || c.htmlIds?.length || c.placeholders?.length || c.textContent?.length
    ).length;
    const contractCount = kt.apis.filter((a) => a.queryParams?.length || a.params?.length || a.bodyFields?.length).length;
    console.log(`[KT] Merged selectors into ${selectorCount} components, contracts into ${contractCount} APIs`);
  }

  /**
   * Fallback: find a UI selector entry by matching just the filename part.
   */
  private findByFilename<T>(map: Map<string, T>, path: string): T | undefined {
    const target = basename(path);
    for (const [key, value] of map) {
      if (basename(key) === target) return value;
    }
    return undefined;
  }

  /**
   * Build minimal KT when AI analysis fails (no scanner data to fall back on).
   */
  private buildKTFromScan(repoContext: RepoContext, _scanned: ScannedRepoData): KTDocument {
    const parts: string[] = [];
    parts.push(`${repoContext.fullName} is a ${repoContext.techStack} application.`);
    if (repoContext.description) parts.push(repoContext.description);

    return {
      generated_at: new Date().toISOString(),
      architecture: parts.join(" "),
      modules: [],
      apis: [],
      ui_components: [],
    };
  }

  /**
   * Minimal KT when no clone is available.
   */
  private buildMinimalKT(repoContext: RepoContext): KTDocument {
    return {
      generated_at: new Date().toISOString(),
      architecture: `${repoContext.fullName} is a ${repoContext.techStack} application. ${repoContext.description}`,
      modules: [],
      apis: [],
      ui_components: [],
    };
  }
}
