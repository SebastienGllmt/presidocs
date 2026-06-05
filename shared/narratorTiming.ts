// Pure timing helpers extracted from narrator.ts. Both functions are the
// "find the latest entry whose time is at or before the cursor" pattern,
// run on every rAF tick — once for the active mark across the whole
// manifest, and (only when the active mark carries `words`) again for the
// active word inside that mark's word list.
//
// Pure on purpose: keeping the bisect outside the Narrator class lets the
// tests pin its edge cases (boundary equality, backward seek, empty input,
// past-EOF) without standing up a DOM or stubbing a Player. The DOM-bound
// "apply the active class" half stays in narrator.ts where it belongs.

import type { Milliseconds } from "./time.ts";

// Structural shape we need: anything carrying a numeric `time` field works.
// `ManifestMark` in narrator.ts satisfies this; the test can satisfy it
// with a `{ time, name }` literal without importing the project type.
export type Timed = { readonly time: Milliseconds };

/**
 * The latest entry in `marks` whose `time` is at or before `tMs`.
 *
 * Inputs must be in ascending `time` order — the manifest emits them that
 * way, and the live mark list never reorders. We break early on the first
 * entry past `tMs` so a long manifest costs O(active-index), not O(N), per
 * tick.
 *
 * Returns `null` when nothing matches (the cursor is before the first mark
 * — common right after `init` on a fresh load).
 */
export function computeActiveMark<T extends Timed>(
  marks: readonly T[],
  tMs: Milliseconds,
): T | null {
  let active: T | null = null;
  for (const m of marks) {
    if (m.time <= tMs) active = m;
    else break;
  }
  return active;
}

// Structural shape for `resolveActiveFigure`: a mark carries its time, the
// leaf `chapter` it belongs to (the sub-chapter boundary key), and the optional
// stage pointer `figure`. `ManifestMark` in narrator.ts satisfies this; the
// unit test satisfies it with a plain literal.
export type FigureStateMark = Timed & {
  readonly chapter: string;
  readonly figure?: string;
  // The per-step slideshow pointer (proposal 50 §4.4), orthogonal to `figure`:
  // which labeled step of the staged figure's journey to drive to. Absent =
  // "no step cue this mark"; "none"/"" clears stepped mode. Resolved into the
  // active step alongside the staged figure by `stagedFigureAt`.
  readonly step?: string;
};

/**
 * The figure on the stage at time `tMs` — the live-page twin of the video
 * renderer's `deriveFigureOccurrences` (generate/render-video.ts), so the page
 * and the video stage the same figure at the same instant by construction.
 *
 * Driven by the `marks[].figure` stage pointer (proposal 50 §4): a `figure` value
 * stages that figure; it is **sticky within a sub-chapter** and **auto-clears
 * at each sub-chapter boundary** (a change in a mark's `chapter`); `figure: ""
 * | "none"` clears it early; an absent attribute leaves the stage unchanged.
 * The active figure at `tMs` is the staged value as of the latest mark at or
 * before `tMs`; the stage defaults to empty.
 *
 * Returns the figure id, or null for an empty stage. Pure + O(active-index)
 * (it scans only up to the active mark), suitable for the rAF tick.
 */
export function resolveActiveFigure<T extends FigureStateMark>(
  marks: readonly T[],
  tMs: Milliseconds,
): string | null {
  return stagedFigureAt(marks, tMs).id;
}

/** The staged figure at time `tMs` AND the start of its current on-stage span. */
export interface StagedFigure {
  /** The figure id on the stage, or null for an empty stage. */
  readonly id: string | null;
  /**
   * The mark time at which `id` was staged — the start of its current on-stage
   * span (the same `[mark.time, …)` span the video renderer derives). null when
   * the stage is empty.
   *
   * The narration driver (proposal 50 §5.1) advances a staged journey by
   * `tMs - sinceMs`, so scrubbing into the *middle* of a staged span resumes
   * the figure mid-animation rather than restarting it from frame 0 — page and
   * video then show the figure at the same point of its journey for the same
   * playhead. Re-stating the *same* figure id mid-span does NOT move `sinceMs`
   * (the span is continuous); a sub-chapter boundary or a different id does.
   */
  readonly sinceMs: Milliseconds | null;
  /**
   * The active step label driving the staged figure (proposal 50 §5.3), or null for
   * none (continuous/free-run mode). It is the latest `step` value set *within
   * the current staged-figure span* (since `sinceMs`); it resets to null
   * whenever the figure id changes or a sub-chapter boundary clears the stage
   * (a step belongs to the figure it was cued on), and `step: "" | "none"`
   * clears it explicitly. The narration driver (proposal 50 §5.3) reads this: a
   * non-null step switches the figure from continuous free-run to "advance to
   * the labeled step's `endMs` and hold."
   */
  readonly step: string | null;
}

/**
 * The staged figure at `tMs`, when its span began, AND the active step cue
 * driving it (proposal 50 §5.3). Same sub-chapter-bounded walk as
 * `resolveActiveFigure` (which delegates here for the id) — see
 * {@link resolveActiveFigure} for the staging model and {@link StagedFigure}
 * for the `step` semantics. Pure + O(active-index), suitable for the rAF tick.
 */
export function stagedFigureAt<T extends FigureStateMark>(
  marks: readonly T[],
  tMs: Milliseconds,
): StagedFigure {
  let cur: string | null = null;
  let since: Milliseconds | null = null;
  let step: string | null = null;
  let prevChapter: string | undefined;
  for (const m of marks) {
    if (m.time > tMs) break;
    if (m.chapter !== prevChapter) {
      cur = null; // a new sub-chapter resets the stage
      since = null;
      step = null; // …and the step cue (it belonged to the cleared figure)
      prevChapter = m.chapter;
    }
    if (m.figure !== undefined) {
      const next = m.figure === "" || m.figure === "none" ? null : m.figure;
      // Only a CHANGE moves the span start — re-stating the same id keeps the
      // span (and so the journey's elapsed clock) continuous.
      if (next !== cur) {
        cur = next;
        since = next === null ? null : m.time;
        step = null; // a new figure id starts in continuous mode (no step yet)
      }
    }
    // The step pointer is evaluated AFTER `figure` so a single mark that both
    // re-stages a figure and names a step (the "re-stage + step in one mark"
    // case, proposal 50 §5.4) records that step rather than having the figure
    // change clear it. `none`/`""` clears stepped mode; an absent attribute
    // leaves the current step unchanged (sticky within the span, like figure).
    if (m.step !== undefined) {
      step = m.step === "" || m.step === "none" ? null : m.step;
    }
  }
  return { id: cur, sinceMs: since, step };
}

/** The seek actions the narration driver applies on one tick (see figureSeekPlan). */
export interface FigureSeekPlan {
  /** Whether to `reset()` the journey to frame 0 before applying `seeks`. */
  readonly reset: boolean;
  /** Absolute journey positions (ms) to `seek()` in order; the last is the target. */
  readonly seeks: number[];
}

/**
 * Plan how to move a figure's journey from its last seeked position to a new
 * target, honoring the forward-only contract (proposal 50 §3.4 rule 3): advance only
 * forward, in steps no coarser than `stepMs` (so every timeline `.call()` is
 * crossed), and reach an *earlier* point only by `reset()` + forward replay —
 * never a backward `seek()`.
 *
 * - `target >= last` → forward: small steps from `last` up to and including `target`.
 * - `target < last` → a loop wrap or a backward scrub: `reset` to frame 0, then
 *   forward-replay up to `target`.
 *
 * Callers compute `target = elapsed % durationMs` so a span that outlasts one
 * play-through loops (the wrap makes `target < last`, which trips `reset`); a
 * fresh claim passes `last = +Infinity` to force the reset-and-sweep-from-0.
 *
 * Pure so the driver's whole seek decision is unit-testable without a browser.
 */
export function figureSeekPlan(
  lastPosMs: number,
  targetPosMs: number,
  stepMs: number,
): FigureSeekPlan {
  const reset = targetPosMs < lastPosMs;
  const from = reset ? 0 : lastPosMs;
  const seeks: number[] = [];
  for (let p = from + stepMs; p < targetPosMs; p += stepMs) seeks.push(p);
  seeks.push(targetPosMs); // land exactly on the target
  return { reset, seeks };
}

// Structural shape we need for `findActiveWord`. `ManifestWord` in
// narrator.ts uses `t` (start) and `d` (duration); both are absolute ms
// in the master track. We only read `t` here — `d` matters for visual
// highlight duration but not for "which word is active right now."
export type WordTimed = { readonly t: Milliseconds };

/**
 * Index of the latest word in `words` whose `t` is at or before `tMs`.
 *
 * Mirrors `computeActiveMark` for the inner-word case. Returns -1 if no
 * word has started yet (the cursor sits in the gap between the segment's
 * `<mark>` time and its first word — possible when forced alignment found
 * a leading silence that the segment-text didn't model).
 *
 * The "last matched word lingers past its own [t, t+d)" behaviour
 * documented in `updateActiveWord` is the DOM-side caller's choice, not
 * this helper's — it just reports "which word's start time has been
 * crossed?", and lets the caller decide whether to clear or hold.
 */
export function findActiveWord<W extends WordTimed>(
  words: readonly W[],
  tMs: Milliseconds,
): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.t <= tMs) idx = i;
    else break;
  }
  return idx;
}
