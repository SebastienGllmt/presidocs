// Contrast detection reporter — the "what fails, by how much, and where" triage
// tool for the contrast standard (DESIGN.md §1–2). axe.e2e.ts GATES text
// contrast (pass/fail per page) but only prints node COUNTS — useless
// for actually picking replacement shades. This reporter runs the same axe
// `color-contrast` check (SC 1.4.3, the engine Lighthouse uses) over every
// reader-facing page and dumps, for each failing element, the foreground /
// background / measured ratio / required ratio — then AGGREGATES by colour pair
// so the distinct failing colour tokens surface as a short, fixable list
// instead of scattered nodes.
//
// It answers two questions the count-only axe log can't:
//   1. WHICH colours fail, and by how much (so a shade nudge can be targeted).
//   2. WHEN do we pass — the trailer prints a single PASS/FAIL line; zero
//      failing text nodes is the signal to delete `color-contrast` from
//      axe.e2e.ts's DEFERRED_RULES and let it become a hard gate.
//
// SCOPE: text only (SC 1.4.3) — that's all axe-core checks. Non-text graphical
// contrast (SC 1.4.11: figure bars/segments/swatches) is invisible to axe and
// needs the per-frame figure gate (e2e/figureContrast.e2e.ts; DESIGN.md §2).
//
// NOT a test and NOT named `*.e2e.ts`: it never asserts, so it can't fail a
// suite. Run it on demand to see the backlog:
//     bun run scripts/contrastReport.ts            # all pages
//     bun run scripts/contrastReport.ts offer-files # one slug (+ the landing)
// Like cspConsole.ts it's a heavy real-browser tier, kept out of the default
// `bun test` and the `test:e2e` glob.

import type { Browser, Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, startBlogServer, resolveBlogDir, type BlogServer } from "../e2e/harness.ts";

// Same tag set + Shikwasa exclusion as axe.e2e.ts, so this reports exactly the
// nodes that gate would fail on once the ratchet flips — no more, no less.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// The data axe's color-contrast check attaches to each failing node's check
// result (axe-core's `color-contrast` evaluate populates this `data` blob).
interface ContrastData {
  fgColor?: string;
  bgColor?: string;
  contrastRatio?: number;
  expectedContrastRatio?: number | string;
  fontSize?: string;
  fontWeight?: string;
}

interface FailingNode {
  page: string;
  selector: string;
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  required: number;
  fontSize: string;
  fontWeight: string;
}

function pagePaths(slugFilter?: string): string[] {
  const postsDir = join(resolveBlogDir(), "posts");
  const slugs = readdirSync(postsDir)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .filter((s) => !slugFilter || s === slugFilter)
    .sort();
  return ["/", ...slugs.map((s) => `/posts/${s}`)];
}

// `expectedContrastRatio` comes through as e.g. "4.5:1"; coerce to the number.
function parseRequired(v: number | string | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.match(/[\d.]+/);
    if (m) return Number(m[0]);
  }
  return 4.5; // axe's default text threshold if it ever omits it
}

async function collectPage(page: Page, path: string, baseURL: string): Promise<FailingNode[]> {
  await page.goto(new URL(path, baseURL).href, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .withRules(["color-contrast"]) // ONLY contrast — this is a focused report
    .exclude(".shk-player")
    .analyze();

  const out: FailingNode[] = [];
  for (const v of violations) {
    if (v.id !== "color-contrast") continue;
    for (const n of v.nodes) {
      // The contrast numbers live on whichever check carried `data` (axe puts
      // them on the failing `any[]` check).
      const check = [...n.any, ...n.all, ...n.none].find(
        (c) => c.data && typeof c.data === "object" && "contrastRatio" in (c.data as object),
      );
      const d = (check?.data ?? {}) as ContrastData;
      const html = n.html.replace(/\s+/g, " ").trim();
      out.push({
        page: path,
        selector: n.target.join(" "),
        text: html.length > 60 ? html.slice(0, 60) + "…" : html,
        fg: (d.fgColor ?? "?").toLowerCase(),
        bg: (d.bgColor ?? "?").toLowerCase(),
        ratio: typeof d.contrastRatio === "number" ? d.contrastRatio : NaN,
        required: parseRequired(d.expectedContrastRatio),
        fontSize: d.fontSize ?? "",
        fontWeight: d.fontWeight ?? "",
      });
    }
  }
  return out;
}

// Group by the fg→bg colour pair: that's the unit an author actually fixes (a
// shared muted-grey on a shared tint is ONE token edit, not N node edits).
interface PairGroup {
  fg: string;
  bg: string;
  ratio: number; // the measured ratio (constant for a fixed fg/bg pair)
  required: number;
  count: number;
  pages: Set<string>;
  samples: FailingNode[];
}

function groupByPair(nodes: FailingNode[]): PairGroup[] {
  const map = new Map<string, PairGroup>();
  for (const n of nodes) {
    const key = `${n.fg}|${n.bg}`;
    let g = map.get(key);
    if (!g) {
      g = { fg: n.fg, bg: n.bg, ratio: n.ratio, required: n.required, count: 0, pages: new Set(), samples: [] };
      map.set(key, g);
    }
    g.count++;
    g.pages.add(n.page);
    if (g.samples.length < 3) g.samples.push(n);
    if (!Number.isNaN(n.ratio)) g.ratio = n.ratio;
  }
  // Worst (lowest ratio) first — the most visually broken tokens lead.
  return [...map.values()].sort((a, b) => (a.ratio || 0) - (b.ratio || 0));
}

function fmt(n: number): string {
  return Number.isNaN(n) ? "?" : n.toFixed(2);
}

async function main(): Promise<void> {
  const slugFilter = process.argv[2];
  let browser: Browser | undefined;
  let server: BlogServer | undefined;
  try {
    [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
    const paths = pagePaths(slugFilter);
    const all: FailingNode[] = [];
    for (const path of paths) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const nodes = await collectPage(page, path, server.baseURL);
        all.push(...nodes);
        console.log(`  ${nodes.length === 0 ? "✓" : "✗"} ${path}: ${nodes.length} failing text node(s)`);
      } finally {
        await context.close();
      }
    }

    console.log("\n" + "─".repeat(72));
    const groups = groupByPair(all);
    if (groups.length === 0) {
      console.log("PASS — 0 failing text nodes (SC 1.4.3). Safe to flip the axe");
      console.log("       color-contrast ratchet to a hard gate (remove it from");
      console.log("       DEFERRED_RULES in e2e/axe.e2e.ts).");
      return;
    }

    console.log(`${groups.length} distinct failing colour pair(s), ${all.length} node(s) total`);
    console.log("(worst ratio first — fix the token, not each node)\n");
    for (const g of groups) {
      const large = g.required <= 3 ? " [large-text 3:1]" : "";
      console.log(
        `  ${fmt(g.ratio)}:1  (need ${g.required}:1${large})  fg ${g.fg}  on  bg ${g.bg}` +
          `  ×${g.count}  [${[...g.pages].length} page(s)]`,
      );
      for (const s of g.samples) {
        console.log(`        ${s.selector}  ${s.fontSize}/${s.fontWeight}`);
        console.log(`          ${s.text}`);
      }
    }
    console.log("\n" + "─".repeat(72));
    console.log(`FAIL — ${all.length} text node(s) below SC 1.4.3 across ${paths.length} page(s).`);
    console.log(`       ${groups.length} colour pairs to fix before the axe ratchet can flip.`);
  } finally {
    await browser?.close();
    await server?.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
