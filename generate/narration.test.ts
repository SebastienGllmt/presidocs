// Tests for chapter → segment splitting and the paragraph-derived
// `continuesPrevious` signal (see methodology.md, "Cross-segment continuity").
// The signal must key off blank
// lines (paragraph breaks), NOT the soft single-newline wrapping authors use
// for readability.

import { test, expect } from "bun:test";
import { extractNarration, splitChapter, type Segment } from "./narration.ts";

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

// --- figure / step pointers (proposal 47) -----------------------------------
// The new attributes ride alongside `name` on the same `<mark>`; a mark that
// omits them yields `null` (= "leave the stage unchanged").

test("a mark with no figure/step pointer yields null for both (legacy mark)", () => {
  const segs = splitChapter(`<mark name="a"/> Text.`);
  expect(segs[0]!.figure).toBeNull();
  expect(segs[0]!.step).toBeNull();
  // The original (name, text, continuesPrevious) contract is untouched.
  expect(segs[0]!.markName).toBe("a");
});

test("captures a figure pointer distinct from the highlight name", () => {
  const segs = splitChapter(`<mark name="lead-para" figure="anatomy-figure"/> Setting it up.`);
  expect(segs[0]!.markName).toBe("lead-para");
  expect(segs[0]!.figure).toBe("anatomy-figure");
  expect(segs[0]!.step).toBeNull();
});

test('figure="none" is captured verbatim as an explicit clear', () => {
  const segs = splitChapter(`<mark name="wrap" figure="none"/> Clear the stage.`);
  expect(segs[0]!.figure).toBe("none");
});

test('figure="" (empty) is captured as "" — an explicit clear, distinct from absent', () => {
  const segs = splitChapter(`<mark name="wrap" figure=""/> Clear the stage.`);
  expect(segs[0]!.figure).toBe("");
});

test("attributes parse in any order (figure before name)", () => {
  const segs = splitChapter(`<mark figure="merge-figure" name="merge-step"/> Switch.`);
  expect(segs[0]!.markName).toBe("merge-step");
  expect(segs[0]!.figure).toBe("merge-figure");
});

test("captures all three pointers (name, figure, step) in mixed order", () => {
  const segs = splitChapter(`<mark step="settled" figure="lifecycle-figure" name="para"/> Drive it.`);
  expect(segs[0]!.markName).toBe("para");
  expect(segs[0]!.figure).toBe("lifecycle-figure");
  expect(segs[0]!.step).toBe("settled");
});

test("figure pointer survives single-quoted attrs and an explicit close tag", () => {
  const segs = splitChapter(`<mark name='a' figure='fig-x'></mark> Body.`);
  expect(segs[0]!.markName).toBe("a");
  expect(segs[0]!.figure).toBe("fig-x");
});

test("a per-figure pointer is reset by the next mark that omits it", () => {
  // The figure rides only its own mark's segment; the sub-chapter-bounded
  // stickiness is resolved downstream (render-video / narratorTiming), not here.
  const segs = splitChapter(`<mark name="a" figure="fig-x"/> One. <mark name="b"/> Two.`);
  expect(segs.map((s) => s.figure)).toEqual(["fig-x", null]);
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

// --- extractNarration -------------------------------------------------------
// The post-scanner used by the sound-test page relies on this to enumerate
// narration chapters without re-implementing the HTML parse.

test("extractNarration pulls chapters in document order with their ids/titles", () => {
  const html = `
    <html><body><article>
      <script type="text/narration" data-chapter-id="intro" data-chapter-title="Intro">
        Hello <mark name="m1"/> world.
      </script>
      <p>visible prose</p>
      <script type="text/narration" data-chapter-id="body" data-chapter-title="Body">
        Then <mark name="m2"/> more.
      </script>
    </article></body></html>`;
  const { disabled, chapters } = extractNarration(html);
  expect(disabled).toBe(false);
  expect(chapters.map((c) => c.id)).toEqual(["intro", "body"]);
  expect(chapters[0]!.title).toBe("Intro");
  expect(chapters[0]!.content).toContain('<mark name="m1"/>');
  expect(chapters[1]!.content).toContain('<mark name="m2"/>');
});

test("extractNarration reports data-narration='none' as disabled", () => {
  const html = `
    <article data-narration="none">
      <script type="text/narration" data-chapter-id="x" data-chapter-title="X">
        ignored <mark name="m"/>
      </script>
    </article>`;
  const { disabled, chapters } = extractNarration(html);
  expect(disabled).toBe(true);
  // The chapters are still collected (HTMLRewriter walks them), but the caller
  // treats `disabled` as "skip this post entirely."
  expect(chapters.length).toBe(1);
});

test("extractNarration returns no chapters when none are present", () => {
  const html = `<article><p>no narration here</p></article>`;
  const { disabled, chapters } = extractNarration(html);
  expect(disabled).toBe(false);
  expect(chapters).toEqual([]);
});

test("extractNarration reads data-chapter-parent into parentId", () => {
  const html = `
    <article>
      <script type="text/narration" data-chapter-id="part" data-chapter-title="Part">P</script>
      <script type="text/narration" data-chapter-id="kid" data-chapter-title="Kid" data-chapter-parent="part">K</script>
    </article>`;
  const { chapters } = extractNarration(html);
  expect(chapters.map((c) => [c.id, c.parentId])).toEqual([
    ["part", undefined],
    ["kid", "part"],
  ]);
});
