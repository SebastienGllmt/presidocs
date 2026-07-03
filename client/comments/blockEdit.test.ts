// §3 diff-window math for in-place suggestion mode (proposal 65, increment 2).
// The anchor MUST describe the original document, so this is the load-bearing
// piece: prefix/suffix trim, pure-insertion widening, deletion, surrogate safety.

import { expect, test } from "bun:test";
import { diffWindow } from "./blockEdit.ts";

test("identical text is a no-op (null)", () => {
  expect(diffWindow("hello world", "hello world")).toBeNull();
});

test("mid-word replacement yields the minimal window", () => {
  // "quick" → "slow": common prefix "the ", common suffix " fox"
  const w = diffWindow("the quick fox", "the slow fox")!;
  expect(w).toEqual({ start: 4, end: 9, replacement: "slow" });
  expect("the quick fox".slice(w.start, w.end)).toBe("quick");
});

test("whole-block deletion → window is the whole block, empty replacement", () => {
  const w = diffWindow("delete me", "")!;
  expect(w).toEqual({ start: 0, end: 9, replacement: "" });
});

// Applying a window must reconstruct the edited text — the invariant that
// matters regardless of which adjacent word a pure insertion attaches to.
const apply = (original: string, w: { start: number; end: number; replacement: string }) =>
  original.slice(0, w.start) + w.replacement + original.slice(w.end);

test("pure insertion adjacent to a word widens to that (preceding) word", () => {
  // Append "s" to "cat" (no space between) → zero-length window widens left.
  const w = diffWindow("the cat", "the cats")!;
  expect(w.start).toBeLessThan(w.end); // non-empty (highlightable)
  expect("the cat".slice(w.start, w.end)).toBe("cat");
  expect(apply("the cat", w)).toBe("the cats");
});

test("insertion between words widens to an adjacent word and reconstructs", () => {
  const w = diffWindow("hi world", "hi there world")!;
  expect(w.start).toBeLessThan(w.end); // non-empty (highlightable)
  expect(apply("hi world", w)).toBe("hi there world");
});

test("insertion at a leading-whitespace boundary widens past the whitespace", () => {
  // Block textContent often starts with source indentation; a caret at offset 0
  // must still widen to the first real word, not return a zero-length window.
  const original = "\n    Lede opens here";
  const w = diffWindow(original, "WIDGET " + original)!;
  expect(w.start).toBeLessThan(w.end); // non-empty (highlightable)
  expect(apply(original, w)).toBe("WIDGET " + original);
});

test("insertion at the very start widens to the following word", () => {
  const w = diffWindow("world", "hello world")!;
  expect(w.start).toBeLessThan(w.end);
  expect("world".slice(w.start, w.end)).toBe("world");
  expect(w.replacement).toBe("hello world");
});

test("appending to the end widens to the last word", () => {
  const w = diffWindow("say hi", "say hiya")!;
  // common prefix "say hi", nothing common at the end → window covers "hi"→"hiya"
  expect("say hi".slice(w.start, w.end)).toBe("hi");
  expect(w.replacement).toBe("hiya");
});

test("surrogate pair (emoji) is not split at the prefix boundary", () => {
  // "a😀b" → "a😀c": the emoji is 2 UTF-16 units; the window must start after it.
  const original = "a\u{1F600}b";
  const edited = "a\u{1F600}c";
  const w = diffWindow(original, edited)!;
  expect(original.slice(w.start, w.end)).toBe("b");
  expect(w.replacement).toBe("c");
});

test("replacing an emoji keeps the whole pair inside the window", () => {
  const original = "x\u{1F600}y";
  const edited = "x\u{1F601}y";
  const w = diffWindow(original, edited)!;
  expect(original.slice(w.start, w.end)).toBe("\u{1F600}");
  expect(w.replacement).toBe("\u{1F601}");
});
