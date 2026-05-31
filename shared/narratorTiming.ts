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
