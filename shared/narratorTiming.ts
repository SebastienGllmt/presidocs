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
};

/**
 * The figure on the stage at time `tMs` — the live-page twin of the video
 * renderer's `deriveFigureOccurrences` (generate/render-video.ts), so the page
 * and the video stage the same figure at the same instant by construction.
 *
 * Driven by the `marks[].figure` stage pointer (proposal 47): a `figure` value
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
  // Walk the staged figure up to `tMs`, resetting the stage at every
  // sub-chapter boundary and applying each mark's pointer.
  let cur: string | null = null;
  let prevChapter: string | undefined;
  for (const m of marks) {
    if (m.time > tMs) break;
    if (m.chapter !== prevChapter) {
      cur = null; // a new sub-chapter resets the stage
      prevChapter = m.chapter;
    }
    if (m.figure !== undefined) {
      cur = m.figure === "" || m.figure === "none" ? null : m.figure;
    }
  }
  return cur;
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
