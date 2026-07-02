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
//
// This is the orchestrator: routing, the two render paths, the final-render
// cache, and output. The pure pieces (captions, timeline, plates, plan-building,
// filtergraph) live in the video-* modules and are re-exported at the bottom.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CACHE_VERSION, hashStr, hashFile } from "./figureCacheKey.ts";
import { W, H, LAYERED_MIN_INPUTS, timed } from "./video-constants.ts";
import { snapToMark } from "./video-timeline.ts";
import { buildPlan, findManifest, type Plan } from "./video-plan.ts";
import {
  emitVisualParts,
  audioComposeParts,
  finalTailParts,
  VIDEO_CODEC_ARGS,
  computeCuts,
  segmentsFromCuts,
} from "./video-filtergraph.ts";

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

// Re-exported for render-video.test.ts + e2e/videoStepRender.e2e.ts (and any
// future consumer): the pure pieces now live in the video-* modules.
export { msToAssTime, chunkWords, buildKaraokeAss, DEFAULT_KARAOKE_STYLE, type KaraokeStyle } from "./video-captions.ts";
export { snapToMark, deriveFigureOccurrences, type FigureStepSpan, type FigureOccur } from "./video-timeline.ts";
export { heldFrameIndex, extractHeldFrame } from "./video-plan.ts";
export { figureSegmentPlacement, computeCuts } from "./video-filtergraph.ts";
