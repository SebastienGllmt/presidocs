// Tier-2 e2e: axe-core accessibility audit over every reader-facing page.
//
// This is the *rendered* half of the accessibility gate (see methodology →
// "WCAG, accessible-name, and landmark conformance"). The build-time gate
// (generate/audit-posts.ts) catches the render-INDEPENDENT issues from the
// static HTML; this catches what only a real browser can compute — colour
// contrast (composited colours, opacity, tinted backgrounds), the ARIA of
// JS-injected interactive figures, and Label-in-Name (visible text vs the
// resolved accessible name). axe-core is the same engine Lighthouse runs for
// its Accessibility category, so a clean run here ≈ a clean Lighthouse a11y
// score, on every post, without the full Lighthouse harness.
//
// Runs only via `bun run test:e2e` (the *.e2e.ts glob), never the unit run.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, startBlogServer, resolveBlogDir, type BlogServer } from "./harness.ts";

// WCAG A/AA across 2.0/2.1/2.2 — the conformance bars these posts target. We
// deliberately omit the `best-practice` tag: its structural rules (one main
// landmark, region, heading-order) overlap the build-time static gate and add
// noise. This tier is for the *rendered* WCAG failures a static pass can't see.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Rules deferred on purpose: Label-in-Name is a w=0 polish item (proposal 29
// §2.6) — REPORTED (so the backlog stays visible) but not failing. Delete an id
// the moment its fix lands and it becomes a hard gate.
//
// `color-contrast` is NO LONGER deferred — as of 2026-06 it's a HARD GATE
// (the figure palette + engine-chrome fixes that cleared it landed then; the
// colour/contrast standard lives in DESIGN.md §1–2). Any text below 4.5:1
// (3:1 large) anywhere now FAILS this suite, except the three
// surfaces in CONTRAST_EXEMPT_SELECTORS below.
const DEFERRED_RULES = new Set(["label-content-name-mismatch"]);

// ⚠️  DELIBERATE, NON-EXTENSIBLE contrast exemptions. ⚠️
//
// These two surfaces fail SC 1.4.3 BY DESIGN — the low contrast is the
// intended UX, not a bug we haven't gotten to. Their `color-contrast` nodes are
// stripped before the gate asserts (per-node, so EVERY OTHER rule still applies
// to them, and any *new* contrast failure anywhere else still hard-fails).
//
// This list is a fixed roster of conscious product decisions, NOT a pressure
// valve. Do NOT add to it to silence a real failure. The bar for entry is
// "the faintness is the deliberate point," and each entry is a known special
// case the figure-authoring guidance (DESIGN.md §1, figure-journey Rule 17)
// explicitly says NOT to imitate. If you're tempted to add a third, fix the
// colour instead — `bun run e2e/contrastReport.ts` shows you exactly what to fix.
const CONTRAST_EXEMPT_SELECTORS = [
  // The logged-out comments identity card: dimmed (opacity .35) until the reader
  // scrolls/engages, then brightens. Slated for a fundamental redesign (readers
  // dislike it); exempt only until that lands, then remove this line.
  ".cmt-identity-loggedout",
  // Narrator sub-chapter segments: subordinate-by-dim (opacity .7) beneath their
  // parent chapter on the dark dock — a transient, hover-restored affordance.
  ".ch-seg[data-sub]",
];

// Every reader-facing page: the landing plus each post (data sidecars included —
// they're served article pages too). Enumerated from the blog's source so a new
// post is covered the moment it exists, with no test edit.
function pagePaths(): string[] {
  const postsDir = join(resolveBlogDir(), "posts");
  const slugs = readdirSync(postsDir)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .sort();
  return ["/", ...slugs.map((s) => `/posts/${s}`)];
}

let browser: Browser;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

async function auditPage(page: Page, path: string): Promise<Violation[]> {
  await page.goto(new URL(path, server.baseURL).href, { waitUntil: "load" });
  // Let the client modules (byline, interactive figures, narrator, comments)
  // inject their DOM before the tree is audited — those JS-generated nodes are
  // exactly what this tier exists to check. Best-effort: a page that never
  // reaches network-idle (e.g. a stray long-poll) still gets audited rather
  // than failing the run on the wait itself.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    // The Shikwasa audio player (`.shk-player`) is a vendored widget whose
    // internal DOM we don't own (the methodology already treats it as a
    // `vendor`-layer boundary). Its a11y — e.g. the scrubber's progressbar
    // nesting, its own control labels — is an upstream / future-player-swap
    // concern, not a gate on our code. Our chapter strip and the article
    // dividers live OUTSIDE this subtree and stay audited.
    .exclude(".shk-player")
    .analyze();
  return violations;
}

// Strip the deliberately-exempt contrast nodes (CONTRAST_EXEMPT_SELECTORS) from
// the `color-contrast` violation, in-page, by checking each failing node against
// `closest()`. Per-NODE on purpose: an exempt surface still fails every OTHER
// rule, and a contrast failure on any non-exempt element still hard-fails. If
// the violation has no nodes left after stripping, it's dropped entirely.
async function stripExemptContrast(page: Page, violations: Violation[]): Promise<Violation[]> {
  const cc = violations.find((v) => v.id === "color-contrast");
  if (!cc) return violations;
  const kept: Violation["nodes"] = [];
  for (const n of cc.nodes) {
    const sel = Array.isArray(n.target) && typeof n.target[0] === "string" ? n.target[0] : null;
    const exempt = sel
      ? await page.evaluate(
          ({ s, exempts }) => {
            const el = document.querySelector(s);
            return !!el && exempts.some((ex) => el.closest(ex) !== null);
          },
          { s: sel, exempts: CONTRAST_EXEMPT_SELECTORS },
        )
      : false;
    if (!exempt) kept.push(n);
  }
  if (kept.length === cc.nodes.length) return violations; // nothing stripped
  return violations
    .map((v) => (v === cc ? { ...v, nodes: kept } : v))
    .filter((v) => v.id !== "color-contrast" || kept.length > 0);
}

function describe(v: Violation): string {
  const sample = v.nodes
    .slice(0, 3)
    .map((n) => {
      const html = n.html.length > 200 ? `${n.html.slice(0, 200)}…` : n.html;
      const why = (n.failureSummary ?? "").split("\n").filter(Boolean).join(" ");
      return `        ${n.target.join(" ")}\n          ${html}\n          → ${why}`;
    })
    .join("\n");
  const more = v.nodes.length > 3 ? `\n        …and ${v.nodes.length - 3} more node(s)` : "";
  return `    [${v.id}] (${v.impact}) ${v.help}\n      ${v.helpUrl}\n${sample}${more}`;
}

for (const path of pagePaths()) {
  test(
    `axe: ${path} has no blocking WCAG A/AA violations`,
    async () => {
      // axe-core/playwright assembles cross-frame results via a helper page, so
      // it requires a page from an explicit context (not browser.newPage()).
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const raw = await auditPage(page, path);
        const violations = await stripExemptContrast(page, raw);
        const blocking = violations.filter((v) => !DEFERRED_RULES.has(v.id));
        const deferred = violations.filter((v) => DEFERRED_RULES.has(v.id));

        // Visible-but-not-failing: shows the deferred backlog shrinking over time.
        if (deferred.length > 0) {
          const counts = deferred.map((v) => `${v.id}×${v.nodes.length}`).join(", ");
          console.log(`  ⓘ ${path}: deferred (tracked in proposal 29, not failing): ${counts}`);
        }

        if (blocking.length > 0) {
          throw new Error(
            `axe found ${blocking.length} blocking a11y violation(s) on ${path}:\n` +
              blocking.map(describe).join("\n"),
          );
        }
        expect(blocking).toEqual([]);
      } finally {
        await context.close();
      }
    },
    60_000,
  );
}
