// Build step (offline): render a social-media video from a narrated post.
//
// The whole pipeline is manifest-driven and (for v1) browserless: every input
// already exists on disk after `generate` + `share-card` ran —
//   - generated/<slug>/full.<hash>.mp3        narration (MP3)
//   - generated/<slug>/manifest.<hash>.json   timeline: chapters + marks[].words[]
//   - posts/<slug>.html                        title + author email
//   - authors/<email>.json (+ avatar)          speaker name + image
// — so this step only *composes* them with ffmpeg. See methodology.md → "Video export".
//
// Visual layers (bottom→top), all driven by the manifest:
//   1. per-chapter background plate (chrome: site name, post title, current
//      chapter/sub-chapter, speaker avatar+name) — satori→resvg PNG, overlaid
//      for that chapter's [start,end) span.
//   2. per-chapter intro "slide" plate — a presentation-style title card shown
//      for the first few seconds of each chapter.
//   3. voice equalizer — ffmpeg `showfreqs` (speech-band spectrum, mirrored +
//      centred; ElevenLabs static-mode look, native, no Web Audio).
//   4. word-level karaoke captions — libass, burned from marks[].words[],
//      chunked to ~1–2 lines at a time.
// Narration is muxed back in, resampled to 48 kHz stereo + loudness-normalized
// for broad player/social compatibility.
//
// Runtime: Bun + ffmpeg (already a hard engine dependency; see audio-pipeline.ts).

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { renderElementToPng } from "./share-card.ts";
import { CAPTURE_DEFAULTS } from "./capture-defaults.ts";
import {
  CACHE_VERSION,
  hashStr,
  hashFile,
  figureEnvHash,
  figureCacheKey,
} from "./figureCacheKey.ts";
import { resolveAuthorProfile } from "../shared/authorProfile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";
import { extractPostMeta, readSiteMeta } from "./feeds.ts";
// The manifest timeline shape is the shared one (single source of truth with
// the producer + the live narrator). Aliased to this file's existing local
// names. Time fields carry the `Milliseconds` brand; this file reads them as
// plain numbers (a brand widens to `number`), so its arithmetic is unchanged.
import type {
  Manifest,
  ManifestMark as Mark,
  ManifestChapter as Chapter,
  ManifestWord as Word,
} from "../shared/manifestSchema.ts";

const paths = resolveBlogPaths();

type FigureShot = import("./capture-figures.ts").FigureShot;
type CapturedStep = import("./capture-figures.ts").CapturedStep;

// =============================================================================
// Caching + timing (incremental rebuild) — see methodology.md → "Video export"
// =============================================================================
//
// Two intermediates are content-addressed by their INPUTS (not, like the final
// `video.<hash>.mp4`, by their output bytes) so an unchanged rebuild skips work:
//   - figure captures (the ~20s/figure browser step) → `.video-cache/fig-<key>.*`
//   - the whole final render (segments + the dominant ~40-min encode) →
//     `.video-cache/render-<key>.mp4`
// The cheap stages (satori plates, the `.ass`) are recomputed every run — they
// cost milliseconds, so a stale-cache risk would never pay for itself.
//
// Keys are deliberately CONSERVATIVE: a false miss just re-renders (correct, a
// bit slower); a false hit would ship a stale video, so every input that can
// change the pixels is folded in. Bump CACHE_VERSION to invalidate everything
// (e.g. after an ffmpeg upgrade you want re-encoded, or a capture-param change
// not covered below).

// CACHE_VERSION, hashStr, hashFile, figureEnvHash, figureSubtree and
// figureCacheKey now live in ./figureCacheKey.ts — the single source of truth
// the height-regression test (e2e/figureHeight.e2e.ts) shares, so a figure that
// re-captures here also re-runs there (and vice versa). They're imported above
// and used unchanged below (the whole-video cache key still stamps in
// CACHE_VERSION and hashes via hashStr/hashFile).

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`render-video: [timing] ${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  }
}

// --- timeline types (subset of the manifest we consume) ----------------------
// `Manifest`/`Mark`/`Chapter`/`Word` are imported from shared/manifestSchema.ts
// above (aliased). `figure`/`step` on a `Mark` are the stage/per-step pointers
// (methodology.md → "Staging a figure from narration"); a figure id stages it,
// `"none"`/`""` clears it, absent leaves the stage unchanged.

// =============================================================================
// ASS karaoke caption emitter (pure; unit-tested in CP4)
// =============================================================================

/** ms → ASS time `H:MM:SS.cc` (centiseconds). Floors cs so it never rolls to 100. */
export function msToAssTime(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const cc = Math.floor((clamped % 1000) / 10);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cc)}`;
}

/** ASS dialogue text is `{...}`-delimited override blocks; strip braces/newlines
 *  from author text so a stray `{` can't open a bogus override. */
function escapeAssText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[{}]/g, "").replace(/\s+/g, " ");
}

/**
 * Split a mark's words into small caption groups so only ~1–2 lines show at
 * once (the social-caption convention), instead of a whole multi-sentence mark.
 * Flushes on a character budget or word cap; pure + exported for tests.
 */
export function chunkWords(
  words: readonly Word[],
  text: string,
  maxChars = 40,
  maxWords = 9,
): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (const w of words) {
    const len = text.slice(w.s, w.e).length + 1;
    if (cur.length > 0 && (chars + len > maxChars || cur.length >= maxWords)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += len;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

export type KaraokeStyle = {
  playResX: number;
  playResY: number;
  fontName: string;
  fontSize: number;
  primary: string; // already-spoken / "sung" colour (ASS &HAABBGGRR)
  secondary: string; // upcoming / not-yet-spoken colour
  outline: string;
  marginV: number;
  marginLR: number;
};

export const DEFAULT_KARAOKE_STYLE: KaraokeStyle = {
  playResX: 1080,
  playResY: 1920,
  fontName: "DejaVu Sans",
  fontSize: 60,
  primary: "&H00FFFFFF", // white once spoken
  secondary: "&H0081766E", // muted slate before spoken
  outline: "&H00000000", // black outline for legibility on any background
  marginV: 380,
  marginLR: 90,
};

/**
 * Build an ASS subtitle with word-level karaoke (`\k`) timing from the manifest
 * marks, chunked to ~1–2 lines. Times are rebased into the trimmed [t0,t1)
 * timeline (subtract t0) so they line up with audio fed through `-ss t0`.
 */
export function buildKaraokeAss(
  marks: readonly Mark[],
  t0: number,
  t1: number,
  style: KaraokeStyle = DEFAULT_KARAOKE_STYLE,
  // audio-rel ms → video-rel ms (identity unless holds were inserted). Caption
  // groups never span a hold (holds sit on mark boundaries), so mapping start
  // and end is sufficient.
  mapMs: (audioRelMs: number) => number = (a) => a,
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 2 = bottom-centre; Outline 4 + Shadow 1 keep it readable.
    `Style: Karaoke,${style.fontName},${style.fontSize},${style.primary},${style.secondary},${style.outline},&H64000000,-1,0,0,0,100,100,0,0,1,4,1,2,${style.marginLR},${style.marginLR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  for (const mark of marks) {
    const inSpan = (mark.words ?? []).filter((w) => w.t < t1 && w.t + w.d > t0);
    if (inSpan.length === 0) continue;

    for (const group of chunkWords(inSpan, mark.text)) {
      const start = mapMs(group[0]!.t - t0);
      const last = group[group.length - 1]!;
      const end = mapMs(last.t + last.d - t0);

      let text = "";
      for (let i = 0; i < group.length; i++) {
        const w = group[i]!;
        const next = group[i + 1];
        // Hold the current word's highlight through any gap before the next
        // word *in this group*; the group's last word resets at its own end so
        // the highlight never bleeds into the following caption.
        const chunkMs = next ? next.t - w.t : w.d;
        const cs = Math.max(0, Math.round(chunkMs / 10));
        const token = mark.text.slice(w.s, w.e);
        const sep = next ? mark.text.slice(w.e, next.s) : "";
        text += `{\\k${cs}}${escapeAssText(token + sep)}`;
      }
      events.push(`Dialogue: 0,${msToAssTime(start)},${msToAssTime(end)},Karaoke,,0,0,0,,${text}`);
    }
  }

  return [...header, ...events].join("\n") + "\n";
}

// --- span selection ----------------------------------------------------------

/** Snap a desired end time forward to the next mark boundary, so a cut never
 *  clips mid-word. */
export function snapToMark(marks: readonly Mark[], desiredMs: number): number {
  let best = 0;
  for (const m of marks) {
    if (m.time <= desiredMs) best = m.time;
    else return m.time;
  }
  return best;
}

/**
 * One labeled sub-span of a figure occurrence (methodology.md → "Video export"). `label: null` is a
 * continuous (free-run) stretch; a non-null label means "hold the figure at
 * `steps[label].endMs`" for that stretch — the renderer-side twin of the page's
 * stepped driving (methodology.md → "Live figure driving"). Spans partition the occurrence's
 * `[startMs, visEndMs)`, in `t0`-rebased video-relative ms, in forward order.
 */
export type FigureStepSpan = { label: string | null; startMs: number; endMs: number };

export type FigureOccur = {
  id: string;
  startMs: number;
  visEndMs: number;
  /**
   * The per-step schedule within this occurrence (methodology.md → "Video export"). A figure with no
   * `step=` cues yields a single `{ label: null, … }` span covering the whole
   * occurrence (today's free-run behavior). A stepped figure yields the
   * continuous prefix (`label: null`) followed by one span per `step` cue.
   */
  stepSpans: FigureStepSpan[];
};

/**
 * Compute each figure's on-stage span (audio-rel ms within `[t0,t1)`, returned
 * as `startMs/visEndMs` rebased to `t0`), from the `marks[].figure` stage
 * pointer (methodology.md → "Staging a figure from narration"). A `figure` value stages that figure; it is sticky
 * *within a sub-chapter* and **auto-clears at each sub-chapter boundary** (a
 * change in a mark's `chapter`); `figure: "" | "none"` clears it early; an
 * absent attribute leaves the stage unchanged. This yields tight, explicit
 * on/off spans (and genuine empty-stage stretches), which is what lets the
 * layered renderer include a figure input only in the segments that actually
 * need it (methodology.md → "Video export"). The stage defaults to empty, so a mark that never
 * sets `figure` shows no figure at all.
 *
 * `cutMs` (the `VIDEO_DEMO_FIG_CUT_MS` test knob) caps each span to force the
 * long-animation narration-hold path. Pure + exported for unit tests.
 */
export function deriveFigureOccurrences(
  marks: readonly Mark[],
  t0: number,
  t1: number,
  duration: number,
  cutMs = 0,
): FigureOccur[] {
  const occurs: FigureOccur[] = [];
  // Clamp a raw [start,end) audio span into [t0,t1), apply the cutMs cap, rebase,
  // and partition it into the per-step held-frame schedule. `changes` is the raw
  // (audio-ms) list of step transitions inside the span: `{label,atMs}` in order,
  // starting with the `null` (continuous) prefix; each entry runs until the next
  // one (or the span end). Mirrors the page's `stagedFigureAt` step walk
  // (methodology.md → "Live figure driving"): step only moves at a cue, `none`/"" → null, a figure-id change
  // or sub-chapter boundary ends the span (and so the schedule). (methodology.md → "Video export")
  const emit = (
    id: string,
    start: number,
    end: number,
    changes: { label: string | null; atMs: number }[],
  ) => {
    const capped = cutMs > 0 ? Math.min(end, start + cutMs) : end;
    const s = Math.max(start, t0);
    const e = Math.min(capped, t1);
    if (e <= s) return;
    const stepSpans: FigureStepSpan[] = [];
    for (let i = 0; i < changes.length; i++) {
      const segStart = changes[i]!.atMs;
      const segEnd = i + 1 < changes.length ? changes[i + 1]!.atMs : end;
      const cs = Math.max(segStart, s);
      const ce = Math.min(segEnd, e);
      if (ce > cs) stepSpans.push({ label: changes[i]!.label, startMs: cs - t0, endMs: ce - t0 });
    }
    // Defensive: a span with no recorded changes (or all clamped away) is one
    // continuous null span — today's free-run, the back-compat default.
    if (stepSpans.length === 0) stepSpans.push({ label: null, startMs: s - t0, endMs: e - t0 });
    occurs.push({ id, startMs: s - t0, visEndMs: e - t0, stepSpans });
  };

  // Walk the staged figure, flushing a span whenever it changes, the stage
  // clears, or the sub-chapter boundary is crossed. `curStep`/`changes` track the
  // step schedule within the current span.
  let cur: string | null = null;
  let curStart = 0;
  let curStep: string | null = null;
  let changes: { label: string | null; atMs: number }[] = [];
  let prevChapter: string | undefined;
  const flush = (endTime: number) => {
    if (cur !== null) emit(cur, curStart, endTime, changes);
    cur = null;
    curStep = null;
    changes = [];
  };
  for (const m of marks) {
    if (m.chapter !== prevChapter) {
      flush(m.time); // a new sub-chapter resets the stage
      prevChapter = m.chapter;
    }
    if (m.figure !== undefined) {
      const next = m.figure === "" || m.figure === "none" ? null : m.figure;
      if (next !== cur) {
        flush(m.time);
        if (next !== null) {
          cur = next;
          curStart = m.time;
          curStep = null;
          changes = [{ label: null, atMs: m.time }]; // span opens continuous
        }
      }
    }
    // Evaluate `step` AFTER `figure` so a single mark that re-stages a figure and
    // names a step records that step (the figure change above already reset the
    // schedule). A step cue only applies while a figure is staged.
    if (m.step !== undefined && cur !== null) {
      const lbl = m.step === "" || m.step === "none" ? null : m.step;
      if (lbl !== curStep) {
        curStep = lbl;
        changes.push({ label: lbl, atMs: m.time });
      }
    }
  }
  flush(duration);
  return occurs;
}

// =============================================================================
// satori chrome plates (background + chapter intro slide)
// =============================================================================

const W = 1080;
const H = 1920;
// The figure "stage": the empty mid-area between the header and the captions.
const STAGE_W = 940;
const STAGE_H = 680;
const STAGE_CY = 800; // vertical centre of the stage box
const C = {
  bg: "#0d1117",
  slideBg: "#0b1622",
  fg: "#f0f6fc",
  muted: "#8b949e",
  slate: "#c9d1d9",
  accent: "#1f6feb",
};

type PostCtx = {
  siteName: string;
  title: string;
  authorName: string | null;
  avatarDataUri: string | null;
};

function speakerChip(ctx: PostCtx, size: number, fontSize: number): unknown {
  const children: unknown[] = [];
  if (ctx.avatarDataUri) {
    children.push({
      type: "img",
      props: {
        src: ctx.avatarDataUri,
        width: size,
        height: size,
        style: { width: size, height: size, borderRadius: size, objectFit: "cover" },
      },
    });
  }
  if (ctx.authorName) {
    children.push({
      type: "div",
      props: { style: { fontSize, fontWeight: 700, color: C.slate }, children: ctx.authorName },
    });
  }
  return { type: "div", props: { style: { display: "flex", alignItems: "center", gap: 16 }, children } };
}

function bgPlate(ctx: PostCtx, chapter: Chapter, parentTitle: string | null): unknown {
  const pillChildren: unknown[] = [
    {
      type: "div",
      props: {
        style: { fontSize: 22, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: C.accent },
        children: "Chapter",
      },
    },
  ];
  if (parentTitle) {
    pillChildren.push({
      type: "div",
      props: { style: { fontSize: 26, color: C.muted }, children: parentTitle },
    });
  }
  pillChildren.push({
    type: "div",
    props: { style: { display: "flex", fontSize: 38, fontWeight: 700, lineHeight: 1.1, color: "#e6edf3" }, children: chapter.title },
  });

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.bg,
        padding: "70px 64px",
        fontFamily: "Red Hat Text",
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column", gap: 16 },
            children: [
              {
                type: "div",
                props: {
                  style: { fontSize: 26, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: C.muted },
                  children: ctx.siteName,
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", fontSize: 50, fontWeight: 700, lineHeight: 1.12, color: C.fg, maxHeight: 50 * 1.12 * 3, overflow: "hidden" },
                  children: ctx.title,
                },
              },
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8, paddingLeft: 18, borderLeft: `8px solid ${C.accent}` },
                  children: pillChildren,
                },
              },
              { type: "div", props: { style: { display: "flex", marginTop: 22 }, children: [speakerChip(ctx, 52, 30)] } },
            ],
          },
        },
      ],
    },
  };
}

// The OPENING slide only: a proper author intro — blog name, the opening
// chapter title, and the speaker (avatar + name). Shown once, at the start.
function introPlate(ctx: PostCtx, chapter: Chapter): unknown {
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backgroundColor: C.slideBg,
        padding: "0 90px",
        fontFamily: "Red Hat Text",
      },
      children: [
        { type: "div", props: { style: { width: 120, height: 12, backgroundColor: C.accent, marginBottom: 40 } } },
        {
          type: "div",
          props: {
            style: { fontSize: 30, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: C.muted, marginBottom: 16 },
            children: ctx.siteName,
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", fontSize: 84, fontWeight: 700, lineHeight: 1.08, color: C.fg, maxHeight: 84 * 1.08 * 4, overflow: "hidden" },
            children: chapter.title,
          },
        },
        { type: "div", props: { style: { display: "flex", marginTop: 48 }, children: [speakerChip(ctx, 56, 30)] } },
      ],
    },
  };
}

// Every chapter break AFTER the opening: a slideshow section divider — accent
// bar + (parent-section label when this is a sub-chapter) + the chapter title.
// Deliberately NO author/blog chrome (the persistent header carries that).
function slidePlate(_ctx: PostCtx, chapter: Chapter, parentTitle: string | null): unknown {
  // A section divider, slideshow-style: accent bar + (parent-section label when
  // this is a sub-chapter) + the chapter title. Deliberately NO author/blog/
  // title chrome — the persistent background plate carries that continuously, so
  // re-showing it on every chapter break would be noise.
  const children: unknown[] = [
    { type: "div", props: { style: { width: 120, height: 12, backgroundColor: C.accent, marginBottom: 40 } } },
  ];
  if (parentTitle) {
    children.push({
      type: "div",
      props: {
        style: { fontSize: 30, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: C.muted, marginBottom: 16 },
        children: parentTitle,
      },
    });
  }
  children.push({
    type: "div",
    props: {
      style: { display: "flex", fontSize: 84, fontWeight: 700, lineHeight: 1.08, color: C.fg, maxHeight: 84 * 1.08 * 4, overflow: "hidden" },
      children: chapter.title,
    },
  });
  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backgroundColor: C.slideBg,
        padding: "0 90px",
        fontFamily: "Red Hat Text",
      },
      children,
    },
  };
}

// --- post metadata helpers ---------------------------------------------------

// Post <title> and blog name: one source of truth with the feed extractors in
// generate/feeds.ts (HTMLRewriter + entity decode; a real parser handles tag
// attributes, RCDATA, and entity boundaries a regex would miss).
function extractTitle(html: string): string {
  return extractPostMeta(html).title;
}

async function readSiteName(): Promise<string> {
  return (await readSiteMeta()).title;
}

async function avatarDataUri(srcPath: string | null): Promise<string | null> {
  if (!srcPath || !existsSync(srcPath)) return null;
  const ext = srcPath.split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : null;
  if (!mime) return null;
  const b64 = Buffer.from(await Bun.file(srcPath).arrayBuffer()).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function loadPostCtx(slug: string): Promise<PostCtx> {
  const htmlPath = join(paths.postsDir, `${slug}.html`);
  const html = existsSync(htmlPath) ? await Bun.file(htmlPath).text() : "";
  const title = extractTitle(html) || slug;
  const siteName = (await readSiteName()) || "Blog";
  const email = html ? parseAuthorEmailFromHtml(html) : null;
  let authorName: string | null = null;
  let avatar: string | null = null;
  if (email) {
    const res = await resolveAuthorProfile(paths.contentRoot, email);
    if (res.ok) {
      authorName = res.author.profile.name;
      avatar = await avatarDataUri(res.author.avatarSrcPath);
    }
  }
  return { siteName, title, authorName, avatarDataUri: avatar };
}

// --- manifest loading --------------------------------------------------------

async function findManifest(slug: string): Promise<{ manifest: Manifest; dir: string }> {
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

const SLIDE_HOLD_SEC = 2.0; // fully-opaque dwell on a chapter slide
const SLIDE_FADE_SEC = 0.5; // crossfade in/out of a chapter slide
const CUT_GAP_SEC = 1.0; // place a segment cut this long after a slide settles
const MIN_SEG_SEC = 5.0; // don't create tiny segments
const MIN_TAIL_SEC = 3.0; // keep the final segment from being a sliver
// Above this many image inputs, the single-pass graph gets slow → segment.
const LAYERED_MIN_INPUTS = 20;

// Every visual placement is expressed in VIDEO seconds (post-hold), so both
// paths and the segmenter share one timeline. A figure also carries its clip
// mode + length, which decides how it is fed/looped into a segment.
type VisualLayer =
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

type Hold = { posMs: number; durMs: number };

type Plan = {
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

async function buildPlan(slug: string, t0: number, t1: number): Promise<Plan> {
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

  type TimedPlate = { file: string; startMs: number; endMs: number };
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
  const holds: Hold[] = [];
  type FigurePlan = { file: string; startMs: number; mode: "still" | "loop" | "once"; spanMs: number; clipMs: number };
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

// =============================================================================
// Visual filtergraph emitter (shared by both paths; pure string-building)
// =============================================================================

const between = (start: number, end: number) =>
  `enable='between(t,${Math.max(0, start).toFixed(3)},${end.toFixed(3)})'`;

/**
 * Decide how one figure layer is fed into a segment [segA,segB] (VIDEO sec),
 * with all times rebased to segment-local 0. A clip is aligned so its frame 0
 * lands at the figure's `vStart`, and it stays continuous across a segment cut:
 *   - already playing at the cut (`vStart <= segA`) → seek `-ss` into the clip
 *     (a loop's seek is modulo the clip length, which keeps the loop phase
 *     aligned to absolute time across the join);
 *   - starts inside the segment (`vStart > segA`) → delay it with `setpts`.
 * Pure + exported for unit tests. Returns null when the layer misses [segA,segB].
 */
export function figureSegmentPlacement(
  layer: { vStart: number; vEnd: number; mode: "still" | "loop" | "once"; clipSec: number },
  segA: number,
  segB: number,
): { enableStart: number; enableEnd: number; ss: number | null; delay: number | null; loop: boolean } | null {
  if (!(layer.vStart < segB && layer.vEnd > segA)) return null;
  const ls = Math.max(layer.vStart, segA) - segA;
  const le = Math.min(layer.vEnd, segB) - segA;
  if (layer.mode === "still") {
    return { enableStart: ls, enableEnd: le, ss: null, delay: null, loop: false };
  }
  const loop = layer.mode === "loop";
  if (layer.vStart <= segA) {
    const into = segA - layer.vStart;
    const ss = loop && layer.clipSec > 0 ? into % layer.clipSec : into;
    return { enableStart: 0, enableEnd: le, ss, delay: null, loop };
  }
  return { enableStart: ls, enableEnd: le, ss: null, delay: layer.vStart - segA, loop };
}

type EmittedVisual = { parts: string[]; inputs: string[]; last: string; nextIdx: number };

/**
 * Emit overlay filter parts + the matching ffmpeg image inputs for every layer
 * intersecting [segA,segB] (VIDEO sec), rebased to segment-local time. The base
 * `[base]` source is added by the caller (its duration differs per segment).
 * `idx0` is the first free ffmpeg input index (1 in single-pass — input 0 is the
 * audio; 0 in a video-only segment render).
 */
function emitVisualParts(layers: readonly VisualLayer[], segA: number, segB: number, idx0: number): EmittedVisual {
  const parts: string[] = [];
  const inputs: string[] = [];
  let last = "base";
  let idx = idx0;
  for (const layer of layers) {
    if (!(layer.vStart < segB && layer.vEnd > segA)) continue;
    const out = `o${idx}`;
    const sc = `s${idx}`;
    if (layer.kind === "bg") {
      const ls = Math.max(layer.vStart, segA) - segA;
      const le = Math.min(layer.vEnd, segB) - segA;
      inputs.push("-loop", "1", "-i", layer.file);
      parts.push(`[${last}][${idx}:v]overlay=${between(ls, le)}[${out}]`);
    } else if (layer.kind === "slide") {
      // Slides never straddle a cut (computeCuts guarantees it), so the whole
      // crossfade lives inside one segment and stays seam-free.
      const fin = layer.vStart - segA;
      const foutStart = layer.vEnd - segA - SLIDE_FADE_SEC;
      const ls = Math.max(fin, 0);
      const le = layer.vEnd - segA;
      inputs.push("-loop", "1", "-i", layer.file);
      parts.push(
        `[${idx}:v]format=rgba,fade=t=in:st=${fin.toFixed(3)}:d=${SLIDE_FADE_SEC}:alpha=1,fade=t=out:st=${foutStart.toFixed(3)}:d=${SLIDE_FADE_SEC}:alpha=1[${sc}]`,
      );
      parts.push(`[${last}][${sc}]overlay=${between(ls, le)}[${out}]`);
    } else {
      const place = figureSegmentPlacement(layer, segA, segB)!;
      if (place.loop) inputs.push("-stream_loop", "-1");
      if (place.ss != null) inputs.push("-ss", place.ss.toFixed(3));
      // A still figure is a single PNG → loop it; a clip (loop/once) supplies
      // its own frames and is bounded by enable / clip length.
      if (!place.loop && place.ss == null && place.delay == null) inputs.push("-loop", "1");
      inputs.push("-i", layer.file);
      let scale = `[${idx}:v]scale=${STAGE_W}:${STAGE_H}:force_original_aspect_ratio=decrease`;
      if (place.delay != null && place.delay > 0) scale += `,setpts=PTS-STARTPTS+${place.delay.toFixed(3)}/TB`;
      parts.push(`${scale}[${sc}]`);
      parts.push(
        `[${last}][${sc}]overlay=x=(main_w-overlay_w)/2:y=${STAGE_CY}-overlay_h/2:${between(place.enableStart, place.enableEnd)}[${out}]`,
      );
    }
    last = out;
    idx++;
  }
  return { parts, inputs, last, nextIdx: idx };
}

/**
 * Compose the narration audio: splice silence where the narration pauses for an
 * over-long animation (CP2b). With no holds it is just the input track. `inLabel`
 * is the ffmpeg audio pad (e.g. `0:a` single-pass, `<K>:a` in the final pass).
 */
function audioComposeParts(inLabel: string, holds: readonly Hold[], spanSec: number): { parts: string[]; outLabel: string } {
  if (holds.length === 0) return { parts: [], outLabel: inLabel };
  const fmt = "aformat=sample_fmts=fltp:channel_layouts=mono:sample_rates=22050";
  const parts: string[] = [];
  const cat: string[] = [];
  let prev = 0;
  holds.forEach((h, k) => {
    const p = h.posMs / 1000;
    parts.push(`[${inLabel}]atrim=${prev.toFixed(3)}:${p.toFixed(3)},asetpts=PTS-STARTPTS,${fmt}[aseg${k}]`);
    cat.push(`[aseg${k}]`);
    parts.push(`aevalsrc=0:d=${(h.durMs / 1000).toFixed(3)}:s=22050,${fmt}[asil${k}]`);
    cat.push(`[asil${k}]`);
    prev = p;
  });
  parts.push(`[${inLabel}]atrim=${prev.toFixed(3)}:${spanSec.toFixed(3)},asetpts=PTS-STARTPTS,${fmt}[asegN]`);
  cat.push(`[asegN]`);
  parts.push(`${cat.join("")}concat=n=${cat.length}:v=0:a=1[acomposed]`);
  return { parts, outLabel: "acomposed" };
}

/**
 * The continuous layers, added once over the whole timeline so they never seam:
 * loudness-normalize the composed audio, then split it → a voice "equalizer"
 * overlaid on the visual → burn the karaoke captions. Produces `[v]`/`[aout]`.
 *
 * The equalizer reproduces the ElevenLabs static-mode look natively from ffmpeg's
 * `showfreqs`: a frequency spectrum of the (normalized) narration, cropped to the
 * speech band (~5–40% of Nyquist) and scaled to fill the bars, mirrored around
 * centre (low freq in the middle) and centred vertically, with light spectral +
 * temporal smoothing for the soft, blobby feel. It streams from the composed
 * (held) audio in-graph — the same single pass as the old waveform — so it stays
 * in sync and never seams. The `showfreqs`/`eq*` knobs are tunable; bump
 * CACHE_VERSION after changing them so stale renders don't serve.
 */
function finalTailParts(plan: Plan, visualLabel: string, composedAudioLabel: string): string[] {
  const half = W / 2; // each mirrored half is W/2 wide
  const halfH = 90; // each mirrored half's height (band = 2×); lowered so the eq isn't too tall
  const midY = 1330; // band's vertical midline, kept fixed as the height changes
  return [
    // Pin the channel layout before the split so a mono source can't make ffmpeg
    // fail to negotiate a layout across `asplit` on a mid-stream reinit ("Cannot
    // select channel layout"). The audible `[aout]` stays stereo; the eq branch
    // downmixes to mono below (showfreqs colours a 2nd channel white otherwise).
    // NOTE: single-pass `loudnorm` runs in dynamic mode (a compressor), which can
    // introduce a few ms of latency/duration drift. The final length is pinned by
    // `-t videoTotalSec` and captions are rebased to the trimmed timeline, so it's
    // absorbed — but it's the first suspect if caption drift ever appears at length.
    `[${composedAudioLabel}]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,asplit=2[anorm][aout]`,
    // EQ branch (visual only — never the audible `[aout]`): the speech-band
    // spectrum, scaled up to spread across the bars.
    `[anorm]aformat=channel_layouts=mono,showfreqs=s=2000x${halfH}:mode=bar:ascale=log:fscale=lin:win_size=1024:averaging=2:colors=0x58a6ff,format=rgba,crop=702:${halfH}:94:0,scale=${half}:${halfH}[ef]`,
    // Mirror around centre (low freq in the middle): hflip one copy, hstack.
    `[ef]split[ef1][ef2]`,
    `[ef2]hflip[ef2m]`,
    `[ef2m][ef1]hstack=inputs=2[ehalf]`,
    // Centre vertically: bars grow up in the top half and down in the vflipped
    // bottom half, meeting at the midline.
    `[ehalf]split[eh1][eh2]`,
    `[eh2]vflip[eh2v]`,
    `[eh1][eh2v]vstack=inputs=2[eq0]`,
    // Light temporal smoothing + slight translucency for the soft ElevenLabs feel.
    `[eq0]tmix=frames=2,format=rgba,colorchannelmixer=aa=0.92[wave]`,
    `[${visualLabel}][wave]overlay=x=(W-w)/2:y=${midY - halfH}[wv]`,
    `[wv]ass=${plan.assPath}:fontsdir=${plan.fontsDir}[v]`,
  ];
}

const VIDEO_CODEC_ARGS = [
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
  "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
  "-map_metadata", "-1", // strip metadata copied from the inputs
  "-map_chapters", "-1", // drop the chapter track inherited from the source mp3 (the video isn't chaptered)
  // bitexact: also strip the muxer's own `encoder=Lavf<version>` container tag and
  // the codec version SEI, which `-map_metadata -1` does NOT remove. Without this
  // the output bytes carry the ffmpeg version, so the content hash would differ
  // across ffmpeg builds/machines for otherwise-identical inputs. Verified: removes
  // the tag and keeps output byte-identical run-to-run. Folded into the render cache
  // key via `finalInputKey`'s `codec` field, so changing it self-invalidates.
  "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
];

// =============================================================================
// Segment cut planning (pure; unit-tested)
// =============================================================================

/**
 * Choose video-only segment boundaries for the layered render. A cut is placed
 * shortly after each chapter slide has fully settled — i.e. in the chapter's
 * dwell, where nothing is transitioning — so a cut never lands on a slide
 * crossfade (which straddles the chapter boundary). Tiny chapters that can't fit
 * a clean dwell cut are merged into the previous segment. Pure + exported.
 */
export function computeCuts(
  slideWindows: readonly { vStart: number; vEnd: number }[],
  videoTotalSec: number,
  opts: { gap?: number; minSeg?: number; minTail?: number } = {},
): number[] {
  const gap = opts.gap ?? CUT_GAP_SEC;
  const minSeg = opts.minSeg ?? MIN_SEG_SEC;
  const minTail = opts.minTail ?? MIN_TAIL_SEC;
  const cuts: number[] = [];
  let lastCut = 0;
  // slideWindows[0] is the opening (intro) slide → no cut before it. Each later
  // slide's settle point seeds a candidate cut just after it.
  for (let k = 1; k < slideWindows.length; k++) {
    const cut = slideWindows[k]!.vEnd + gap;
    const nextSlideStart = slideWindows[k + 1]?.vStart ?? Infinity;
    if (cut > lastCut + minSeg && cut < videoTotalSec - minTail && cut < nextSlideStart) {
      cuts.push(cut);
      lastCut = cut;
    }
  }
  return cuts;
}

/** Partition [0, total] into [a,b] segments at the given interior cut points. */
function segmentsFromCuts(cuts: readonly number[], total: number): { a: number; b: number }[] {
  const bounds = [0, ...cuts, total];
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) out.push({ a: bounds[i]!, b: bounds[i + 1]! });
  return out;
}

// =============================================================================
// Render paths
// =============================================================================

// Single graph for the whole span — cheap when the input count is small (teaser).
async function renderSinglePass(plan: Plan): Promise<string> {
  const basePart = `color=c=0x0d1117:s=${W}x${H}:r=30:d=${plan.videoTotalSec.toFixed(3)}[base]`;
  const vis = emitVisualParts(plan.layers, 0, plan.videoTotalSec, 1); // input 0 is the audio
  const audio = audioComposeParts("0:a", plan.holds, plan.spanSec);
  const fc = [basePart, ...vis.parts, ...audio.parts, ...finalTailParts(plan, vis.last, audio.outLabel)].join(";");

  const tmpPath = join(plan.dir, ".video-tmp.mp4");
  const args = [
    "-y",
    "-ss", String(plan.t0 / 1000),
    "-t", plan.spanSec.toFixed(3),
    "-i", plan.audioAbs,
    ...vis.inputs,
    "-filter_complex", fc,
    "-map", "[v]",
    "-map", "[aout]",
    ...VIDEO_CODEC_ARGS,
    "-t", plan.videoTotalSec.toFixed(3),
    tmpPath,
  ];
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("ffmpeg failed (single-pass)");
  return tmpPath;
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

// Layered (methodology.md → "Video export"): render the discrete visual track in per-chapter
// segments (each opens only the few inputs it needs), then ONE final pass
// concat-joins the segments and adds the continuous layers (audio + waveform +
// captions) so those never seam.
async function renderLayered(plan: Plan): Promise<string> {
  const cuts = computeCuts(plan.slideWindows, plan.videoTotalSec);
  const segments = segmentsFromCuts(cuts, plan.videoTotalSec);
  const segDir = join(plan.dir, ".video-segments");
  await rm(segDir, { recursive: true, force: true });
  await mkdir(segDir, { recursive: true });

  const segFiles: string[] = new Array(segments.length);
  const concurrency = Math.max(1, Number(process.env.VIDEO_SEG_CONCURRENCY) || 2);
  console.log(`render-video: ${segments.length} visual segment(s), concurrency ${concurrency}`);

  await timed(`segment renders (${segments.length})`, () =>
    runPool(segments, concurrency, async (seg, i) => {
    const segDur = seg.b - seg.a;
    const basePart = `color=c=0x0d1117:s=${W}x${H}:r=30:d=${segDur.toFixed(3)}[base]`;
    const vis = emitVisualParts(plan.layers, seg.a, seg.b, 0); // video-only: inputs start at 0
    const fc = [basePart, ...vis.parts].join(";");
    const file = join(segDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    segFiles[i] = file;
    const args = [
      "-y",
      ...vis.inputs,
      "-filter_complex", fc,
      "-map", `[${vis.last}]`,
      "-an",
      // Near-lossless ultrafast intermediate — the final pass re-encodes once,
      // so spend no time here; quality is preserved through the single re-encode.
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "14", "-r", "30",
      "-t", segDur.toFixed(3),
      file,
    ];
    const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed on segment ${i} [${seg.a.toFixed(1)},${seg.b.toFixed(1)}]`);
  }),
  );

  // Final pass: concat the visual segments (one input each, decoded in turn) and
  // add the continuous layers over the whole timeline.
  const k = segFiles.length; // audio input index, after the K segment videos
  const concat = `${segFiles.map((_, i) => `[${i}:v]`).join("")}concat=n=${k}:v=1:a=0[vis]`;
  const audio = audioComposeParts(`${k}:a`, plan.holds, plan.spanSec);
  const fc = [concat, ...audio.parts, ...finalTailParts(plan, "vis", audio.outLabel)].join(";");

  const tmpPath = join(plan.dir, ".video-tmp.mp4");
  const args = [
    "-y",
    ...segFiles.flatMap((f) => ["-i", f]),
    "-ss", String(plan.t0 / 1000),
    "-t", plan.spanSec.toFixed(3),
    "-i", plan.audioAbs,
    "-filter_complex", fc,
    "-map", "[v]",
    "-map", "[aout]",
    ...VIDEO_CODEC_ARGS,
    "-t", plan.videoTotalSec.toFixed(3),
    tmpPath,
  ];
  console.log("render-video: final composite pass (concat + audio + waveform + captions)…");
  await timed("final composite (concat + encode)", async () => {
    const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) !== 0) throw new Error("ffmpeg failed (final composite)");
  });
  await rm(segDir, { recursive: true, force: true });
  return tmpPath;
}

// Content-address the output (`video.<hash>.mp4`) + a metadata sidecar the feed
// step (proposal 42 §5.5) consumes. Deliberately does NOT sweep superseded
// hashes (see the NOTE below) — unlike the audio scheme.
async function finalizeOutput(plan: Plan, tmpPath: string): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const videoName = `video.${hash}.mp4`;
  const sidecarName = `video.${hash}.json`;
  await Bun.write(join(plan.dir, videoName), bytes);
  await Bun.write(
    join(plan.dir, sidecarName),
    JSON.stringify(
      {
        url: `/generated/${plan.slug}/${videoName}`,
        type: "video/mp4",
        durationMs: Math.round(plan.videoTotalSec * 1000),
        width: W,
        height: H,
        bytes: bytes.byteLength,
        bitrate: Math.round((bytes.byteLength * 8) / plan.videoTotalSec),
        codecs: "avc1.640028,mp4a.40.2",
      },
      null,
      2,
    ) + "\n",
  );
  await rm(tmpPath, { force: true });
  // NOTE: we deliberately do NOT sweep other `video.<hash>.{mp4,json}` here. A
  // full render is expensive (tens of minutes), and a different cut (full vs
  // teaser) produces a different hash — auto-sweeping silently destroyed the
  // other cut every render. Keeping them is cheap insurance; the author deletes
  // stale renders by hand. (Downstream, copy-static deliberately does NOT ship the
  // video — it's a local-only artifact, see methodology.md → "Video export" — so kept renders never
  // reach a deploy; the author uploads the chosen cut by hand.)
  console.log(`render-video: wrote ${videoName} (+ ${sidecarName})`);
}

/**
 * Content hash of every INPUT to the final composite — all layer files (by
 * content), their placements/timings, the holds, the composed audio (its
 * already-hashed filename), the burned `.ass` text, and the encode params. An
 * unchanged rebuild matches the cached render and skips segments + the dominant
 * 40-min encode entirely. See methodology.md → "Video export".
 */
async function finalInputKey(plan: Plan): Promise<string> {
  const layers: unknown[] = [];
  for (const l of plan.layers) {
    layers.push({
      kind: l.kind,
      vStart: l.vStart,
      vEnd: l.vEnd,
      mode: l.kind === "figure" ? l.mode : undefined,
      clipSec: l.kind === "figure" ? l.clipSec : undefined,
      file: await hashFile(l.file),
    });
  }
  const assText = existsSync(plan.assPath) ? await Bun.file(plan.assPath).text() : "";
  return hashStr(
    JSON.stringify({
      v: CACHE_VERSION,
      t0: plan.t0,
      t1: plan.t1,
      total: plan.videoTotalSec,
      holds: plan.holds,
      w: W,
      h: H,
      codec: VIDEO_CODEC_ARGS,
      audio: plan.audioAbs.split("/").pop(), // hashed filename carries the audio content
      ass: hashStr(assText),
      layers,
    }),
  );
}

async function main() {
  const overall = performance.now();
  const slug = process.argv[2];
  if (!slug) throw new Error("usage: bun render-video.ts <slug> [startMs] [endMs]");

  const { manifest } = await findManifest(slug);
  // Default is the FULL narration (methodology.md → "Video export"). Pass an explicit endMs to
  // cut a shorter teaser; it snaps forward to a mark so it never clips mid-word.
  const t0 = process.argv[3] ? Number(process.argv[3]) : 0;
  const t1 = process.argv[4] ? snapToMark(manifest.marks, Number(process.argv[4])) : manifest.duration;

  const plan = await timed("plan (plates + figures)", () => buildPlan(slug, t0, t1));

  // Route: the layered path only pays off past the point the single graph gets
  // slow (input-count × duration). A short teaser stays single-pass.
  const figureCount = plan.layers.filter((l) => l.kind === "figure").length;
  const useLayered =
    process.env.VIDEO_RENDER === "layered" ||
    (process.env.VIDEO_RENDER !== "single" && plan.layers.length > LAYERED_MIN_INPUTS);

  const heldSec = plan.videoTotalSec - plan.spanSec;
  const holdMsg = plan.holds.length ? `, ${plan.holds.length} narration hold(s) +${heldSec.toFixed(1)}s` : "";
  console.log(
    `render-video: ${slug} [${t0}..${t1}]ms → ${plan.videoTotalSec.toFixed(1)}s, ${plan.chapterCount} chapters, ` +
      `${figureCount} figure(s), ${plan.layers.length} image input(s)${holdMsg} — ${useLayered ? "layered" : "single-pass"}`,
  );

  // Final-render cache: skip segments + encode when the inputs are unchanged.
  const tmpPath = join(plan.dir, ".video-tmp.mp4");
  const cacheDir = join(plan.dir, ".video-cache");
  const key = await finalInputKey(plan);
  const cachePath = join(cacheDir, `render-${key}.mp4`);

  if (existsSync(cachePath)) {
    console.log(`render-video: final-render cache hit (${key}) — skipping segments + encode`);
    await Bun.write(tmpPath, Bun.file(cachePath));
  } else {
    const label = useLayered ? "layered render" : "single-pass render";
    const produced = await timed(label, () => (useLayered ? renderLayered(plan) : renderSinglePass(plan)));
    await mkdir(cacheDir, { recursive: true });
    await Bun.write(cachePath, Bun.file(produced)); // produced === tmpPath
    // No eviction: render caches are never auto-deleted. A full cut is expensive
    // to regenerate, so we keep every one (the author prunes `.video-cache/` by
    // hand if disk gets tight). Same posture as the figure cache.
  }

  await finalizeOutput(plan, tmpPath);
  console.log(`render-video: [timing] total: ${((performance.now() - overall) / 1000).toFixed(1)}s`);
}

if (import.meta.main) {
  await main();
}
