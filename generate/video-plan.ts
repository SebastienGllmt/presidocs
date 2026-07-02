// Render-plan building for the video export: load the manifest, render the
// satori plate files, resolve/cache figure captures, derive holds, and project
// everything into VIDEO-second layers consumed by either render path.
// See methodology.md → "Video export".

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { renderElementToPng } from "./share-card.ts";
import { figureEnvHash, figureCacheKey } from "./figureCacheKey.ts";
import { timed, W, H, SLIDE_HOLD_SEC, SLIDE_FADE_SEC } from "./video-constants.ts";
import { buildKaraokeAss, DEFAULT_KARAOKE_STYLE } from "./video-captions.ts";
import { deriveFigureOccurrences, type FigureOccur } from "./video-timeline.ts";
import { loadPostCtx, bgPlate, introPlate, slidePlate, type PostCtx } from "./video-plates.ts";
import type { Manifest, ManifestChapter as Chapter } from "../shared/manifestSchema.ts";

const paths = resolveBlogPaths();

type FigureShot = import("./capture-figures.ts").FigureShot;
type CapturedStep = import("./capture-figures.ts").CapturedStep;

// --- manifest loading --------------------------------------------------------

export async function findManifest(slug: string): Promise<{ manifest: Manifest; dir: string }> {
  const dir = join(paths.generatedDir, slug);
  if (!existsSync(dir)) throw new Error(`No generated dir for "${slug}" at ${dir}`);
  const entries = await readdir(dir);
  const name =
    entries.find((f) => /^manifest\.[0-9a-f]{16}\.json$/.test(f)) ??
    (entries.includes("manifest.json") ? "manifest.json" : undefined);
  if (!name) throw new Error(`No manifest in ${dir}`);
  const manifest = (await Bun.file(join(dir, name)).json()) as Manifest;
  return { manifest, dir };
}

// =============================================================================
// Render plan (video-time) — built once, consumed by either render path
// =============================================================================
//
// Two render paths share one plan:
//   - single-pass (teaser): one ffmpeg filtergraph for the whole span. Cheap
//     when the span is short (few inputs); the original v1 path.
//   - layered (full length): the discrete visual layers are segmented per
//     chapter and concatenated, then ONE final pass adds the continuous layers
//     (audio + waveform + captions). See methodology.md → "Video export". The reason the single
//     graph does not scale is input-count × duration: a 40-min post opens ~83
//     image inputs that all keep decoding for the whole run (an `enable` gate
//     skips compositing, not decode). Segmenting means each small graph opens
//     only the handful of inputs intersecting its chapter.

// Every visual placement is expressed in VIDEO seconds (post-hold), so both
// paths and the segmenter share one timeline. A figure also carries its clip
// mode + length, which decides how it is fed/looped into a segment.
export type VisualLayer =
  | { kind: "bg"; file: string; vStart: number; vEnd: number }
  | { kind: "slide"; file: string; vStart: number; vEnd: number }
  | {
      kind: "figure";
      file: string;
      vStart: number;
      vEnd: number;
      mode: "still" | "loop" | "once";
      clipSec: number;
    };

export type Hold = { posMs: number; durMs: number };

export type Plan = {
  slug: string;
  dir: string;
  t0: number;
  t1: number;
  spanSec: number; // trimmed audio length (t1-t0)
  videoTotalSec: number; // spanSec + Σ holds
  audioAbs: string;
  assPath: string;
  fontsDir: string;
  layers: VisualLayer[]; // draw order: backgrounds → figures → slides
  slideWindows: { vStart: number; vEnd: number }[]; // for segment cut placement
  holds: Hold[];
  chapterCount: number;
};

// --- figure capture cache ----------------------------------------------------

/**
 * Resolve every figure to a still/clip, hitting `.video-cache/fig-<key>.*` first
 * and only booting a browser for cache misses (skipping it entirely when all
 * hit). Captures are deterministic (methodology.md → "Animated figures" → "The FigureJourney contract"), so a hit is byte-faithful.
 */
async function resolveFigureShots(
  slug: string,
  ids: readonly string[],
  platesDir: string,
  cacheDir: string,
  html: string,
): Promise<Map<string, FigureShot>> {
  const out = new Map<string, FigureShot>();
  await mkdir(cacheDir, { recursive: true });
  const env = await figureEnvHash(paths);
  const keyById = new Map<string, string>();
  const misses: string[] = [];

  for (const id of ids) {
    const key = figureCacheKey(env, id, html);
    keyById.set(id, key);
    const metaPath = join(cacheDir, `fig-${key}.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = (await Bun.file(metaPath).json()) as { kind: "clip" | "still"; ext: string; durationMs?: number; fps?: number; steps?: CapturedStep[] };
        const file = join(cacheDir, `fig-${key}.${meta.ext}`);
        if (existsSync(file)) {
          out.set(id, meta.kind === "clip" ? { kind: "clip", file, durationMs: meta.durationMs!, fps: meta.fps!, steps: meta.steps ?? [] } : { kind: "still", file });
          continue;
        }
      } catch {}
    }
    misses.push(id);
  }
  console.log(
    `render-video: figures — ${ids.length - misses.length}/${ids.length} cached` +
      (misses.length ? `, capturing: ${misses.join(", ")}` : " (no browser needed)"),
  );

  if (misses.length > 0) {
    const { captureFigures } = await import("./capture-figures.ts");
    for (const [id, shot] of await captureFigures(paths.contentRoot, slug, misses, platesDir)) {
      const key = keyById.get(id)!;
      const ext = shot.kind === "clip" ? "mp4" : "png";
      const cfile = join(cacheDir, `fig-${key}.${ext}`);
      await Bun.write(cfile, Bun.file(shot.file));
      await Bun.write(
        join(cacheDir, `fig-${key}.json`),
        JSON.stringify(shot.kind === "clip" ? { kind: "clip", ext, durationMs: shot.durationMs, fps: shot.fps, steps: shot.steps } : { kind: "still", ext }),
      );
      // Point the plan at the cache copy (stable across runs).
      out.set(id, shot.kind === "clip" ? { kind: "clip", file: cfile, durationMs: shot.durationMs, fps: shot.fps, steps: shot.steps } : { kind: "still", file: cfile });
    }
  }
  return out;
}

// --- per-step held frames (methodology.md → "Video export") --------------------------------------

/**
 * The clip frame index that holds a figure at journey position `posMs`. The clip
 * is captured at `fps` with frames i=0..n where t=min(i/fps·1000, durationMs) and
 * n=ceil(durationMs/1000·fps), so the frame showing `posMs` is round(posMs/1000·fps),
 * clamped to [0,n]. A step's `endMs===durationMs` (the last label) maps to the
 * clip's final frame. Pure + unit-tested.
 */
export function heldFrameIndex(posMs: number, fps: number, durationMs: number): number {
  const last = Math.max(1, Math.ceil((durationMs / 1000) * fps));
  return Math.min(last, Math.max(0, Math.round((posMs / 1000) * fps)));
}

/**
 * Extract the single still PNG that holds a captured clip at journey position
 * `posMs` — the frame a `step` cue rests on (methodology.md → "Video export"). One frame, cheap.
 * Throws on ffmpeg failure; the caller (`heldFrameFor`) catches it and degrades
 * the span to the free-running clip rather than aborting the whole render.
 */
export async function extractHeldFrame(
  clip: { file: string; fps: number; durationMs: number },
  posMs: number,
  outFile: string,
): Promise<void> {
  const idx = heldFrameIndex(posMs, clip.fps, clip.durationMs);
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", clip.file, "-vf", `select=eq(n\\,${idx})`, "-frames:v", "1", outFile],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`held-frame extraction failed for ${clip.file} @${posMs}ms (frame ${idx})`);
  }
}

// --- plate rendering (carved from buildPlan) ---------------------------------

type TimedPlate = { file: string; startMs: number; endMs: number };

// Render the per-chapter background + intro/divider slide PNGs. On-screen times
// here are audio-relative (rebased to t0); buildPlan maps them into VIDEO time
// once holds are known.
async function buildPlates(
  active: Chapter[],
  ctx: PostCtx,
  chapterById: Map<string, Chapter>,
  t0: number,
  t1: number,
  platesDir: string,
): Promise<{ bgPlates: TimedPlate[]; slidePlates: TimedPlate[] }> {
  const bgPlates: TimedPlate[] = [];
  const slidePlates: TimedPlate[] = [];
  let introUsed = false;
  for (let ci = 0; ci < active.length; ci++) {
    const ch = active[ci]!;
    const parentTitle = ch.parentId ? chapterById.get(ch.parentId)?.title ?? null : null;
    const bgFile = join(platesDir, `bg-${ch.id}.png`);
    await Bun.write(bgFile, await renderElementToPng(bgPlate(ctx, ch, parentTitle), W, H));
    // Backgrounds are contiguous: a chapter's chrome stays up until the NEXT
    // chapter begins (not until its own audio ends), so the inter-chapter
    // silence doesn't flash the bare background.
    const bgStart = Math.max(ch.startTime, t0) - t0;
    const bgEnd = Math.min((active[ci + 1]?.startTime ?? t1) - t0, t1 - t0);
    bgPlates.push({ file: bgFile, startMs: bgStart, endMs: bgEnd });

    // Slide only when the chapter actually starts inside the span. The FIRST is
    // the author intro; every later chapter break is the stripped-down divider.
    // The slide fades IN over the *previous* chapter's content and reaches full
    // opacity exactly at the boundary — where the bg switches, so the cut is
    // hidden — then dissolves into this chapter's content.
    if (ch.startTime >= t0) {
      const isIntro = !introUsed;
      introUsed = true;
      const el = isIntro ? introPlate(ctx, ch) : slidePlate(ctx, ch, parentTitle);
      const slideFile = join(platesDir, `slide-${ch.id}.png`);
      await Bun.write(slideFile, await renderElementToPng(el, W, H));
      const cs = ch.startTime - t0;
      slidePlates.push({
        file: slideFile,
        startMs: Math.max(0, cs - SLIDE_FADE_SEC * 1000),
        endMs: cs + SLIDE_HOLD_SEC * 1000 + SLIDE_FADE_SEC * 1000,
      });
    }
  }
  return { bgPlates, slidePlates };
}

// --- figure mode + holds (carved from buildPlan) -----------------------------

type FigurePlan = { file: string; startMs: number; mode: "still" | "loop" | "once"; spanMs: number; clipMs: number };

// Decide per-figure mode; insert a narration hold when an animation outlasts its
// discussion span (CP2b: pause the narration to let it finish). Stepped clips
// decompose into a free-run prefix + one held still per step cue.
async function planFigures(
  occurs: FigureOccur[],
  shots: Map<string, FigureShot>,
  platesDir: string,
): Promise<{ figurePlans: FigurePlan[]; holds: Hold[] }> {
  const holds: Hold[] = [];
  type ClipShot = Extract<FigureShot, { kind: "clip" }>;
  const figurePlans: FigurePlan[] = [];
  // Held-frame PNGs extracted from a clip for `step` cues, deduped per (id,label)
  // within this render (the extraction is cheap; the dedup avoids redundant runs
  // when a label is held across more than one occurrence).
  const heldFrames = new Map<string, string>();
  const heldFrameFor = async (id: string, clip: ClipShot, label: string): Promise<string | null> => {
    const cacheKey = `${id}:${label}`;
    const existing = heldFrames.get(cacheKey);
    if (existing) return existing;
    const step = clip.steps.find((s) => s.label === label);
    if (!step) {
      // Author typo / renamed label: warn + hold the clip's last frame, mirroring
      // the page's warn-and-hold (methodology.md → "Live figure driving") — never drop the figure.
      console.warn(`render-video: figure "${id}" has no step "${label}" — holding its last frame`);
    }
    const file = join(platesDir, `held-${id}-${label}.png`);
    try {
      await extractHeldFrame(clip, step ? step.endMs : clip.durationMs, file);
    } catch (e) {
      // Fail-soft (invariant: a figure issue degrades to showing the clip, never a
      // render abort). Returning null tells the caller to free-run the clip here.
      console.warn(`render-video: held-frame extraction failed for "${id}" step "${label}", free-running the clip: ${(e as Error).message.split("\n")[0]}`);
      return null;
    }
    heldFrames.set(cacheKey, file);
    return file;
  };

  for (const o of occurs) {
    const shot = shots.get(o.id);
    if (!shot) continue;
    const spanMs = o.visEndMs - o.startMs;
    // Per-step (slideshow) driving (methodology.md → "Video export"): a clip with `step` cues plays
    // its `null` (lead-up) spans as a free-run loop and HOLDS a still at
    // steps[label].endMs over each labeled span — matching the page's stepped
    // driver, which snaps-and-holds (methodology.md → "Live figure driving"). Stepped spans add no narration
    // holds (a held frame has nothing to finish).
    if (shot.kind === "clip" && o.stepSpans.some((s) => s.label !== null)) {
      for (const sp of o.stepSpans) {
        const subSpanMs = sp.endMs - sp.startMs;
        if (subSpanMs <= 0) continue;
        if (sp.label === null) {
          figurePlans.push({ file: shot.file, startMs: sp.startMs, mode: "loop", spanMs: subSpanMs, clipMs: shot.durationMs });
        } else {
          const held = await heldFrameFor(o.id, shot, sp.label);
          if (held) {
            figurePlans.push({ file: held, startMs: sp.startMs, mode: "still", spanMs: subSpanMs, clipMs: 0 });
          } else {
            // Extraction failed → degrade to free-running the clip over this span
            // (figure stays on screen, just not snapped-and-held) rather than abort.
            figurePlans.push({ file: shot.file, startMs: sp.startMs, mode: "loop", spanMs: subSpanMs, clipMs: shot.durationMs });
          }
        }
      }
      continue;
    }
    if (shot.kind === "still") {
      figurePlans.push({ file: shot.file, startMs: o.startMs, mode: "still", spanMs, clipMs: 0 });
    } else if (shot.durationMs > spanMs) {
      holds.push({ posMs: o.visEndMs, durMs: shot.durationMs - spanMs });
      figurePlans.push({ file: shot.file, startMs: o.startMs, mode: "once", spanMs, clipMs: shot.durationMs });
    } else {
      figurePlans.push({ file: shot.file, startMs: o.startMs, mode: "loop", spanMs, clipMs: shot.durationMs });
    }
  }
  holds.sort((a, b) => a.posMs - b.posMs);
  return { figurePlans, holds };
}

export async function buildPlan(slug: string, t0: number, t1: number): Promise<Plan> {
  const { manifest, dir } = await findManifest(slug);
  const ctx = await loadPostCtx(slug);
  const chapterById = new Map(manifest.chapters.map((c) => [c.id, c]));

  const spanSec = (t1 - t0) / 1000;
  if (!(spanSec > 0)) throw new Error(`empty span [${t0}, ${t1}]`);

  const audioAbs = join(paths.contentRoot, manifest.audio.replace(/^\//, ""));
  if (!existsSync(audioAbs)) throw new Error(`audio missing: ${audioAbs}`);

  const fontsDir = join(paths.engineRoot, "generate", "assets", "fonts");
  const assPath = join(dir, ".video-captions.ass");

  // ----- chrome plate FILES (chapter bg + intro/divider slide). On-screen
  // times are resolved in VIDEO time below, once holds are known. -----
  const platesDir = join(dir, ".video-plates");
  await mkdir(platesDir, { recursive: true });
  const active = manifest.chapters.filter((c) => c.startTime < t1 && c.endTime > t0);
  const { bgPlates, slidePlates } = await buildPlates(active, ctx, chapterById, t0, t1, platesDir);

  // ----- figure occurrences (audio time): which figure is on the stage when,
  // from the `marks[].figure` stage pointer (methodology.md → "Staging a figure from narration"). VIDEO_DEMO_FIG_CUT_MS
  // shortens spans to force the long-animation pause path for testing. -----
  const cutMs = Number(process.env.VIDEO_DEMO_FIG_CUT_MS) || 0;
  const occurs = deriveFigureOccurrences(manifest.marks, t0, t1, manifest.duration, cutMs);

  // ----- resolve the figures we need (cache-first; a real browser only for
  // misses → an animated clip if the figure registered the animation contract,
  // else a settled still). See methodology.md → "Video export". -----
  const shots = new Map<string, FigureShot>();
  if (occurs.length > 0 && process.env.VIDEO_FIGURES !== "off") {
    const ids = [...new Set(occurs.map((o) => o.id))];
    const htmlPath = join(paths.postsDir, `${slug}.html`);
    const postHtml = existsSync(htmlPath) ? await Bun.file(htmlPath).text() : "";
    const cacheDir = join(dir, ".video-cache");
    try {
      for (const [k, v] of await timed("figure capture/cache", () =>
        resolveFigureShots(slug, ids, platesDir, cacheDir, postHtml),
      ))
        shots.set(k, v);
    } catch (e) {
      console.warn(`render-video: figure capture unavailable, stage left empty: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // ----- decide per-figure mode; insert a narration hold when an animation
  // outlasts its discussion span (CP2b: pause the narration to let it finish) -
  const { figurePlans, holds } = await planFigures(occurs, shots, platesDir);

  // audio-rel ms → video-rel ms: everything after a hold shifts later by it.
  const offsetMs = (aMs: number) => holds.reduce((acc, h) => acc + (h.posMs < aMs ? h.durMs : 0), 0);
  const mapMsAbs = (aMs: number) => aMs + offsetMs(aMs);
  const mapSec = (aMs: number) => mapMsAbs(aMs) / 1000;
  const videoTotalSec = (t1 - t0 + holds.reduce((a, h) => a + h.durMs, 0)) / 1000;

  await Bun.write(assPath, buildKaraokeAss(manifest.marks, t0, t1, DEFAULT_KARAOKE_STYLE, mapMsAbs));

  // ----- project everything into VIDEO-second layers (draw order: bg → figure
  // → slide; the waveform + captions are continuous and added in the final
  // pass, not here). -----
  const layers: VisualLayer[] = [];
  for (const p of bgPlates) {
    layers.push({ kind: "bg", file: p.file, vStart: mapSec(p.startMs), vEnd: mapSec(p.endMs) });
  }
  for (const p of figurePlans) {
    const vStart = mapSec(p.startMs);
    // A "once" clip plays straight through (its tail spans the narration hold);
    // a "loop"/"still" stays for the whole discussion span.
    const vEnd = p.mode === "once" ? vStart + p.clipMs / 1000 : mapSec(p.startMs + p.spanMs);
    layers.push({ kind: "figure", file: p.file, vStart, vEnd, mode: p.mode, clipSec: p.clipMs / 1000 });
  }
  const slideWindows: { vStart: number; vEnd: number }[] = [];
  for (const p of slidePlates) {
    const vStart = mapSec(p.startMs);
    const vEnd = mapSec(p.endMs);
    layers.push({ kind: "slide", file: p.file, vStart, vEnd });
    slideWindows.push({ vStart, vEnd });
  }

  return {
    slug,
    dir,
    t0,
    t1,
    spanSec,
    videoTotalSec,
    audioAbs,
    assPath,
    fontsDir,
    layers,
    slideWindows,
    holds,
    chapterCount: active.length,
  };
}
