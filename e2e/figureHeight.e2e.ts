// Height-invariance regression gate for animated figures.
//
// THE BUG IT CATCHES: a figure's box height must stay constant across its whole
// animation. A figure floats in the article flow, so if its `<figure>` grows or
// shrinks mid-animation (a caption wrapping to a second line, a readout field
// changing line-height, a note block reflowing), every paragraph below it jumps
// — a visible content shift as narration drives the figure. The FigureJourney
// conformance gate (figureJourney.e2e.ts) proves a figure is deterministic and
// seekable; it says nothing about whether its LAYOUT stays put. This file does.
//
// HOW: load the same two posts the conformance gate loads — between them
// offer-files + the `_figjourneys` fixture embed every figure that registers a
// journey — enumerate the registry, and for each figure replay its journey the
// exact way generate/capture-figures.ts does (reset() then forward seek() at the
// capture fps). At every frame we read `el.offsetHeight` — the LAYOUT height,
// which ignores CSS transforms, so figures whose inner pieces only translate/
// scale stay flat and only a real reflow trips the check.
//
// WHICH FRAMES COUNT: we judge the DRIVEN frames (1..n), not frame 0. A staged
// figure holds frame 1 until a driving event advances it (methodology → "Live
// figure driving"), so the narrator never rests on frame 0 — the only thing
// that displays frame 0's layout is the static pre-narration render. A height
// that is flat across the driven frames but differs ONLY at frame 0 is a
// one-time settle when narration first claims the figure, not a per-step
// content shift; we report it as a non-failing warning. The hard failure is
// SUSTAINED variation — the figure settling at different heights across the
// frames narration actually steps through. Each failure reports WHEN (the
// shortest/tallest driven frames) and WHY (a per-descendant offsetHeight diff
// between those two frames, keyed STRUCTURALLY — tag + position, never class —
// so a figure toggling a state class mid-step doesn't blind the diff).
//
// COST: gated on the figure cache key (generate/figureCacheKey.ts) — the SAME
// key the video renderer caches captures under. A figure whose key already
// passed is skipped; only figures whose source/markup/capture-env changed re-run.
// The pass-record lives in the content repo's gitignored generated/ dir, so the
// suite stays cheap as posts and figures accumulate.
//
// Like the other *.e2e.ts files this is excluded from the default `bun test`
// glob; run it explicitly: `bun test ./e2e/figureHeight.e2e.ts` (or via
// `bun run test:e2e`, which loops one process per file).

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, startBlogServer, resolveBlogDir, type BlogServer } from "./harness.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { CAPTURE_DEFAULTS } from "../generate/capture-defaults.ts";
import { figureEnvHash, figureCacheKey } from "../generate/figureCacheKey.ts";

// Same two posts the conformance gate uses; together they embed every figure
// that registers a journey (offer-files carries the in-use ones; `_figjourneys`
// the two no published post embeds). Keep in sync with figureJourney.e2e.ts.
const POSTS = ["offer-files", "_figjourneys"];

// A layout shift below ~1px doesn't visibly move content, and offsetHeight is an
// integer so transform-only animations report a flat height. 0.5 means "any
// whole-pixel change fails" while staying immune to sub-pixel noise.
const HEIGHT_TOLERANCE_PX = 0.5;

// Figures render the blog's self-hosted web font (Red Hat Text / Red Hat Mono,
// base.css @font-face → `var(--font-sans)`/`var(--font-mono)`), which loads in
// headless too — so the gate measures exactly the wrapping every reader and the
// rendered video get. openPost waits `document.fonts.ready` so the font is in
// before we measure. (No font pin anymore — the blog font is now deterministic.)

// The gitignored pass-record: figure cache keys that have already passed. Lives
// next to the video cache's generated/ tree (also gitignored) so it travels with
// the content, not the engine. Stamped with the env hash — when the capture env
// changes, every key changes, so we drop the whole record and re-verify.
const CONTENT_ROOT = resolveBlogDir();
const RECORD_PATH = join(CONTENT_ROOT, "generated", ".figure-height-cache.json");
// Bump when the test's measurement changes (semantics, tolerance) so the whole
// pass-record is dropped and every figure re-verifies. v2: driven-frame
// baseline. (A figure/font/capture change invalidates keys via the env hash —
// incl. the CACHE_VERSION bump for the Red Hat font migration — so the record
// auto-drops then; this version is just for non-hashed measurement changes.)
const RECORD_VERSION = 2;

interface PassRecord {
  v: number;
  env: string;
  passed: string[];
}

function loadPassed(env: string): Set<string> {
  try {
    const rec = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as PassRecord;
    // A stale env means none of the old keys can match (env is folded into every
    // key) — start clean so the file doesn't accrete dead keys forever.
    if (rec.v === RECORD_VERSION && rec.env === env && Array.isArray(rec.passed)) {
      return new Set(rec.passed);
    }
  } catch {
    // missing / malformed → treat as empty; every figure re-verifies.
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

async function openPost(page: Page, slug: string): Promise<void> {
  await page.goto(`${server.baseURL}/posts/${slug}`, { waitUntil: "load", timeout: 30_000 });
  // Figures register their journey on module init; wait until at least one is in.
  await page.waitForFunction(
    () => ((window as unknown as { __presidocsFigures?: Map<string, unknown> }).__presidocsFigures?.size ?? 0) > 0,
    { timeout: 10_000 },
  );
  // Some figures register asynchronously (e.g. hashAvalanche after two SHA-256s);
  // give them a beat so the registry is complete before we enumerate it.
  await page.waitForTimeout(600);
  // Wait for the self-hosted web fonts (Red Hat Text/Mono) to load before
  // measuring. They're `font-display: swap` (base.css), so the fallback paints
  // first and swaps late — measuring before the swap would capture the wider
  // fallback's metrics and flag wraps no reader sees. Explicitly load the
  // weights the figures use, then await the whole set.
  await page.evaluate(async () => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.load) {
      await Promise.all([
        fonts.load('400 1em "Red Hat Text"'),
        fonts.load('500 1em "Red Hat Text"'),
        fonts.load('600 1em "Red Hat Text"'),
        fonts.load('700 1em "Red Hat Text"'),
        fonts.load('400 1em "Red Hat Mono"'),
      ]).catch(() => {});
    }
    await fonts?.ready;
  });
  // Fail loudly if Red Hat never loaded (e.g. the dev server didn't serve
  // client/fonts/*.woff2): silently measuring the fallback's metrics is exactly
  // the bug this guard prevents — the whole point of standardizing on a web font
  // is that the test and a reader see identical line wrapping.
  // `document.fonts.check()` is too weak here: it returns true when the family
  // is simply UNDEFINED (no @font-face at all → "zero faces, all loaded"), so it
  // wouldn't catch a post that forgot to link base.css. Assert a Red Hat face is
  // actually present AND loaded in the FontFaceSet instead.
  const fontLoaded = await page.evaluate(() =>
    [...document.fonts].some(
      (f) => f.family.replace(/['"]/g, "").includes("Red Hat Text") && f.status === "loaded",
    ),
  );
  if (!fontLoaded) {
    throw new Error(
      `${slug}: no loaded "Red Hat Text" face in document.fonts — the post didn't load base.css / the ` +
        `woff2s, so height measurements would use a fallback font's (wider) metrics and flag wraps no ` +
        `reader sees. Link engine/client/base.css and ensure the dev server serves client/fonts/*.woff2.`,
    );
  }
}

// What a single figure's height sweep reports back. `kind` classifies it:
//   ok          — flat across the driven frames AND frame 0 (no shift anywhere)
//   frame0-only — flat across the driven frames; only frame 0 differs (a one-
//                 time settle the narrator skips — a warning, not a failure)
//   sustained   — varies across the driven frames (the real per-step shift);
//                 carries the WHEN (shortest/tallest driven frames) + WHY
//                 (culprit descendants) debug payload.
interface Culprit {
  sel: string;
  from: number;
  to: number;
  delta: number;
  text: string;
}
type SweepKind = "ok" | "frame0-only" | "sustained";
interface SweepResult {
  skipped: boolean;
  kind?: SweepKind;
  drivenMin?: number;
  drivenMax?: number;
  drivenDelta?: number;
  drivenMinMs?: number;
  drivenMaxMs?: number;
  frame0?: number;
  frame0Delta?: number;
  culprits?: Culprit[];
  nodeDelta?: number; // descendant-count change between the two compared frames
}

// Replay one figure's journey and classify its layout-height stability. Runs
// entirely in-page (offsetHeight needs real layout) and mirrors the capture
// loop: reset() to claim the figure (rule 7 stands its self-play down), then
// forward seek() at the capture fps across [0, durationMs] inclusive. We compare
// the DRIVEN frames (1..n); frame 0 is reported separately (the narrator never
// rests on it).
function sweepFigure(page: Page, id: string, fps: number, tol: number): Promise<SweepResult> {
  return page.evaluate(
    ({ figId, fps, tol }) => {
      const j = (window as any).__presidocsFigures.get(figId);
      const el = document.getElementById(figId) as HTMLElement | null;
      if (!el || !j || !(j.durationMs > 0)) return { skipped: true };
      const step = 1000 / fps;
      const n = Math.max(1, Math.ceil(j.durationMs / step));

      // Pass 1 (cheap): figure offsetHeight at every captured frame.
      j.reset();
      const ms: number[] = [];
      const H: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = Math.min(i * step, j.durationMs);
        j.seek(t);
        ms.push(t);
        H.push(el.offsetHeight);
      }
      const frame0 = H[0]!;
      const frame1 = H[1]!;
      // Extremes across the DRIVEN frames (i = 1..n) — what narration can rest on.
      let lo = 1;
      let hi = 1;
      for (let i = 1; i < H.length; i++) {
        if (H[i]! < H[lo]!) lo = i;
        if (H[i]! > H[hi]!) hi = i;
      }
      const drivenDelta = H[hi]! - H[lo]!;
      const base = {
        drivenMin: H[lo]!,
        drivenMax: H[hi]!,
        drivenDelta,
        drivenMinMs: Math.round(ms[lo]!),
        drivenMaxMs: Math.round(ms[hi]!),
        frame0,
        frame0Delta: Math.abs(frame0 - frame1),
      };
      if (drivenDelta <= tol) {
        return { skipped: false, kind: base.frame0Delta > tol ? "frame0-only" : "ok", ...base };
      }

      // Pass 2 (sustained only): diff per-descendant offsetHeight between the
      // SHORTEST and TALLEST driven frames to name what reflowed. The key is
      // STRUCTURAL (tag + index among same-tag siblings) — never class or text —
      // so a figure toggling a state class on an ancestor (is-private, nf-heavy)
      // or swapping a node's text at the same step can't desync the snapshots.
      const sigOf = (node: Element): string => {
        const parts: string[] = [];
        for (let cur: Element | null = node; cur && cur !== el.parentElement; cur = cur.parentElement) {
          const sibs = cur.parentElement ? [...cur.parentElement.children] : [];
          const same = sibs.filter((s) => s.tagName === cur.tagName);
          parts.unshift(`${cur.tagName.toLowerCase()}[${Math.max(0, same.indexOf(cur))}]`);
        }
        return parts.join("/");
      };
      const labelOf = (node: Element): string => {
        let s = node.tagName.toLowerCase();
        if (node.id) s += "#" + node.id;
        if (node.classList.length) s += "." + [...node.classList].join(".");
        return s;
      };
      const snapshot = (t: number) => {
        j.reset();
        for (let p = step; p < t; p += step) j.seek(p);
        j.seek(t);
        const m = new Map<string, { h: number; label: string; text: string }>();
        for (const node of el.querySelectorAll("*")) {
          m.set(sigOf(node), {
            h: (node as HTMLElement).offsetHeight,
            label: labelOf(node),
            text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48),
          });
        }
        return m;
      };
      const shorter = snapshot(ms[lo]!);
      const taller = snapshot(ms[hi]!);
      const culprits: Culprit[] = [];
      for (const [sig, a] of taller) {
        const b = shorter.get(sig);
        if (!b) continue;
        if (Math.abs(a.h - b.h) > tol) {
          culprits.push({ sel: a.label, from: b.h, to: a.h, delta: a.h - b.h, text: a.text });
        }
      }
      culprits.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

      return { skipped: false, kind: "sustained", ...base, culprits: culprits.slice(0, 5), nodeDelta: taller.size - shorter.size };
    },
    { figId: id, fps, tol },
  );
}

test("every animated figure keeps a constant height across its driven journey", async () => {
  const env = await figureEnvHash({ contentRoot: CONTENT_ROOT, engineRoot: resolveBlogPaths().engineRoot });
  const passed = loadPassed(env);

  const page = await browser.newPage({
    viewport: { width: CAPTURE_DEFAULTS.viewportW, height: CAPTURE_DEFAULTS.viewportH },
  });

  const violations: string[] = []; // sustained — hard failures
  const warnings: string[] = []; // frame-0-only — reported, not failed
  const seen = new Set<string>(); // figure ids handled (a figure lives in one post)
  let cached = 0;
  let checked = 0;

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

        // Cache gate: the figure's video-cache key. Unchanged figure ⇒ skip.
        const key = figureCacheKey(env, id, html);
        if (passed.has(key)) {
          cached++;
          continue;
        }

        const r = await sweepFigure(page, id, CAPTURE_DEFAULTS.fps, HEIGHT_TOLERANCE_PX);
        if (r.skipped) continue; // no journey / not in DOM — nothing to measure
        checked++;

        if (r.kind === "sustained") {
          // A real per-step shift. Build When + Why and collect it (soft-fail, so
          // one run surfaces ALL offending figures, not just the first).
          const why = (r.culprits ?? []).length
            ? r.culprits!
                .map(
                  (c) =>
                    `      • ${c.sel}: ${c.from}→${c.to}px (Δ${c.delta >= 0 ? "+" : ""}${c.delta}px)` +
                    (c.text ? ` — “${c.text}”` : ""),
                )
                .join("\n")
            : `      (no single descendant changed by >${HEIGHT_TOLERANCE_PX}px` +
              (r.nodeDelta ? `; ${Math.abs(r.nodeDelta)} node(s) ${r.nodeDelta > 0 ? "added" : "removed"}` : "") +
              ` — likely the figure box / a gap / text wrapping reflowed)`;
          violations.push(
            `  ✗ ${id} [${slug}]: driven height ${r.drivenMin}→${r.drivenMax}px (Δ${r.drivenDelta}px)\n` +
              `      shortest ${r.drivenMin}px @${r.drivenMinMs}ms, tallest ${r.drivenMax}px @${r.drivenMaxMs}ms.` +
              ` Reflowed element(s):\n` +
              why,
          );
          continue;
        }

        // ok or frame0-only → not a per-step shift; bank the pass so it skips
        // next run. frame0-only still gets surfaced as a non-failing warning.
        passed.add(key);
        if (r.kind === "frame0-only") {
          warnings.push(
            `  · ${id} [${slug}]: driven height flat at ${r.drivenMin}px, but the static frame 0 is ${r.frame0}px` +
              ` (Δ${r.frame0Delta}px) — a one-time settle when narration first claims it. Reserve space if you` +
              ` want frame 0 to match too.`,
          );
        }
      }
    }
  } finally {
    await page.close();
  }

  // Persist passes BEFORE asserting, so a failing run still banks the figures
  // that are fine — next run re-checks only the violators.
  writePassed(env, passed);
  if (warnings.length) {
    console.log(`figure-height — frame-0-only (not failing):\n${warnings.join("\n")}`);
  }
  console.log(
    `figure-height: ${cached} cached, ${checked} checked, ` +
      `${violations.length} violation(s), ${warnings.length} warning(s) (${passed.size} keys recorded)`,
  );

  expect(
    violations.length,
    violations.length
      ? `Figures whose height changes across the driven journey (content below them shifts as narration steps through them):\n` +
          violations.join("\n\n")
      : "",
  ).toBe(0);
}, 180_000);
