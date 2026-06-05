// Unit tests for buildLoopingJourney — the trailing-dwell wrapper that makes a
// figure's loop pause (its in-page free-run LOOP_GAP) survive into the drivers
// that loop by durationMs (offline video compositor, in-page narration driver).
// Pure: no GSAP / DOM, driven by plain values.

import { test, expect } from "bun:test";
import { buildLoopingJourney } from "./figureAnimation.ts";

const noop = () => {};

test("buildLoopingJourney — durationMs and the last step both include the loop gap", () => {
  const j = buildLoopingJourney({
    playMs: 2000,
    labels: { start: 0, mid: 1 },
    loopGapMs: 500,
    seek: noop,
    reset: noop,
  });
  // 2.0s play-through + 0.5s dwell = 2.5s.
  expect(j.durationMs).toBe(2500);
  // Invariant preserved: the last step's endMs equals the extended durationMs,
  // so the final label segment simply spans the dwell.
  expect(j.steps.at(-1)!.endMs).toBeCloseTo(2500, 6);
});

test("buildLoopingJourney — seek clamps into the play-through, holding the final frame across the dwell tail", () => {
  const seen: number[] = [];
  const j = buildLoopingJourney({
    playMs: 2000,
    labels: {},
    loopGapMs: 500,
    seek: (ms) => seen.push(ms),
    reset: noop,
  });
  j.seek(1000); // mid play-through → 1000
  j.seek(2300); // inside the dwell tail (2000–2500) → clamped to 2000
  expect(seen).toEqual([1000, 2000]);
});

test("buildLoopingJourney — reset is passed through unchanged", () => {
  let called = 0;
  const j = buildLoopingJourney({
    playMs: 2000,
    labels: {},
    loopGapMs: 500,
    seek: noop,
    reset: () => { called += 1; },
  });
  j.reset();
  expect(called).toBe(1);
});
