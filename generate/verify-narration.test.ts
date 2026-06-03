import { test, expect } from "bun:test";
import {
  verifyNarrationManifest,
  REQUIRED_TTS,
  REQUIRED_ALIGNER,
} from "./verify-narration.ts";

// A production-grade manifest: MOSS + Qwen3 alignment, every spoken mark carries
// word-level timing. Individual tests mutate a clone to trigger one failure.
const CLEAN = {
  slug: "demo",
  provenance: { tts: REQUIRED_TTS, voice: "v", aligner: REQUIRED_ALIGNER, alignLanguage: "English", mock: false },
  marks: [
    { name: "a", text: "Hello there.", words: [{ s: 0, e: 5, t: 0, d: 100 }] },
    { name: "b", text: "Second segment.", words: [{ s: 0, e: 6, t: 200, d: 100 }] },
  ],
};
const clone = () => JSON.parse(JSON.stringify(CLEAN));

test("a MOSS + aligned manifest passes", () => {
  expect(verifyNarrationManifest(CLEAN)).toEqual([]);
});

test("flags a missing provenance block (the original regression)", () => {
  const m = clone();
  delete m.provenance;
  expect(verifyNarrationManifest(m).join(" ")).toContain("provenance");
});

test("flags the wrong TTS engine (bare `bun run generate` → espeak-ng)", () => {
  const m = clone();
  m.provenance.tts = "espeak-ng";
  expect(verifyNarrationManifest(m).some((v) => v.includes("tts="))).toBe(true);
});

test("flags a missing aligner", () => {
  const m = clone();
  m.provenance.aligner = null;
  expect(verifyNarrationManifest(m).some((v) => v.includes("aligner="))).toBe(true);
});

test("flags --mock placeholder audio", () => {
  const m = clone();
  m.provenance.mock = true;
  expect(verifyNarrationManifest(m).some((v) => v.includes("--mock"))).toBe(true);
});

test("flags spoken marks that lost their word timing even if provenance looks right", () => {
  const m = clone();
  delete m.marks[1].words;
  const out = verifyNarrationManifest(m);
  expect(out.some((v) => v.includes("no word-level timing"))).toBe(true);
});

test("a whitespace-only mark needs no words", () => {
  const m = clone();
  m.marks.push({ name: "pause", text: "   ", words: [] });
  expect(verifyNarrationManifest(m)).toEqual([]);
});

test("flags a manifest with no marks", () => {
  const m = clone();
  m.marks = [];
  expect(verifyNarrationManifest(m).some((v) => v.includes("no marks"))).toBe(true);
});

test("a non-object manifest is rejected", () => {
  expect(verifyNarrationManifest(null).length).toBeGreaterThan(0);
  expect(verifyNarrationManifest("nope").length).toBeGreaterThan(0);
});
