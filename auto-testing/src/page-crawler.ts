/**
 * Playwright-based page crawler.
 * Visits actual pages, captures cleaned HTML and interactive elements.
 * Used by test generator to produce tests grounded in real DOM structure.
 *
 * NOTE: page.evaluate() callbacks run in the browser. TypeScript cannot
 * type-check DOM APIs inside those callbacks (no "dom" lib in this project),
 * so we use `Function` casts where necessary.
 */

import { chromium, type Browser, type Page } from "playwright";

export interface CrawledPage {
  url: string;
  path: string;
  title: string;
  /** Cleaned HTML of the page body */
  html: string;
  /** Interactive elements found on the page */
  interactiveElements: InteractiveElement[];
}

export interface InteractiveElement {
  tag: string;
  text: string;
  selector: string;
  href?: string;
}

export interface CrawlOptions {
  maxPages?: number;
  timeout?: number;
}

const MAX_HTML_LENGTH = 50_000;

/**
 * Get cleaned HTML from a page — strips scripts, styles, SVGs, and noisy attributes.
 */
async function getCleanedHtml(page: Page): Promise<string> {
  // Runs in browser context — uses DOM APIs
  return page.evaluate(`(() => {
    const body = document.body;
    if (!body) return "";
    const clone = body.cloneNode(true);

    // Remove non-visual elements
    clone.querySelectorAll("script, style, noscript, link, meta, iframe, video, audio, source, track, object, embed")
      .forEach(el => el.remove());

    // Replace SVGs with placeholder
    clone.querySelectorAll("svg").forEach(el => {
      const span = document.createElement("span");
      span.textContent = "[icon]";
      el.replaceWith(span);
    });

    // Replace images with alt text
    clone.querySelectorAll("img").forEach(el => {
      const alt = el.getAttribute("alt") || "";
      const span = document.createElement("span");
      span.textContent = alt ? "[img: " + alt + "]" : "[img]";
      el.replaceWith(span);
    });

    // Strip noisy attributes, keep useful ones
    const keep = new Set([
      "id","class","data-testid","aria-label","aria-labelledby","aria-describedby",
      "role","href","type","placeholder","name","value","disabled","checked",
      "alt","title","for","action","method","target"
    ]);
    clone.querySelectorAll("*").forEach(el => {
      el.removeAttribute("style");
      for (const attr of Array.from(el.attributes)) {
        if (!keep.has(attr.name) && !attr.name.startsWith("data-test")) {
          el.removeAttribute(attr.name);
        }
      }
      const cls = el.getAttribute("class");
      if (cls && cls.length > 150) {
        el.setAttribute("class", cls.slice(0, 150) + "...");
      }
    });

    let html = clone.innerHTML;
    html = html.replace(/\\n\\s+/g, "\\n");
    html = html.replace(/\\s{2,}/g, " ");
    return html.trim();
  })()`) as Promise<string>;
}

/**
 * Extract interactive elements from the page: links, buttons, inputs.
 */
async function getInteractiveElements(
  page: Page
): Promise<InteractiveElement[]> {
  return page.evaluate(`(() => {
    const results = [];
    const seen = new Set();

    // Links
    document.querySelectorAll("a[href]").forEach(el => {
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
      const href = el.getAttribute("href") || "";
      if (!text || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
      const key = "link:" + text;
      if (seen.has(key)) return;
      seen.add(key);
      const testId = el.getAttribute("data-testid");
      const ariaLabel = el.getAttribute("aria-label");
      const selector = testId
        ? '[data-testid="' + testId + '"]'
        : ariaLabel
          ? 'a[aria-label="' + ariaLabel + '"]'
          : 'text=' + text.slice(0, 40);
      results.push({ tag: "a", text, selector, href });
    });

    // Buttons
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
      if (!text) return;
      const key = "button:" + text;
      if (seen.has(key)) return;
      seen.add(key);
      const testId = el.getAttribute("data-testid");
      const ariaLabel = el.getAttribute("aria-label");
      const selector = testId
        ? '[data-testid="' + testId + '"]'
        : ariaLabel
          ? '[aria-label="' + ariaLabel + '"]'
          : 'button:has-text("' + text.slice(0, 40) + '")';
      results.push({ tag: "button", text, selector });
    });

    // Inputs
    document.querySelectorAll("input, textarea, select").forEach(el => {
      const placeholder = el.getAttribute("placeholder") || "";
      const label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
      const text = placeholder || label;
      if (!text) return;
      const key = "input:" + text;
      if (seen.has(key)) return;
      seen.add(key);
      const testId = el.getAttribute("data-testid");
      const selector = testId
        ? '[data-testid="' + testId + '"]'
        : placeholder
          ? '[placeholder="' + placeholder + '"]'
          : '[name="' + el.getAttribute("name") + '"]';
      results.push({ tag: el.tagName.toLowerCase(), text, selector });
    });

    return results;
  })()`) as Promise<InteractiveElement[]>;
}

/**
 * Discover same-origin links from the current page.
 */
async function discoverLinks(page: Page, origin: string): Promise<string[]> {
  return page.evaluate(`((origin) => {
    return Array.from(document.querySelectorAll("a[href]"))
      .map(a => {
        try { return new URL(a.getAttribute("href"), window.location.href).href; }
        catch { return null; }
      })
      .filter(h => h !== null && h.startsWith(origin) && !h.includes("#"));
  })("${origin}")`) as Promise<string[]>;
}

/**
 * Crawl a website starting from baseUrl.
 *
 * 1. Visit the base URL, capture cleaned HTML and interactive elements
 * 2. Discover same-origin links, visit them
 * 3. On each page, click buttons to discover dynamic content
 * 4. Returns all discovered pages with their HTML
 */
export async function crawlSite(
  baseUrl: string,
  options: CrawlOptions = {}
): Promise<CrawledPage[]> {
  const { maxPages = 10, timeout = 15000 } = options;

  const crawledPages: CrawledPage[] = [];
  const visitedPaths = new Set<string>();
  const toVisit: string[] = [baseUrl];

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    const origin = new URL(baseUrl).origin;

    while (toVisit.length > 0 && crawledPages.length < maxPages) {
      const url = toVisit.shift()!;
      let urlPath: string;
      try {
        urlPath = new URL(url).pathname;
      } catch {
        continue;
      }
      if (visitedPaths.has(urlPath)) continue;
      visitedPaths.add(urlPath);

      console.log(`[CRAWLER] Visiting: ${url}`);

      try {
        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout,
        });
        if (!response || response.status() >= 400) {
          console.warn(
            `[CRAWLER] Skipping ${url} (status ${response?.status()})`
          );
          continue;
        }

        // Wait for SPA to render
        await page.waitForTimeout(2000);

        const title = await page.title();
        const html = await getCleanedHtml(page);
        const interactiveElements = await getInteractiveElements(page);

        // Discover same-origin links to visit next
        const discoveredLinks = await discoverLinks(page, origin);

        for (const link of [...new Set(discoveredLinks)]) {
          try {
            const p = new URL(link).pathname;
            if (!visitedPaths.has(p)) {
              toVisit.push(link);
            }
          } catch {
            /* skip invalid URLs */
          }
        }

        crawledPages.push({
          url: page.url(),
          path: urlPath,
          title,
          html: html.slice(0, MAX_HTML_LENGTH),
          interactiveElements,
        });

        // Click buttons to discover dynamic content / modals / navigation
        const clickableButtons = interactiveElements
          .filter((el) => el.tag === "button")
          .slice(0, 3);

        for (const btn of clickableButtons) {
          try {
            // Reload page fresh before each click
            await page.goto(url, { waitUntil: "networkidle", timeout });
            await page.waitForTimeout(1000);

            await page.click(btn.selector, { timeout: 3000 });
            await page.waitForTimeout(2000);

            const afterUrl = page.url();
            const afterPath = new URL(afterUrl).pathname;

            // If the click navigated to a new page, capture it
            if (afterPath !== urlPath && !visitedPaths.has(afterPath)) {
              visitedPaths.add(afterPath);
              const newTitle = await page.title();
              const newHtml = await getCleanedHtml(page);
              const newElements = await getInteractiveElements(page);

              crawledPages.push({
                url: afterUrl,
                path: afterPath,
                title: newTitle,
                html: newHtml.slice(0, MAX_HTML_LENGTH),
                interactiveElements: newElements,
              });
              console.log(
                `[CRAWLER] Discovered page via click "${btn.text}": ${afterUrl}`
              );
            }
          } catch {
            // Element not clickable or timed out — skip
          }
        }
      } catch (err) {
        console.warn(
          `[CRAWLER] Failed to visit ${url}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  console.log(`[CRAWLER] Done. Crawled ${crawledPages.length} pages.`);
  return crawledPages;
}
