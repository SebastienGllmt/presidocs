// Unit tests for render-video.ts's pure helpers (no ffmpeg/browser needed).
// The ASS karaoke emitter, the caption chunker, the mark-snapping, and the
// time formatter are the content-determining logic; the rest is ffmpeg wiring.

import { test, expect } from "bun:test";
import {
  msToAssTime,
  snapToMark,
  chunkWords,
  buildKaraokeAss,
  computeCuts,
  figureSegmentPlacement,
  deriveFigureOccurrences,
} from "./render-video.ts";

const mk = (name: string, time: number, chapter: string, figure?: string) =>
  ({ name, time, chapter, text: "", ...(figure !== undefined ? { figure } : {}) }) as never;

test("msToAssTime formats H:MM:SS.cc and floors centiseconds", () => {
  expect(msToAssTime(0)).toBe("0:00:00.00");
  expect(msToAssTime(1500)).toBe("0:00:01.50");
  expect(msToAssTime(61230)).toBe("0:01:01.23");
  expect(msToAssTime(3661000)).toBe("1:01:01.00");
  expect(msToAssTime(999)).toBe("0:00:00.99"); // floors — never rolls cc to 100
});

test("snapToMark snaps forward to the next mark boundary (never clips mid-word)", () => {
  const marks = [{ time: 0 }, { time: 1100 }, { time: 3050 }] as never[];
  expect(snapToMark(marks, 2000)).toBe(3050);
  expect(snapToMark(marks, 500)).toBe(1100);
  expect(snapToMark(marks, 9999)).toBe(3050); // past the last boundary → the last one
});

test("chunkWords splits captions by word cap and char budget", () => {
  const text = "w1 w2 w3 w4 w5";
  const words = [0, 3, 6, 9, 12].map((s, i) => ({ s, e: s + 2, t: i * 100, d: 100 }));
  expect(chunkWords(words, text, 100, 2).map((g) => g.length)).toEqual([2, 2, 1]);
  expect(chunkWords(words, text, 5, 100).length).toBe(5); // each ~3-char token overflows a 5-char budget
});

test("buildKaraokeAss emits an ASS doc with per-word karaoke (\\k) timing", () => {
  const marks = [
    { name: "m", time: 0, chapter: "c", text: "Hi there", words: [
      { s: 0, e: 2, t: 0, d: 400 },
      { s: 3, e: 8, t: 400, d: 600 },
    ] },
  ];
  const ass = buildKaraokeAss(marks, 0, 2000);
  expect(ass).toContain("[Script Info]");
  expect(ass).toContain("[Events]");
  expect(ass).toContain("Dialogue:");
  expect(ass).toContain("\\k"); // karaoke timing tags
  expect(ass).toContain("Hi");
  expect(ass).toContain("there");
});

test("buildKaraokeAss applies the time map (a narration hold shifts captions later)", () => {
  const marks = [{ name: "m", time: 0, chapter: "c", text: "Hi", words: [{ s: 0, e: 2, t: 0, d: 400 }] }];
  const ass = buildKaraokeAss(marks, 0, 2000, undefined, (a) => a + 1000);
  expect(ass).toContain("0:00:01.00"); // dialogue start rebased +1000ms by the map
});

test("buildKaraokeAss drops words outside the [t0,t1] span", () => {
  const marks = [
    { name: "m", time: 0, chapter: "c", text: "in out", words: [
      { s: 0, e: 2, t: 500, d: 200 }, // inside [1000,2000)? no — before t0
      { s: 3, e: 6, t: 1500, d: 200 }, // inside
    ] },
  ];
  const ass = buildKaraokeAss(marks, 1000, 2000);
  // Only the second word ("out") survives; the dialogue exists and is rebased.
  expect(ass).toContain("out");
  expect(ass).toContain("Dialogue:");
});

// --- layered renderer: segment cut planning ---------------------------------

test("computeCuts places a cut just after each chapter slide settles (in dwell)", () => {
  // Opening slide [0,3], then chapter slides centred ~at 60s and ~120s. Each
  // slide window is [boundary-0.5, boundary+2.5]; the cut lands gap (1s) later.
  const slides = [
    { vStart: 0, vEnd: 3 },
    { vStart: 59.5, vEnd: 62.5 },
    { vStart: 119.5, vEnd: 122.5 },
  ];
  expect(computeCuts(slides, 180)).toEqual([63.5, 123.5]);
  // No cut before the opening (intro) slide.
  expect(computeCuts([{ vStart: 0, vEnd: 3 }], 60)).toEqual([]);
});

test("computeCuts merges chapters too short for a clean dwell cut", () => {
  // Three slides packed within minSeg of each other → at most one usable cut.
  const slides = [
    { vStart: 0, vEnd: 3 },
    { vStart: 4, vEnd: 7 }, // cut would be 8, but next slide starts at 9 (< 8+? ok) — kept
    { vStart: 9, vEnd: 12 }, // cut 13, but 13 < lastCut(8)+minSeg(5)=13 is false → merged
  ];
  expect(computeCuts(slides, 60)).toEqual([8]);
});

test("computeCuts never cuts inside the final tail", () => {
  const slides = [
    { vStart: 0, vEnd: 3 },
    { vStart: 50, vEnd: 53 }, // cut 54, but total 55 → 54 > 55-3 → dropped
  ];
  expect(computeCuts(slides, 55)).toEqual([]);
});

// --- layered renderer: figure placement inside a segment --------------------

test("figureSegmentPlacement: a still holds, with local enable window", () => {
  const layer = { vStart: 10, vEnd: 20, mode: "still" as const, clipSec: 0 };
  expect(figureSegmentPlacement(layer, 8, 25)).toEqual({
    enableStart: 2, // 10 - 8
    enableEnd: 12, // 20 - 8
    ss: null,
    delay: null,
    loop: false,
  });
  expect(figureSegmentPlacement(layer, 30, 40)).toBeNull(); // no intersection
});

test("figureSegmentPlacement: a clip already playing at the cut is seeked (-ss)", () => {
  // once-clip starts at 10, segment starts at 13 → 3s already elapsed.
  const once = { vStart: 10, vEnd: 25, mode: "once" as const, clipSec: 15 };
  expect(figureSegmentPlacement(once, 13, 40)).toEqual({
    enableStart: 0,
    enableEnd: 12, // 25 - 13
    ss: 3, // seek 3s into the clip
    delay: null,
    loop: false,
  });
  // a loop seeks MODULO the clip length, so the loop phase stays aligned.
  const loop = { vStart: 10, vEnd: 100, mode: "loop" as const, clipSec: 4 };
  const p = figureSegmentPlacement(loop, 23, 40)!; // 13s elapsed, 13 % 4 = 1
  expect(p.loop).toBe(true);
  expect(p.ss).toBeCloseTo(1, 9);
});

test("figureSegmentPlacement: a clip starting mid-segment is delayed (setpts)", () => {
  const once = { vStart: 30, vEnd: 45, mode: "once" as const, clipSec: 15 };
  expect(figureSegmentPlacement(once, 25, 60)).toEqual({
    enableStart: 5, // 30 - 25
    enableEnd: 20, // 45 - 25
    ss: null,
    delay: 5, // shift clip to start at local 5s
    loop: false,
  });
});

// --- figure occurrence derivation (proposal 47 stage pointer) ----------------

test("deriveFigureOccurrences: lead-up staging + sticky within a sub-chapter", () => {
  // figure staged on the lead-up mark (500), carries across a no-attr mark, ends at the next change.
  const marks = [
    mk("lead", 500, "c1", "fig-a"),
    mk("more", 1500, "c1"), // unchanged → fig-a still staged
    mk("switch", 4000, "c1", "fig-b"),
  ];
  expect(deriveFigureOccurrences(marks, 0, 10000, 10000)).toEqual([
    { id: "fig-a", startMs: 500, visEndMs: 4000 },
    { id: "fig-b", startMs: 4000, visEndMs: 10000 },
  ]);
});

test("deriveFigureOccurrences: auto-clears at a sub-chapter boundary", () => {
  // fig-a staged in c1; c2 begins with nothing staged → stage clears at the boundary (3000).
  const marks = [mk("a", 1000, "c1", "fig-a"), mk("b", 3000, "c2"), mk("c", 5000, "c2")];
  expect(deriveFigureOccurrences(marks, 0, 10000, 10000)).toEqual([
    { id: "fig-a", startMs: 1000, visEndMs: 3000 },
  ]);
});

test("deriveFigureOccurrences: figure='none' clears early", () => {
  const marks = [mk("a", 1000, "c1", "fig-a"), mk("off", 2000, "c1", "none"), mk("c", 3000, "c1")];
  expect(deriveFigureOccurrences(marks, 0, 10000, 10000)).toEqual([
    { id: "fig-a", startMs: 1000, visEndMs: 2000 },
  ]);
});

test("deriveFigureOccurrences: the stage defaults to empty (a bare name never auto-stages)", () => {
  // No `figure` pointer anywhere → nothing is staged, even though "fig-b" is
  // also a figure id. Staging is driven solely by the pointer (proposal 47).
  const marks = [mk("x", 0, "c1"), mk("fig-b", 2000, "c1")];
  expect(deriveFigureOccurrences(marks, 0, 5000, 5000)).toEqual([]);
});
