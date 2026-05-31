// Tests for the build-time chapter-hierarchy normalization. The function
// mutates in place, degrades on invalid pointers, and enforces the
// two-level cap — all behaviours the methodology section "Two-level
// chapters" calls out as load-bearing.

import { test, expect } from "bun:test";

import { normalizeChapterParents } from "./chapterParents.ts";

// Helper: collects every emitted warning so tests can assert both the
// mutation outcome AND the warning text (the author reads these from
// `bun run generate` output, so wording is part of the contract).
const collect = () => {
  const warnings: string[] = [];
  return {
    warn: (msg: string) => warnings.push(msg),
    warnings,
  };
};

test("flat list (no parentId anywhere) is a no-op", () => {
  const w = collect();
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  normalizeChapterParents(list, w.warn);
  expect(list).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  expect(w.warnings).toEqual([]);
});

test("valid two-level hierarchy is preserved", () => {
  const w = collect();
  const list = [
    { id: "intro" },
    { id: "deep-1", parentId: "intro" },
    { id: "deep-2", parentId: "intro" },
    { id: "outro" },
  ];
  normalizeChapterParents(list, w.warn);
  expect(list[1]!.parentId).toBe("intro");
  expect(list[2]!.parentId).toBe("intro");
  expect(w.warnings).toEqual([]);
});

test("forward pointer (parent at a LATER index) degrades to top-level", () => {
  const w = collect();
  const list = [
    { id: "child", parentId: "later-parent" },
    { id: "later-parent" },
  ];
  normalizeChapterParents(list, w.warn);
  expect(list[0]!.parentId).toBeUndefined();
  expect(w.warnings.length).toBe(1);
  expect(w.warnings[0]).toContain(`"child"`);
  expect(w.warnings[0]).toContain("does not name an earlier chapter");
});

test("missing parent (typo'd id) degrades to top-level", () => {
  const w = collect();
  const list = [
    { id: "intro" },
    { id: "child", parentId: "typo" },
  ];
  normalizeChapterParents(list, w.warn);
  expect(list[1]!.parentId).toBeUndefined();
  expect(w.warnings.length).toBe(1);
  expect(w.warnings[0]).toContain("does not name an earlier chapter");
});

test("self-pointer (parentId === own id) degrades — sits at same index, not lower", () => {
  const w = collect();
  const list = [{ id: "loopy", parentId: "loopy" }];
  normalizeChapterParents(list, w.warn);
  expect(list[0]!.parentId).toBeUndefined();
  expect(w.warnings.length).toBe(1);
});

test("three-deep grandchild collapses to its grandparent (two-level cap)", () => {
  const w = collect();
  const list = [
    { id: "intro" },
    { id: "child", parentId: "intro" },
    { id: "grandchild", parentId: "child" },
  ];
  normalizeChapterParents(list, w.warn);
  // grandchild is flattened up to "intro" (its grandparent), not to
  // top-level — the cap is enforced by promotion, not by stripping.
  expect(list[2]!.parentId).toBe("intro");
  expect(w.warnings.length).toBe(1);
  expect(w.warnings[0]).toContain(`"grandchild"`);
  expect(w.warnings[0]).toContain("two-level cap");
});

test("four-deep cascades through the cap correctly", () => {
  const w = collect();
  const list = [
    { id: "a" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" }, // collapses to a
    { id: "d", parentId: "c" }, // c was collapsed → c.parentId is now "a", so d cascades to "a" too
  ];
  normalizeChapterParents(list, w.warn);
  expect(list[1]!.parentId).toBe("a");
  expect(list[2]!.parentId).toBe("a");
  // d sees its parent c carry a parentId of "a" (set on the previous
  // iteration) so it flattens to that grandparent too. The cap is
  // maintained at every depth via this cascade.
  expect(list[3]!.parentId).toBe("a");
  // Two collapse warnings: one for c, one for d.
  expect(w.warnings.length).toBe(2);
});

test("empty list is a no-op (no throw, no warnings)", () => {
  const w = collect();
  const list: { id: string; parentId?: string }[] = [];
  normalizeChapterParents(list, w.warn);
  expect(list).toEqual([]);
  expect(w.warnings).toEqual([]);
});

test("warn callback defaults to console.warn when omitted (smoke)", () => {
  // Spy on console.warn via Object.defineProperty so this works whether
  // or not happy-dom has been registered by another test file in the
  // same `bun test` run.
  const original = console.warn;
  const calls: string[] = [];
  Object.defineProperty(console, "warn", {
    value: (msg: string) => calls.push(msg),
    writable: true,
    configurable: true,
  });
  try {
    const list = [{ id: "child", parentId: "missing" }];
    normalizeChapterParents(list);
    expect(calls.length).toBe(1);
  } finally {
    Object.defineProperty(console, "warn", {
      value: original,
      writable: true,
      configurable: true,
    });
  }
});
