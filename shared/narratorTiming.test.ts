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
  type FigureStateMark,
  type Timed,
  type WordTimed,
} from "./narratorTiming.ts";

const m = (time: number, name: string): Timed & { name: string } => ({
  time: asMs(time),
  name,
});

const w = (t: number): WordTimed => ({ t: asMs(t) });

// A mark with a chapter + optional figure pointer, for resolveActiveFigure.
const fm = (time: number, chapter: string, figure?: string): FigureStateMark => ({
  time: asMs(time),
  chapter,
  ...(figure !== undefined ? { figure } : {}),
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

// --- resolveActiveFigure (proposal 47) --------------------------------------
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
