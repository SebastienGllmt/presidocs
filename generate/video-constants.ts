// Shared leaf constants + the `timed` helper for the video export pipeline
// (generate/render-video.ts + its video-* modules). A dependency-free leaf so
// the module graph over plates/plan/filtergraph/render stays acyclic.
// See methodology.md → "Video export".

// --- timing ------------------------------------------------------------------

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`render-video: [timing] ${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  }
}

// --- output geometry + palette -----------------------------------------------

export const W = 1080;
export const H = 1920;
// The figure "stage": the empty mid-area between the header and the captions.
export const STAGE_W = 940;
export const STAGE_H = 680;
export const STAGE_CY = 800; // vertical centre of the stage box
export const C = {
  bg: "#0d1117",
  slideBg: "#0b1622",
  fg: "#f0f6fc",
  muted: "#8b949e",
  slate: "#c9d1d9",
  accent: "#1f6feb",
};

// --- render-plan timing / segmentation knobs ---------------------------------

export const SLIDE_HOLD_SEC = 2.0; // fully-opaque dwell on a chapter slide
export const SLIDE_FADE_SEC = 0.5; // crossfade in/out of a chapter slide
export const CUT_GAP_SEC = 1.0; // place a segment cut this long after a slide settles
export const MIN_SEG_SEC = 5.0; // don't create tiny segments
export const MIN_TAIL_SEC = 3.0; // keep the final segment from being a sliver
// Above this many image inputs, the single-pass graph gets slow → segment.
export const LAYERED_MIN_INPUTS = 20;
