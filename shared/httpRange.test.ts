// Regression tests for the shared HTTP Range parser. The cases below are the
// ones both prior implementations (createDevServer.ts:serveFromDir and
// createWorker.ts:applyRangeSupport) handled — keeping them centralized
// guarantees the audio-seek path stays correct after the de-dup.

import { test, expect } from "bun:test";
import {
  contentRangeHeader,
  resolveRange,
  unsatisfiedRangeHeader,
} from "./httpRange.ts";

test("absent / empty Range header → none", () => {
  expect(resolveRange(null, 100)).toEqual({ kind: "none" });
  expect(resolveRange("", 100)).toEqual({ kind: "none" });
});

test("zero-size resource → none (matches dev's `size > 0` gate)", () => {
  expect(resolveRange("bytes=0-10", 0)).toEqual({ kind: "none" });
});

test("garbage Range header → none (fall through to full 200)", () => {
  expect(resolveRange("not-a-range", 100)).toEqual({ kind: "none" });
  expect(resolveRange("bytes=abc-def", 100)).toEqual({ kind: "none" });
  expect(resolveRange("bytes=0-10,20-30", 100)).toEqual({ kind: "none" });
});

test("full closed range `bytes=N-M`", () => {
  expect(resolveRange("bytes=10-20", 100)).toEqual({
    kind: "satisfiable",
    start: 10,
    end: 20,
    size: 100,
  });
});

test("open-ended range `bytes=N-` runs to end-of-resource", () => {
  expect(resolveRange("bytes=50-", 100)).toEqual({
    kind: "satisfiable",
    start: 50,
    end: 99,
    size: 100,
  });
});

test("suffix range `bytes=-N` returns the last N bytes", () => {
  expect(resolveRange("bytes=-10", 100)).toEqual({
    kind: "satisfiable",
    start: 90,
    end: 99,
    size: 100,
  });
});

test("suffix range larger than the resource is clamped to the whole resource", () => {
  expect(resolveRange("bytes=-500", 100)).toEqual({
    kind: "satisfiable",
    start: 0,
    end: 99,
    size: 100,
  });
});

test("`end` past the resource is clamped to size-1", () => {
  expect(resolveRange("bytes=10-500", 100)).toEqual({
    kind: "satisfiable",
    start: 10,
    end: 99,
    size: 100,
  });
});

test("start at end-of-resource → unsatisfiable (416)", () => {
  expect(resolveRange("bytes=100-200", 100)).toEqual({
    kind: "unsatisfiable",
    size: 100,
  });
});

test("start > end (within bounds) → unsatisfiable", () => {
  // Constructed via the rare `bytes=10-5` form — invalid per RFC; the parser
  // routes it through `start > end` to a 416 rather than serving garbage.
  expect(resolveRange("bytes=10-5", 100)).toEqual({
    kind: "unsatisfiable",
    size: 100,
  });
});

test("whitespace around the header is tolerated", () => {
  expect(resolveRange("  bytes=0-10  ", 100)).toEqual({
    kind: "satisfiable",
    start: 0,
    end: 10,
    size: 100,
  });
});

test("header builders", () => {
  expect(contentRangeHeader(10, 20, 100)).toBe("bytes 10-20/100");
  expect(unsatisfiedRangeHeader(100)).toBe("bytes */100");
});
