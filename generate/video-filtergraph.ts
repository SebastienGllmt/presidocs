// Visual filtergraph emitter + segment-cut planning for the video export:
// pure ffmpeg string-building, shared by both render paths. Unit-tested via the
// re-exports in render-video.ts. See methodology.md → "Video export".

import {
  W,
  STAGE_W,
  STAGE_H,
  STAGE_CY,
  SLIDE_FADE_SEC,
  CUT_GAP_SEC,
  MIN_SEG_SEC,
  MIN_TAIL_SEC,
} from "./video-constants.ts";
// `finalTailParts` takes the whole `Plan` and `audioComposeParts`/`emitVisualParts`
// take its `Hold`/`VisualLayer` fields — imported type-only, so the plan→
// filtergraph edge is erased at compile time and the module graph stays acyclic.
import type { VisualLayer, Hold, Plan } from "./video-plan.ts";

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
export function emitVisualParts(layers: readonly VisualLayer[], segA: number, segB: number, idx0: number): EmittedVisual {
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
export function audioComposeParts(inLabel: string, holds: readonly Hold[], spanSec: number): { parts: string[]; outLabel: string } {
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
export function finalTailParts(plan: Plan, visualLabel: string, composedAudioLabel: string): string[] {
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

export const VIDEO_CODEC_ARGS = [
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
export function segmentsFromCuts(cuts: readonly number[], total: number): { a: number; b: number }[] {
  const bounds = [0, ...cuts, total];
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) out.push({ a: bounds[i]!, b: bounds[i + 1]! });
  return out;
}
