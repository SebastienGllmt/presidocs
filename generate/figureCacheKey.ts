// The content-addressed cache key for a captured figure — the ONE source of
// truth shared by the two consumers that must agree on it:
//
//   - generate/render-video.ts — skips re-capturing (and re-encoding) a figure
//     whose key already has a `.video-cache/fig-<key>.{mp4,png}` on disk.
//   - e2e/figureHeight.e2e.ts — skips re-running the height-invariance check on
//     a figure whose key already passed, so the regression suite stays cheap as
//     posts/figures accumulate.
//
// Keeping the formula here (not duplicated in each consumer) means a change to
// what can alter a figure's rendered pixels invalidates BOTH caches in lockstep:
// the video re-renders and the height test re-runs, never one without the other.
//
// The key folds in every input that can change a figure's pixels: capture
// params, the GSAP version, ALL figure source (a shared util/CSS edit can move
// any figure), the FigureJourney runtime, the capture code, and the figure's
// own `<figure>` subtree. Conservative on purpose — a figure-code edit busts
// every figure's key; that's cheap insurance against a false hit shipping a
// stale video or skipping a now-broken figure.

import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { CAPTURE_DEFAULTS } from "./capture-defaults.ts";

// Bump to invalidate every figure cache entry at once — the video clips AND the
// height test's pass-record — e.g. after an ffmpeg upgrade you want re-encoded,
// or a capture-param change not otherwise fingerprinted below. (Also stamped
// into render-video.ts's separate whole-video cache key, which imports this.)
export const CACHE_VERSION = "v8"; // v8: blog switched to self-hosted Red Hat Text/Mono web fonts

export function hashStr(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export async function hashFile(p: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(p).arrayBuffer())).digest("hex").slice(0, 16);
}

// The roots figureEnvHash fingerprints. A subset of shared/blogPaths.ts's
// `BlogPaths`, so a caller can pass `resolveBlogPaths()` straight through.
export interface FigureCacheRoots {
  readonly contentRoot: string;
  readonly engineRoot: string;
}

/**
 * The environment fingerprint common to every figure in a run: capture params,
 * the GSAP version, all figure source, the FigureJourney runtime, the capture
 * code, the engine stylesheets that style figures (base.css — font tokens,
 * @font-face, column width; narrator.css — the figure box rule), and the
 * self-hosted font binaries. Hashed once per run; combined with each
 * figure's subtree to key its capture. Conservative on purpose — any of these
 * changing busts every figure's cache (safe; such edits are rare vs prose).
 */
export async function figureEnvHash(paths: FigureCacheRoots): Promise<string> {
  const parts: string[] = [CACHE_VERSION, JSON.stringify(CAPTURE_DEFAULTS)];
  for (const base of [paths.contentRoot, paths.engineRoot]) {
    try {
      parts.push("gsap:" + ((await Bun.file(join(base, "node_modules/gsap/package.json")).json()) as { version: string }).version);
      break;
    } catch {}
  }
  const figuresDir = join(paths.contentRoot, "figures");
  try {
    for (const f of (await readdir(figuresDir, { recursive: true })).sort()) {
      try {
        parts.push(`${f}:${await hashFile(join(figuresDir, f))}`); // a dir entry throws on read → skipped
      } catch {}
    }
  } catch {}
  try {
    parts.push("figureAnimation:" + (await hashFile(join(paths.engineRoot, "client", "figureAnimation.ts"))));
  } catch {}
  // The capture code itself determines the pixels (e.g. which page chrome it
  // hides), so a change to it must invalidate cached captures.
  try {
    parts.push("captureFigures:" + (await hashFile(join(paths.engineRoot, "generate", "capture-figures.ts"))));
  } catch {}
  // The engine stylesheets that style figures and their page context, even
  // though they live outside figures/:
  //   - base.css     — the font tokens (`--font-sans`/`--font-mono`), @font-face
  //                    rules, the design tokens, and the article column width.
  //   - narrator.css — the base `figure { padding/border/margin }` box rule (and
  //                    the article padding the player dock reserves), which set a
  //                    figure's box and inner width → its measured height.
  // A change to either alters a captured figure's pixels; hashing them keeps the
  // video + height-test caches from going stale on a font/figure-box edit.
  for (const css of ["base.css", "narrator.css"]) {
    try {
      parts.push(`${css}:${await hashFile(join(paths.engineRoot, "client", css))}`);
    } catch {}
  }
  // The self-hosted font binaries: swapping a woff2's bytes shifts glyph metrics
  // (and therefore line wrapping → height) without touching any .css.
  const fontsDir = join(paths.engineRoot, "client", "fonts");
  try {
    for (const f of (await readdir(fontsDir)).sort()) {
      if (!f.endsWith(".woff2")) continue;
      try {
        parts.push(`font:${f}:${await hashFile(join(fontsDir, f))}`);
      } catch {}
    }
  } catch {}
  return hashStr(parts.join("\n"));
}

/** A figure's own markup (the static SVG the enhancer animates + any inline
 *  data it reads). Figures never nest, so a non-greedy match to the first
 *  `</figure>` is exact; on no match, fall back to the whole doc (a false miss
 *  is safe, a false hit is not). */
export function figureSubtree(html: string, id: string): string {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`<figure\\b[^>]*\\bid=["']${esc}["'][\\s\\S]*?</figure>`, "i"));
  return m ? m[0] : html;
}

/**
 * A figure's full cache key: the run-wide env hash ⊕ the figure id ⊕ its
 * `<figure>` subtree. Identical to the key render-video.ts writes its
 * `.video-cache/fig-<key>.*` under, so a height-test gate keyed on this is in
 * lockstep with the video cache.
 */
export function figureCacheKey(env: string, id: string, html: string): string {
  return hashStr(`${env}\n${id}\n${figureSubtree(html, id)}`);
}
