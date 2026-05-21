// Tests for chapter → segment splitting and the paragraph-derived
// `continuesPrevious` signal (see methodology.md, "Cross-segment continuity").
// The signal must key off blank
// lines (paragraph breaks), NOT the soft single-newline wrapping authors use
// for readability.

import { test, expect } from "bun:test";
import { splitChapter, type Segment } from "./narration.ts";

const flags = (segs: Segment[]) => segs.map((s) => s.continuesPrevious);
const names = (segs: Segment[]) => segs.map((s) => s.markName);

test("splits at <mark> and captures text + names", () => {
  const segs = splitChapter(`<mark name="a"/> First. <mark name="b"/> Second.`);
  expect(names(segs)).toEqual(["a", "b"]);
  expect(segs.map((s) => s.text)).toEqual(["First.", "Second."]);
});

test("first segment of a chapter is always a fresh start", () => {
  const segs = splitChapter(`<mark name="a"/> Only one.`);
  expect(segs[0]!.continuesPrevious).toBe(false);
});

test("consecutive marks with soft line wraps all continue (no blank lines)", () => {
  // Mirrors the real authoring style: marks on their own line, prose wrapped
  // across single newlines. None of these are paragraph breaks.
  const chapter = `
  <mark name="title"/>
  Hi everyone, and welcome to today's
  mini-talk.
  <mark name="lede"/>
  In the next few minutes I want to
  demystify the hash function.
`;
  const segs = splitChapter(chapter);
  expect(names(segs)).toEqual(["title", "lede"]);
  // title = fresh (first), lede = continuation (only a single-newline gap).
  expect(flags(segs)).toEqual([false, true]);
});

test("a blank line before a mark forces a fresh start", () => {
  const chapter = `
  <mark name="a"/>
  Sentence one.

  <mark name="b"/>
  Sentence two, new paragraph.
  <mark name="c"/>
  Sentence three, same paragraph as two.
`;
  const segs = splitChapter(chapter);
  expect(names(segs)).toEqual(["a", "b", "c"]);
  // a: fresh (first). b: fresh (blank line before it). c: continues b.
  expect(flags(segs)).toEqual([false, false, true]);
});

test("a blank line of just whitespace (spaces/tabs on the empty line) still counts", () => {
  const chapter = `<mark name="a"/> One.\n \t \n<mark name="b"/> Two.`;
  const segs = splitChapter(chapter);
  expect(flags(segs)).toEqual([false, false]);
});

test("leading text before the first mark doesn't create a phantom continuation", () => {
  // The whitespace-only slice before the first mark must not be emitted, and
  // must not flip the first real segment to a continuation.
  const segs = splitChapter(`\n\n   <mark name="a"/> Hello.`);
  expect(names(segs)).toEqual(["a"]);
  expect(segs[0]!.continuesPrevious).toBe(false);
});

test("each chapter is split independently (caller loops chapters)", () => {
  // Two separate splitChapter calls => each first segment is fresh, so a
  // chapter boundary is always a fresh start by construction.
  const c1 = splitChapter(`<mark name="a"/> A. <mark name="b"/> B.`);
  const c2 = splitChapter(`<mark name="c"/> C.`);
  expect(c1[0]!.continuesPrevious).toBe(false);
  expect(c2[0]!.continuesPrevious).toBe(false);
});
