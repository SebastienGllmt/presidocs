// Tests for the WebVTT sidecar emitter. Validates the timestamp format, the
// intra-cue tag interleaving, escaping, and the "skip when no alignment"
// rule that keeps pre-alignment builds byte-for-byte unchanged.

import { test, expect } from "bun:test";
import { buildVtt, hasAlignment, msToVttTime } from "./webvtt.ts";
import { asMs } from "../shared/time.ts";

test("msToVttTime: zero, sub-second, hour boundaries", () => {
  expect(msToVttTime(asMs(0))).toBe("00:00:00.000");
  expect(msToVttTime(asMs(7))).toBe("00:00:00.007");
  expect(msToVttTime(asMs(1500))).toBe("00:00:01.500");
  expect(msToVttTime(asMs(61_000))).toBe("00:01:01.000");
  expect(msToVttTime(asMs(3_600_000))).toBe("01:00:00.000");
  expect(msToVttTime(asMs(3_723_456))).toBe("01:02:03.456");
});

test("msToVttTime: negative input clamps to 0", () => {
  expect(msToVttTime(asMs(-50))).toBe("00:00:00.000");
});

test("buildVtt: header + one cue per mark with intra-cue word tags", () => {
  const out = buildVtt({
    marks: [
      {
        name: "intro-1",
        time: asMs(0),
        text: "Hash functions are everywhere.",
        words: [
          { s: 0, e: 4, t: asMs(0), d: asMs(300) },
          { s: 5, e: 14, t: asMs(300), d: asMs(400) },
          { s: 15, e: 18, t: asMs(700), d: asMs(180) },
          { s: 19, e: 30, t: asMs(880), d: asMs(590) },
        ],
      },
    ],
    duration: asMs(1500),
  });
  expect(out.startsWith("WEBVTT\n")).toBe(true);
  expect(out).toContain("intro-1");
  expect(out).toContain("00:00:00.000 --> 00:00:01.470");
  expect(out).toContain(
    "<00:00:00.000>Hash <00:00:00.300>functions <00:00:00.700>are <00:00:00.880>everywhere.",
  );
});

test("buildVtt: marks without words emit plain cue text (no tags)", () => {
  const out = buildVtt({
    marks: [
      { name: "a", time: asMs(0), text: "first segment" },
      { name: "b", time: asMs(2000), text: "second segment" },
    ],
    duration: asMs(4000),
  });
  // First cue end falls back to next mark's start.
  expect(out).toContain("00:00:00.000 --> 00:00:02.000");
  expect(out).toContain("\nfirst segment\n");
  // Last cue end falls back to total duration.
  expect(out).toContain("00:00:02.000 --> 00:00:04.000");
  expect(out).toContain("\nsecond segment\n");
  // No intra-cue timestamp tags anywhere — those only appear with words[].
  expect(out).not.toMatch(/<\d{2}:\d{2}:\d{2}\.\d{3}>/);
});

test("buildVtt: escapes &, <, > in word text and gap text", () => {
  const out = buildVtt({
    marks: [
      {
        name: "esc",
        time: asMs(0),
        // The text "A & <B>" has & at idx 2 and "<B>" at idx 4-7. We mark
        // "A" and "B>" as aligned words, so "&" sits in the gap and "<B>"
        // overlaps a word; all three special characters must be escaped.
        text: "A & <B>",
        words: [
          { s: 0, e: 1, t: asMs(0), d: asMs(100) },
          { s: 4, e: 7, t: asMs(100), d: asMs(200) },
        ],
      },
    ],
    duration: asMs(500),
  });
  expect(out).toContain("&amp;");
  expect(out).toContain("&lt;B&gt;");
  expect(out).not.toContain("A & <B>");
});

test("buildVtt: skips degenerate zero-duration cues", () => {
  const out = buildVtt({
    marks: [
      { name: "real", time: asMs(0), text: "real cue" },
      // Same time as the next mark would compute a zero duration; but here
      // we contrive the "duration" being equal to the only mark's time, so
      // its fallback end equals its start and it's skipped.
      { name: "zero", time: asMs(500) },
    ],
    duration: asMs(500),
  });
  expect(out).toContain("real");
  expect(out).not.toContain("\nzero\n");
});

test("buildVtt: sanitizes a cue id that would otherwise collide with the timestamp marker", () => {
  const out = buildVtt({
    marks: [{ name: "weird-->id", time: asMs(0), text: "x" }],
    duration: asMs(100),
  });
  expect(out).toContain("weird--&gt;id");
  expect(out).not.toContain("weird-->id");
});

test("hasAlignment: true iff any mark has a non-empty words array", () => {
  expect(hasAlignment([])).toBe(false);
  expect(hasAlignment([{ name: "a", time: asMs(0), text: "x" }])).toBe(false);
  expect(
    hasAlignment([{ name: "a", time: asMs(0), text: "x", words: [] }]),
  ).toBe(false);
  expect(
    hasAlignment([
      { name: "a", time: asMs(0), text: "x" },
      { name: "b", time: asMs(1), text: "y", words: [{ s: 0, e: 1, t: asMs(0), d: asMs(10) }] },
    ]),
  ).toBe(true);
});

test("buildVtt: cue end is last word's t+d, not the next mark's time", () => {
  // Words finish at 0.500s; next mark is at 2.000s. The cue should end at
  // 0.500s so the karaoke renderer doesn't hold the highlight on the
  // final word through 1.5s of silence.
  const out = buildVtt({
    marks: [
      {
        name: "a",
        time: asMs(0),
        text: "hi there",
        words: [
          { s: 0, e: 2, t: asMs(0), d: asMs(200) },
          { s: 3, e: 8, t: asMs(300), d: asMs(200) },
        ],
      },
      { name: "b", time: asMs(2000), text: "next" },
    ],
    duration: asMs(3000),
  });
  expect(out).toContain("00:00:00.000 --> 00:00:00.500");
});
