// The suggestion word-diff preview (proposal 65). Verifies the granular diff and
// the large-input fallback that keeps jsdiff off the main thread's critical path.

import "../../happydom.ts";
import { expect, test } from "bun:test";
import { buildDiffPreview } from "./suggestionDiff.ts";

test("word-diff marks inserted and removed words", () => {
  const el = buildDiffPreview("the quick fox", "the slow fox");
  expect(el.querySelector(".cmt-diff-del")?.textContent).toContain("quick");
  expect(el.querySelector(".cmt-diff-ins")?.textContent).toContain("slow");
  // unchanged words stay plain
  expect([...el.querySelectorAll(".cmt-diff-eq")].map((s) => s.textContent).join("")).toContain("the");
});

test("empty proposed strikes the whole original (delete suggestion)", () => {
  const el = buildDiffPreview("remove me", "");
  expect(el.querySelector(".cmt-diff-del")?.textContent).toBe("remove me");
  expect(el.querySelector(".cmt-diff-ins")).toBeNull();
});

test("large input uses the coarse fallback (bounded, never the O(n^2) word-diff)", () => {
  // Two big, fully-divergent strings — the pathological jsdiff case. The
  // fallback emits exactly one struck original + one inserted proposed.
  const original = "a ".repeat(3000);
  const proposed = "b ".repeat(3000);
  const el = buildDiffPreview(original, proposed);
  expect(el.querySelectorAll(".cmt-diff-del").length).toBe(1);
  expect(el.querySelectorAll(".cmt-diff-ins").length).toBe(1);
  expect(el.querySelector(".cmt-diff-del")?.textContent).toBe(original);
  expect(el.querySelector(".cmt-diff-ins")?.textContent).toBe(proposed);
});
