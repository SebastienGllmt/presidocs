// Pure-logic tests for the stale-anchor check. No happy-dom — the helper
// signature takes a Map, not a DOM root, so the test can construct
// fixtures in two lines and lean on Bun's expectation that one fast
// `expect` per case is better than a DOM round-trip.

import { test, expect } from "bun:test";

import { compareSegmentHashes } from "./commentsStale.ts";

test("returns false when every segment present AND hash matches", () => {
  const blocks = new Map([
    ["b1", { hash: "h-one" }],
    ["b2", { hash: "h-two" }],
  ]);
  expect(
    compareSegmentHashes(
      [
        { id: "b1", hash: "h-one" },
        { id: "b2", hash: "h-two" },
      ],
      blocks,
    ),
  ).toBe(false);
});

test("returns true when a referenced segment has been deleted (id no longer present)", () => {
  const blocks = new Map([["b1", { hash: "h-one" }]]);
  expect(
    compareSegmentHashes(
      [
        { id: "b1", hash: "h-one" },
        { id: "removed", hash: "anything" },
      ],
      blocks,
    ),
  ).toBe(true);
});

test("returns true when a segment is still present but its text drifted (hash mismatch)", () => {
  const blocks = new Map([["b1", { hash: "h-NEW" }]]);
  expect(
    compareSegmentHashes(
      [{ id: "b1", hash: "h-original" }],
      blocks,
    ),
  ).toBe(true);
});

test("short-circuits on first mismatch (later matches don't rescue)", () => {
  // A thread spanning three segments where the FIRST has drifted but the
  // other two still match → still stale. We model "any block mismatches"
  // not "every block matches".
  const blocks = new Map([
    ["b1", { hash: "DRIFTED" }],
    ["b2", { hash: "h-two" }],
    ["b3", { hash: "h-three" }],
  ]);
  expect(
    compareSegmentHashes(
      [
        { id: "b1", hash: "h-one" },
        { id: "b2", hash: "h-two" },
        { id: "b3", hash: "h-three" },
      ],
      blocks,
    ),
  ).toBe(true);
});

test("empty segment list is not stale (zero things to drift)", () => {
  expect(compareSegmentHashes([], new Map())).toBe(false);
});

test("empty blocksById Map AND non-empty segments → stale (every ref missing)", () => {
  expect(
    compareSegmentHashes(
      [{ id: "anything", hash: "h" }],
      new Map(),
    ),
  ).toBe(true);
});
