// Exhaustive edge-case coverage for the rAF-tick math. Both helpers run
// on every frame, so a regression here would be felt as wrong-highlight
// across every post simultaneously; a fast unit-test layer is worth more
// than its weight in tests.

import { test, expect } from "bun:test";

import { asMs } from "./time.ts";
import {
  computeActiveMark,
  findActiveWord,
  resolveActiveFigure,
  stagedFigureAt,
  figureSeekPlan,
  type FigureStateMark,
  type Timed,
  type WordTimed,
} from "./narratorTiming.ts";

const m = (time: number, name: string): Timed & { name: string } => ({
  time: asMs(time),
  name,
});

const w = (t: number): WordTimed => ({ t: asMs(t) });

// A mark with a chapter + optional figure / step pointers, for
// resolveActiveFigure / stagedFigureAt.
const fm = (
  time: number,
  chapter: string,
  figure?: string,
  step?: string,
): FigureStateMark => ({
  time: asMs(time),
  chapter,
  ...(figure !== undefined ? { figure } : {}),
  ...(step !== undefined ? { step } : {}),
});

test("computeActiveMark — null when cursor is before the first mark", () => {
  const marks = [m(1000, "a"), m(2000, "b")];
  expect(computeActiveMark(marks, asMs(0))).toBeNull();
  expect(computeActiveMark(marks, asMs(999))).toBeNull();
});

test("computeActiveMark — exact-boundary inclusion (t === mark.time)", () => {
  const marks = [m(1000, "a"), m(2000, "b")];
  // The boundary belongs to the new mark: at t=1000 we're inside "a", at
  // t=2000 we've crossed into "b". This matches updateActive()'s `<=`.
  expect(computeActiveMark(marks, asMs(1000))?.name).toBe("a");
  expect(computeActiveMark(marks, asMs(2000))?.name).toBe("b");
});

test("computeActiveMark — backward seek is correct (no advancing index)", () => {
  const marks = [m(0, "intro"), m(1000, "a"), m(2000, "b"), m(3000, "c")];
  expect(computeActiveMark(marks, asMs(2500))?.name).toBe("b");
  expect(computeActiveMark(marks, asMs(500))?.name).toBe("intro");
  expect(computeActiveMark(marks, asMs(0))?.name).toBe("intro");
});

test("computeActiveMark — past-EOF returns the last mark", () => {
  const marks = [m(0, "a"), m(1000, "b")];
  expect(computeActiveMark(marks, asMs(60_000))?.name).toBe("b");
});

test("computeActiveMark — empty manifest is null, not throw", () => {
  expect(computeActiveMark([], asMs(1000))).toBeNull();
});

test("computeActiveMark — coincident marks pick the last one (stable iteration)", () => {
  // Two marks at the same time can happen when a chapter boundary lands
  // on an existing mark; the manifest's order decides the winner.
  const marks = [m(1000, "first-at-1000"), m(1000, "second-at-1000")];
  expect(computeActiveMark(marks, asMs(1000))?.name).toBe("second-at-1000");
});

test("findActiveWord — -1 before the first word", () => {
  const words = [w(100), w(200)];
  expect(findActiveWord(words, asMs(0))).toBe(-1);
  expect(findActiveWord(words, asMs(99))).toBe(-1);
});

test("findActiveWord — exact boundaries advance the index", () => {
  const words = [w(100), w(200), w(300)];
  expect(findActiveWord(words, asMs(100))).toBe(0);
  expect(findActiveWord(words, asMs(200))).toBe(1);
  expect(findActiveWord(words, asMs(300))).toBe(2);
});

test("findActiveWord — past the last word stays on the last index (linger)", () => {
  // The DOM caller relies on this "stay on last" behaviour to keep the
  // karaoke highlight on the trailing word during the post-utterance
  // silence; see the `updateActiveWord` comment.
  const words = [w(100), w(200)];
  expect(findActiveWord(words, asMs(5_000))).toBe(1);
});

test("findActiveWord — backward seek does NOT stick on the prior index", () => {
  // The pure helper must recompute every call (no internal state). The
  // DOM caller short-circuits when (markName, index) is unchanged; the
  // index itself has to be correct on backward seek for that check to
  // work.
  const words = [w(100), w(200), w(300)];
  expect(findActiveWord(words, asMs(290))).toBe(1);
  expect(findActiveWord(words, asMs(50))).toBe(-1);
});

test("findActiveWord — empty words is -1, not throw", () => {
  expect(findActiveWord([], asMs(1000))).toBe(-1);
});

// --- resolveActiveFigure (proposal 50 §4) --------------------------------------
// "Which figure is on the stage at time t" — the live-page twin of the video
// renderer's deriveFigureOccurrences. Each case probes the SAME datasets the
// renderer's unit tests use (generate/render-video.test.ts), so the two must
// agree by construction: the active figure at t equals the renderer span that
// contains t.

test("resolveActiveFigure — lead-up staging, sticky within a sub-chapter", () => {
  const marks = [fm(500, "c1", "fig-a"), fm(1500, "c1"), fm(4000, "c1", "fig-b")];
  expect(resolveActiveFigure(marks, asMs(0))).toBeNull(); // before the lead-up
  expect(resolveActiveFigure(marks, asMs(500))).toBe("fig-a");
  expect(resolveActiveFigure(marks, asMs(2000))).toBe("fig-a"); // carried across the no-attr mark
  expect(resolveActiveFigure(marks, asMs(4000))).toBe("fig-b");
  expect(resolveActiveFigure(marks, asMs(9000))).toBe("fig-b");
});

test("resolveActiveFigure — auto-clears at a sub-chapter boundary", () => {
  const marks = [fm(1000, "c1", "fig-a"), fm(3000, "c2"), fm(5000, "c2")];
  expect(resolveActiveFigure(marks, asMs(2000))).toBe("fig-a");
  expect(resolveActiveFigure(marks, asMs(3000))).toBeNull(); // boundary resets the stage
  expect(resolveActiveFigure(marks, asMs(6000))).toBeNull();
});

test('resolveActiveFigure — figure="none" clears early', () => {
  const marks = [fm(1000, "c1", "fig-a"), fm(2000, "c1", "none"), fm(3000, "c1")];
  expect(resolveActiveFigure(marks, asMs(1500))).toBe("fig-a");
  expect(resolveActiveFigure(marks, asMs(2000))).toBeNull(); // cleared
  expect(resolveActiveFigure(marks, asMs(3500))).toBeNull(); // stays clear
});

test('resolveActiveFigure — figure="" also clears', () => {
  const marks = [fm(1000, "c1", "fig-a"), fm(2000, "c1", "")];
  expect(resolveActiveFigure(marks, asMs(1500))).toBe("fig-a");
  expect(resolveActiveFigure(marks, asMs(2500))).toBeNull();
});

test("resolveActiveFigure — the stage defaults to empty (no pointer → no figure)", () => {
  const marks = [fm(0, "c1"), fm(2000, "c1")];
  expect(resolveActiveFigure(marks, asMs(3000))).toBeNull();
});

test("resolveActiveFigure — empty marks is null, not throw", () => {
  expect(resolveActiveFigure([], asMs(1000))).toBeNull();
});

// --- stagedFigureAt (proposal 50 §5.1 mid-span resume) ---------------------------
// Same staging walk as resolveActiveFigure, but also reports WHEN the current
// span began (`sinceMs`) so the narration driver can advance the journey by
// `tMs - sinceMs` and resume mid-animation on a scrub. `.id` must always agree
// with resolveActiveFigure (which delegates here).

test("stagedFigureAt — sinceMs is the staging mark, carried across no-attr marks", () => {
  const marks = [fm(500, "c1", "fig-a"), fm(1500, "c1"), fm(4000, "c1", "fig-b")];
  expect(stagedFigureAt(marks, asMs(2000))).toEqual({ id: "fig-a", sinceMs: asMs(500), step: null });
  // Carried by the attr-less mark at 1500 — the span still starts at 500.
  expect(stagedFigureAt(marks, asMs(4000))).toEqual({ id: "fig-b", sinceMs: asMs(4000), step: null });
});

test("stagedFigureAt — empty stage reports null since", () => {
  const marks = [fm(0, "c1"), fm(1000, "c1", "none")];
  expect(stagedFigureAt(marks, asMs(0))).toEqual({ id: null, sinceMs: null, step: null });
  expect(stagedFigureAt(marks, asMs(1000))).toEqual({ id: null, sinceMs: null, step: null });
});

test("stagedFigureAt — a sub-chapter boundary restarts the span", () => {
  // fig-a rides into c2 only if re-stated; here c2 re-stages it, so the span
  // restarts at the boundary mark (matches the renderer's per-sub-chapter span).
  const marks = [fm(1000, "c1", "fig-a"), fm(3000, "c2", "fig-a")];
  expect(stagedFigureAt(marks, asMs(2000))).toEqual({ id: "fig-a", sinceMs: asMs(1000), step: null });
  expect(stagedFigureAt(marks, asMs(3500))).toEqual({ id: "fig-a", sinceMs: asMs(3000), step: null });
});

test("stagedFigureAt — re-stating the same id mid-span does NOT move sinceMs", () => {
  const marks = [fm(1000, "c1", "fig-a"), fm(2000, "c1", "fig-a")];
  // Continuous span — the journey clock must not jump back to 2000.
  expect(stagedFigureAt(marks, asMs(2500))).toEqual({ id: "fig-a", sinceMs: asMs(1000), step: null });
});

test("stagedFigureAt — .id always matches resolveActiveFigure", () => {
  const marks = [fm(500, "c1", "fig-a"), fm(1500, "c1", "none"), fm(2500, "c2", "fig-b")];
  for (const t of [0, 500, 1000, 1500, 2000, 2500, 9000]) {
    expect(stagedFigureAt(marks, asMs(t)).id).toBe(resolveActiveFigure(marks, asMs(t)));
  }
});

// --- stagedFigureAt: the step pointer (proposal 50 §5.3) -------------------------
// `step` is the latest label set within the current staged-figure span. It is
// sticky like `figure`, resets on a figure-id change or a sub-chapter boundary,
// and is cleared by `step="none"`/`""`. The driver reads it to switch the
// staged figure from continuous free-run to advance-to-step-and-hold.

test("stagedFigureAt — step set on the staging mark (re-stage + step in one mark)", () => {
  const marks = [fm(500, "c1", "fig-a", "phase-a")];
  expect(stagedFigureAt(marks, asMs(600))).toEqual({
    id: "fig-a",
    sinceMs: asMs(500),
    step: "phase-a",
  });
});

test("stagedFigureAt — step is carried across attr-less marks (sticky in the span)", () => {
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(1500, "c1")];
  // The attr-less mark leaves both figure and step unchanged.
  expect(stagedFigureAt(marks, asMs(2000))).toEqual({
    id: "fig-a",
    sinceMs: asMs(500),
    step: "phase-a",
  });
});

test("stagedFigureAt — a later mark advances the step (figure carried, step only)", () => {
  // step without figure drives the carried figure (proposal 50 §5.4).
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c1", undefined, "phase-b")];
  expect(stagedFigureAt(marks, asMs(1000)).step).toBe("phase-a");
  expect(stagedFigureAt(marks, asMs(2000))).toEqual({
    id: "fig-a", // unchanged — only the step advanced
    sinceMs: asMs(500),
    step: "phase-b",
  });
});

test('stagedFigureAt — step="none" clears stepped mode (back to continuous)', () => {
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c1", undefined, "none")];
  expect(stagedFigureAt(marks, asMs(1000)).step).toBe("phase-a");
  // Figure stays staged; only the step is cleared (figure unchanged).
  expect(stagedFigureAt(marks, asMs(2500))).toEqual({
    id: "fig-a",
    sinceMs: asMs(500),
    step: null,
  });
});

test('stagedFigureAt — step="" also clears stepped mode', () => {
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c1", undefined, "")];
  expect(stagedFigureAt(marks, asMs(2500)).step).toBeNull();
});

test("stagedFigureAt — a figure-id change resets the step (step belongs to its figure)", () => {
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c1", "fig-b")];
  expect(stagedFigureAt(marks, asMs(1000)).step).toBe("phase-a");
  // Staging a different figure with no step starts it in continuous mode.
  expect(stagedFigureAt(marks, asMs(2500))).toEqual({
    id: "fig-b",
    sinceMs: asMs(2000),
    step: null,
  });
});

test("stagedFigureAt — a sub-chapter boundary clears the step", () => {
  // fig-a re-stated in c2 (so the figure rides on), but a boundary clears the
  // step — a forgotten step cue can't bleed across a section.
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c2", "fig-a")];
  expect(stagedFigureAt(marks, asMs(1000)).step).toBe("phase-a");
  expect(stagedFigureAt(marks, asMs(2500))).toEqual({
    id: "fig-a",
    sinceMs: asMs(2000), // span restarts at the boundary
    step: null, // …and the step is cleared
  });
});

test("stagedFigureAt — re-stating the same figure id keeps the step (continuous span)", () => {
  // Same id re-stated mid-span does not move sinceMs and must not drop the step.
  const marks = [fm(500, "c1", "fig-a", "phase-a"), fm(2000, "c1", "fig-a")];
  expect(stagedFigureAt(marks, asMs(2500))).toEqual({
    id: "fig-a",
    sinceMs: asMs(500),
    step: "phase-a",
  });
});

// --- figureSeekPlan (proposal 50 §5.1 forward-only advance) ----------------------
// The driver's whole seek decision, made pure. Step = 10 in these cases for
// readable grids; the driver passes 1000/30.

test("figureSeekPlan — a small forward step is a single seek, no reset", () => {
  // delta (4) < step (10): land straight on the target.
  expect(figureSeekPlan(100, 104, 10)).toEqual({ reset: false, seeks: [104] });
});

test("figureSeekPlan — a large forward jump is broken into <=step increments", () => {
  // e.g. a stalled/backgrounded tab resuming: never a coarse jump (rule 3).
  expect(figureSeekPlan(100, 135, 10)).toEqual({ reset: false, seeks: [110, 120, 130, 135] });
});

test("figureSeekPlan — a loop wrap (target < last) resets and replays from 0", () => {
  // elapsed % dur wrapped past the end → reset() then forward to the small target.
  expect(figureSeekPlan(990, 12, 10)).toEqual({ reset: true, seeks: [10, 12] });
});

test("figureSeekPlan — a fresh claim (last = +Infinity) resets and sweeps from 0", () => {
  expect(figureSeekPlan(Number.POSITIVE_INFINITY, 25, 10)).toEqual({
    reset: true,
    seeks: [10, 20, 25],
  });
});

test("figureSeekPlan — claim at offset 0 just resets and holds frame 0", () => {
  expect(figureSeekPlan(Number.POSITIVE_INFINITY, 0, 10)).toEqual({ reset: true, seeks: [0] });
});

test("figureSeekPlan — no movement re-seeks the same position (idempotent)", () => {
  expect(figureSeekPlan(100, 100, 10)).toEqual({ reset: false, seeks: [100] });
});

test("figureSeekPlan — the last seek always lands exactly on the target", () => {
  for (const [last, target] of [[0, 33], [100, 100], [990, 5], [7, 200]] as const) {
    expect(figureSeekPlan(last, target, 1000 / 30).seeks.at(-1)).toBe(target);
  }
});
