// Console-error / CSP-violation gate — the rendered half of Lighthouse's
// Best-Practices category (`errors-in-console` + `inspector-issues` "Content
// security policy"). axe.e2e.ts is to the Accessibility category what this is to
// Best Practices: a real-browser pass that fails on exactly what those audits
// read, over every reader-facing page, without the full Lighthouse harness.
//
// Why the wrangler tier (and NOT the fast dev server): a CSP violation only
// fires when the *enforced* production CSP is on the response. The Bun dev
// server (startBlogServer) doesn't run `withSecurityHeaders`, so `style-src
// 'self'` isn't applied there and the violation is invisible — which is exactly
// how an engine-emitted inline-`<style>` violation (the cascade-layer-order pin)
// could reach prod undetected. So this drives the built worker under `wrangler dev`
// (startWranglerServer = `bun run build` + `wrangler dev`), where
// `shared/securityHeaders.ts` wraps every document — i.e. what a reader's
// browser actually enforces.
//
// What it catches that the header-only prodAudioSmoke can't: prodAudioSmoke
// asserts the CSP *header string* is present; this asserts the page's own JS
// (GSAP figures, narrator, comments, Shikwasa) doesn't *violate* it at runtime.
//
// NOT named `*.e2e.ts` on purpose: like prodAudioSmoke.ts / serviceWorker.ts
// it's a heavy tier (a full build + wrangler boot), run only via its own
// script — `bun run test:e2e:csp` — never the default `bun test` or the Chrome
// `test:e2e` lane. `PRESIDOCS_E2E_SKIP_BUILD=1` reuses an existing fresh `dist/`
// for faster local iteration.
//
// Precondition: the harness runs `bun run build`, which rewrites source posts
// (managed <script> tags) + versions.json per normal build behavior — run on an
// ephemeral/CI checkout, or `git checkout` those afterward.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, startWranglerServer, resolveBlogDir, type BlogServer } from "./harness.ts";

// A CSP violation as surfaced by the `securitypolicyviolation` DOM event — the
// structured, locale-independent signal (Chromium also logs it to the console,
// which is the literal text Lighthouse's `errors-in-console` reads, but the
// event carries the directive/blocked-URI so failures are self-describing).
interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
    __presidocsFigures?: Map<string, unknown>;
  }
}

// Every reader-facing page: the landing plus each post — enumerated from source
// so a new post is covered the moment it exists (same convention as axe.e2e.ts).
function pagePaths(): string[] {
  const postsDir = join(resolveBlogDir(), "posts");
  const slugs = readdirSync(postsDir)
    .filter((f) => f.endsWith(".html"))
    // `_`-prefixed entries are fixtures/drafts the build excludes from dist
    // (build-html.ts), so the Worker 404s them — don't enumerate them here.
    .filter((f) => !f.startsWith("_"))
    .map((f) => f.replace(/\.html$/, ""))
    .sort();
  return ["/", ...slugs.map((s) => `/posts/${s}`)];
}

let browser: Browser;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startWranglerServer()]);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

// Record every CSP violation into `window.__cspViolations`, installed BEFORE any
// page script runs so violations during initial parse + figure boot are caught.
async function armCspCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations!.push({
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        sample: e.sample,
      });
    });
  });
}

// Drive the page so the interactive subsystems actually run — a CSP violation
// that only fires when GSAP builds a figure timeline is invisible on a static
// load. Best-effort throughout: pages without figures (landing) must not hang.
async function exercise(page: Page, path: string): Promise<void> {
  await page.goto(new URL(path, server.baseURL).href, { waitUntil: "load", timeout: 30_000 });
  // Posts: wait for the figure registry to populate (figures build their GSAP
  // journey on module init — the code path that writes the offending inline
  // style), then settle for async registrants (e.g. hashAvalanche).
  await page
    .waitForFunction(() => (window.__presidocsFigures?.size ?? 0) > 0, { timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  // Scroll the whole page to trip any viewport-gated figure init, then settle.
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    window.scrollTo(0, 0);
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

function describe(v: CspViolation): string {
  const where = v.sourceFile ? ` (${v.sourceFile}:${v.lineNumber})` : "";
  const sample = v.sample ? ` — sample: ${v.sample.slice(0, 80)}` : "";
  return `    [${v.violatedDirective}] blocked ${v.blockedURI}${where}${sample}`;
}

for (const path of pagePaths()) {
  test(
    `csp: ${path} triggers no Content-Security-Policy violations`,
    async () => {
      const context = await browser.newContext();
      await armCspCapture(context);
      const page = await context.newPage();
      // Also surface console errors (what Lighthouse's errors-in-console reads),
      // for diagnostics — the hard gate is the structured CSP event below.
      const consoleErrors: string[] = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
      try {
        await exercise(page, path);
        const violations = (await page.evaluate(() => window.__cspViolations ?? [])) as CspViolation[];

        if (consoleErrors.length > 0 && violations.length === 0) {
          // Non-CSP console errors don't fail this gate (they may be benign,
          // e.g. an aborted long-poll on teardown), but we log them so they're
          // visible and a future tightening can promote them.
          console.log(`  ⓘ ${path}: ${consoleErrors.length} console error(s) (not CSP, not failing):`);
          for (const e of consoleErrors.slice(0, 5)) console.log(`      ${e.slice(0, 160)}`);
        }

        if (violations.length > 0) {
          throw new Error(
            `${violations.length} CSP violation(s) on ${path} ` +
              `(would fail Lighthouse Best-Practices errors-in-console / inspector-issues):\n` +
              violations.map(describe).join("\n"),
          );
        }
        expect(violations).toEqual([]);
      } finally {
        await context.close();
      }
    },
    60_000,
  );
}
