// Pure span/occurrence math for the video export: mark-snapping + deriving each
// figure's on-stage span/step schedule from the manifest. Unit-tested via the
// re-exports in render-video.ts. See methodology.md → "Video export".
//
// `Mark` is the shared manifest mark type (single source of truth with the
// producer + the live narrator), aliased to this file's local name. Time fields
// carry the `Milliseconds` brand; this file reads them as plain numbers (a brand
// widens to `number`), so its arithmetic is unchanged.
import type { ManifestMark as Mark } from "../shared/manifestSchema.ts";

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
