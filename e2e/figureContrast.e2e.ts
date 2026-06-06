// Non-text colour-contrast gate for animated figures — the SC 1.4.11 half that
// axe-core CANNOT see (standard: DESIGN.md §1, §2).
//
// WHAT axe MISSES, AND WHY THIS EXISTS: axe-core's `color-contrast` rule checks
// SC 1.4.3 (text) only, and only at page-load (one static frame). It never
// evaluates SC 1.4.11 (graphical objects — bars, segments, legend swatches,
// state fills), and it never sees a figure mid-animation. A swatch can pass at
// frame 0 and drop below 3:1 once colours change or overlap; a label can pass in
// its active state and fail when an inactive-step dim composites it down. This
// gate drives every figure through its journey and checks contrast at each
// SETTLED state — the colour analogue of the height gate (rule 16 → 17).
//
// WHICH FRAMES: the journey's HELD states (frame 0 + each step's start/end),
// NOT every fps frame. Contrast matters in the states the animation rests on
// (and that stepped narration snaps to); sampling mid-tween frames would flag
// transient fades (a node at opacity 0.1 mid-reveal) that no reader dwells on.
// This is the one place this gate deliberately diverges from figureHeight (which
// samples every driven frame, because layout DOES shift mid-tween).
//
// WHICH NODES (opt-in, per DESIGN.md §1): text is auto-sampled (≥4.5:1, or ≥3:1
// large). Graphical nodes are checked only when the author marks them
// `data-contrast="graphic"` (≥3:1) — 1.4.11 is scoped to graphics *required to
// understand the content*, so the gate needs author intent; a node (or subtree)
// marked `data-contrast="exempt"` is skipped. Coverage widens as figures adopt
// the annotation — a monotonic ratchet, low-noise from day one.
//
// CONTRAST MATH: WCAG relative luminance + the (L1+0.05)/(L2+0.05) ratio
// (DESIGN.md §1), computed from getComputedStyle by compositing the foreground
// (text `color` / graphic `background-color`|SVG `fill`) and the effective
// background (ancestor background-colors over the page), folding in cumulative
// `opacity`. This is the same quantity axe reports for text, extended to
// graphics and to every held frame.
//
// COST: cache-gated on the figure cache key (generate/figureCacheKey.ts) — the
// SAME key the video renderer and the height gate share, so only figures whose
// pixels changed re-run. The pass-record lives in the content repo's gitignored
// generated/ dir. Like the other *.e2e.ts files, excluded from the default
// `bun test`; run via `bun test ./e2e/figureContrast.e2e.ts` or `bun run test:e2e`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, startBlogServer, resolveBlogDir, type BlogServer } from "./harness.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { CAPTURE_DEFAULTS } from "../generate/capture-defaults.ts";
import { figureEnvHash, figureCacheKey } from "../generate/figureCacheKey.ts";

// Same two posts the conformance + height gates load; together they embed every
// figure that registers a journey. Keep in sync with figureHeight.e2e.ts.
const POSTS = ["offer-files", "_figjourneys"];

// SC 1.4.3 / 1.4.11 thresholds (DESIGN.md §1). A tiny epsilon below the nominal
// value absorbs sub-0.01 rounding in our luminance vs the browser's, so a colour
// computed at exactly 4.50 doesn't flake on a 4.499.
const TEXT_MIN = 4.5;
const TEXT_LARGE_MIN = 3.0;
const GRAPHIC_MIN = 3.0;
const RATIO_EPS = 0.05;

const CONTENT_ROOT = resolveBlogDir();
const RECORD_PATH = join(CONTENT_ROOT, "generated", ".figure-contrast-cache.json");
// Bump when the gate's MEASUREMENT changes (node selection, thresholds, the
// luminance/compositing math) so the whole pass-record is dropped and every
// figure re-verifies. (A figure/CSS/font change invalidates keys via the env
// hash already; this is for non-hashed measurement changes.)
const RECORD_VERSION = 1;

interface PassRecord {
  v: number;
  env: string;
  passed: string[];
}

function loadPassed(env: string): Set<string> {
  try {
    const rec = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as PassRecord;
    if (rec.v === RECORD_VERSION && rec.env === env && Array.isArray(rec.passed)) {
      return new Set(rec.passed);
    }
  } catch {
    // missing / malformed → every figure re-verifies.
  }
  return new Set();
}

function writePassed(env: string, passed: Set<string>): void {
  const rec: PassRecord = { v: RECORD_VERSION, env, passed: [...passed].sort() };
  mkdirSync(join(CONTENT_ROOT, "generated"), { recursive: true });
  writeFileSync(RECORD_PATH, JSON.stringify(rec, null, 2) + "\n");
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

// Same font-aware post open as the height gate: wait for the registry + the
// self-hosted Red Hat faces so getComputedStyle reads the metrics/colours a
// reader sees, not a fallback's.
async function openPost(page: Page, slug: string): Promise<void> {
  await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(
    () => ((window as unknown as { __presidocsFigures?: Map<string, unknown> }).__presidocsFigures?.size ?? 0) > 0,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    await fonts?.ready;
  });
}

interface Violation {
  sel: string;
  kind: "text" | "graphic";
  ratio: number;
  threshold: number;
  atMs: number;
  fg: string;
  bg: string;
  text: string;
}
interface SweepResult {
  skipped: boolean;
  checkedText?: number;
  checkedGraphic?: number;
  violations?: Violation[];
}

// Replay one figure and check contrast at its held states. Runs entirely in-page
// (getComputedStyle needs live layout). Mirrors the height gate's in-page sweep.
function sweepContrast(page: Page, id: string, texMin: number, texLargeMin: number, gfxMin: number, eps: number): Promise<SweepResult> {
  return page.evaluate(
    ({ figId, texMin, texLargeMin, gfxMin, eps }) => {
      const j = (window as any).__presidocsFigures.get(figId);
      const el = document.getElementById(figId) as HTMLElement | null;
      if (!el || !j || !(j.durationMs > 0)) return { skipped: true };

      // ── contrast math (WCAG; DESIGN.md §1) ──────────────────────────────
      type RGBA = { r: number; g: number; b: number; a: number };
      const parse = (s: string): RGBA | null => {
        const m = s && s.match(/rgba?\(([^)]+)\)/i);
        if (!m || !m[1]) return null;
        const p = m[1].split(",").map((x) => parseFloat(x.trim()));
        if (p.length < 3 || p.some((v, i) => i < 3 && Number.isNaN(v))) return null;
        return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
      };
      const over = (fg: RGBA, bg: RGBA): RGBA => {
        const a = fg.a;
        return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
      };
      const lum = (c: RGBA): number => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a: RGBA, b: RGBA): number => {
        const l1 = lum(a);
        const l2 = lum(b);
        const hi = Math.max(l1, l2);
        const lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      // Product of opacity from `node` up to the document root — what fades a
      // subtree toward whatever is behind the topmost translucent ancestor.
      const opacityFromRoot = (node: Element | null): number => {
        let o = 1;
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
          const v = parseFloat(getComputedStyle(n).opacity);
          if (!Number.isNaN(v)) o *= v;
        }
        return o;
      };
      // The opaque colour visible BEHIND `node`'s own content: composite each
      // ancestor's background-color (alpha × its opacity-from-root) over the page
      // background, outermost first. Approximate for deeply-nested opacity groups
      // but exact for the single-opacity cases figures actually use.
      const pageBg = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
      const effectiveBg = (node: Element): RGBA => {
        const chain: Element[] = [];
        for (let n: Element | null = node; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
        let result: RGBA = { ...pageBg, a: 1 };
        for (let i = chain.length - 1; i >= 0; i--) {
          const n = chain[i]!;
          const bg = parse(getComputedStyle(n).backgroundColor);
          if (bg && bg.a > 0) result = over({ ...bg, a: bg.a * opacityFromRoot(n) }, result);
        }
        return result;
      };
      const isLargeText = (cs: CSSStyleDeclaration): boolean => {
        const px = parseFloat(cs.fontSize);
        const w = parseInt(cs.fontWeight, 10) || (cs.fontWeight === "bold" ? 700 : 400);
        return px >= 24 || (px >= 18.66 && w >= 700);
      };
      const hex = (c: RGBA): string =>
        "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

      // A structural key (tag + index among same-tag siblings) so a node that
      // toggles a state class / swaps text between frames stays one identity —
      // same convention as the height gate.
      const sigOf = (node: Element): string => {
        const parts: string[] = [];
        for (let cur: Element | null = node; cur && cur !== el.parentElement; cur = cur.parentElement) {
          const sibs = cur.parentElement ? [...cur.parentElement.children] : [];
          const same = sibs.filter((s) => s.tagName === cur!.tagName);
          parts.unshift(`${cur.tagName.toLowerCase()}[${Math.max(0, same.indexOf(cur))}]`);
        }
        return parts.join("/");
      };
      const labelOf = (node: Element): string => {
        let s = node.tagName.toLowerCase();
        if ((node as HTMLElement).id) s += "#" + (node as HTMLElement).id;
        if (node.classList.length) s += "." + [...node.classList].join(".");
        return s;
      };

      // Held states only: frame 0 + each step's start & end (deduped). These are
      // where stepped narration rests and the reader reads — not mid-tween.
      const times = new Set<number>([0]);
      for (const s of j.steps ?? []) {
        times.add(Math.min(s.startMs, j.durationMs));
        times.add(Math.min(s.endMs, j.durationMs));
      }
      if (times.size <= 1) {
        // No labels — sample a few points across the duration as a fallback.
        for (let k = 0; k <= 4; k++) times.add(Math.round((k / 4) * j.durationMs));
      }
      const sortedTimes = [...times].sort((a, b) => a - b);

      // worst[sig] = the lowest ratio that node hit across the held states.
      const worst = new Map<string, Violation>();
      let checkedText = 0;
      let checkedGraphic = 0;

      // Text is only judged where it's FULLY PRESENTED (cumulative opacity near
      // 1). Below that a node is either mid-fade (transient — no reader dwells
      // there), a deliberately-dimmed inactive label (WCAG-murky de-emphasis), or
      // a disabled control (1.4.3-exempt) — auto-flagging those is noise. So the
      // text gate's value-add over axe is: text shown at full strength but in a
      // failing colour at a NON-zero animation step (which axe, frame-0 only,
      // can't see). Graphics (opt-in) are judged at any visible opacity, at their
      // rendered strength. A graphic at <0.35 is a not-yet-revealed state → skip.
      const TEXT_MIN_OPACITY = 0.9;
      const GRAPHIC_MIN_OPACITY = 0.35;

      // WCAG exempts inactive/disabled UI components (and text inside them) from
      // 1.4.3. Detect the standard markers.
      const isDisabled = (node: Element): boolean =>
        !!node.closest('[disabled], [aria-disabled="true"], :disabled');

      const evalNode = (node: Element, kind: "text" | "graphic", atMs: number): void => {
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return;
        const rect = (node as HTMLElement).getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        const cumOpacity = opacityFromRoot(node);
        if (cumOpacity < (kind === "text" ? TEXT_MIN_OPACITY : GRAPHIC_MIN_OPACITY)) return;
        if (kind === "text" && isDisabled(node)) return; // 1.4.3-exempt inactive control

        const bg = effectiveBg(node);
        let fgRaw: RGBA | null;
        if (kind === "text") {
          fgRaw = parse(cs.color);
        } else {
          // graphic: SVG shapes carry `fill`; HTML boxes carry background-color.
          const isSvg = node instanceof SVGElement && node.tagName.toLowerCase() !== "svg";
          fgRaw = parse(isSvg ? cs.fill : cs.backgroundColor);
        }
        if (!fgRaw || fgRaw.a === 0) return;
        // Fold cumulative opacity into the foreground alpha, then composite over
        // the effective background to get the colour actually rendered.
        const fg = over({ ...fgRaw, a: fgRaw.a * cumOpacity }, bg);
        const r = ratio(fg, bg);

        const threshold = kind === "graphic" ? gfxMin : isLargeText(cs) ? texLargeMin : texMin;
        if (kind === "text") checkedText++;
        else checkedGraphic++;
        if (r >= threshold - eps) return;

        const sig = sigOf(node);
        const prev = worst.get(sig);
        if (!prev || r < prev.ratio) {
          worst.set(sig, {
            sel: labelOf(node),
            kind,
            ratio: Math.round(r * 100) / 100,
            threshold,
            atMs: Math.round(atMs),
            fg: hex(fg),
            bg: hex(bg),
            text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
          });
        }
      };

      const inExempt = (node: Element): boolean => !!node.closest('[data-contrast="exempt"]');
      const hasOwnText = (node: Element): boolean =>
        [...node.childNodes].some((c) => c.nodeType === 3 && (c.textContent || "").trim().length > 0);

      j.reset();
      for (const t of sortedTimes) {
        j.seek(t);
        // Auto-sampled text: every element with its own non-empty text run.
        for (const node of el.querySelectorAll("*")) {
          if (inExempt(node)) continue;
          if (hasOwnText(node)) evalNode(node, "text", t);
        }
        // Opt-in graphics.
        for (const node of el.querySelectorAll('[data-contrast="graphic"]')) {
          if (inExempt(node)) continue;
          evalNode(node, "graphic", t);
        }
      }
      // restore to frame 0 so the page looks untouched after the sweep
      j.reset();

      return { skipped: false, checkedText, checkedGraphic, violations: [...worst.values()] };
    },
    { figId: id, texMin, texLargeMin, gfxMin, eps },
  );
}

test("every figure meets WCAG contrast at each held state (text 1.4.3, graphic 1.4.11)", async () => {
  const env = await figureEnvHash({ contentRoot: CONTENT_ROOT, engineRoot: resolveBlogPaths().engineRoot });
  const passed = loadPassed(env);

  const page = await browser.newPage({
    viewport: { width: CAPTURE_DEFAULTS.viewportW, height: CAPTURE_DEFAULTS.viewportH },
  });

  const violations: string[] = [];
  const seen = new Set<string>();
  let cached = 0;
  let checked = 0;
  let totalText = 0;
  let totalGraphic = 0;

  try {
    for (const slug of POSTS) {
      const html = readFileSync(join(CONTENT_ROOT, "posts", `${slug}.html`), "utf8");
      await openPost(page, slug);

      const ids: string[] = await page.evaluate(() => [
        ...(window as unknown as { __presidocsFigures: Map<string, unknown> }).__presidocsFigures.keys(),
      ]);
      expect(ids.length, `${slug}: at least one figure registers a journey`).toBeGreaterThan(0);

      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);

        const key = figureCacheKey(env, id, html);
        if (passed.has(key)) {
          cached++;
          continue;
        }

        const r = await sweepContrast(page, id, TEXT_MIN, TEXT_LARGE_MIN, GRAPHIC_MIN, RATIO_EPS);
        if (r.skipped) continue;
        checked++;
        totalText += r.checkedText ?? 0;
        totalGraphic += r.checkedGraphic ?? 0;

        if (r.violations && r.violations.length > 0) {
          const lines = r.violations
            .map(
              (v) =>
                `      • [${v.kind}] ${v.sel}: ${v.ratio}:1 (need ${v.threshold}:1) ` +
                `fg ${v.fg} on ${v.bg} @${v.atMs}ms` +
                (v.text ? ` — “${v.text}”` : ""),
            )
            .join("\n");
          violations.push(`  ✗ ${id} [${slug}]:\n${lines}`);
        } else {
          // Bank the pass so an unchanged figure skips next run.
          passed.add(key);
        }
      }
    }
  } finally {
    await page.close();
  }

  // Persist passes BEFORE asserting, so a failing run still banks the clean ones.
  writePassed(env, passed);
  console.log(
    `figure-contrast: ${cached} cached, ${checked} checked ` +
      `(${totalText} text + ${totalGraphic} graphic node-samples), ${violations.length} figure(s) with violations`,
  );

  expect(
    violations.length,
    violations.length
      ? `Figures whose colour contrast falls below WCAG at a held state ` +
          `(text SC 1.4.3 ≥4.5:1/3:1-large; graphic SC 1.4.11 ≥3:1 — graphics opt in via data-contrast="graphic"):\n` +
          violations.join("\n\n")
      : "",
  ).toBe(0);
}, 180_000);
