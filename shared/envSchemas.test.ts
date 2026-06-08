// Locks the shared env-idiom helpers to the exact hand-rolled semantics they
// replaced (so the feedConfig/notifyConfig migration stays behavior-preserving).

import { test, expect } from "bun:test";
import { csvList, trimmedOrNull, trimmedOr, envFlag } from "./envSchemas.ts";

test("csvList: splits, trims, drops empties; unset/empty → []", () => {
  expect(csvList.parse("a, b ,,c")).toEqual(["a", "b", "c"]);
  expect(csvList.parse("")).toEqual([]);
  expect(csvList.parse(undefined)).toEqual([]);
  expect(csvList.parse("  ")).toEqual([]); // all-whitespace entry dropped
});

test("trimmedOrNull: trimmed value, or null when empty/unset", () => {
  expect(trimmedOrNull.parse("  x ")).toBe("x");
  expect(trimmedOrNull.parse("")).toBeNull();
  expect(trimmedOrNull.parse(undefined)).toBeNull();
});

test("trimmedOr: trimmed value, or the fallback when empty/unset", () => {
  const lang = trimmedOr("en-US");
  expect(lang.parse(" fr-FR ")).toBe("fr-FR");
  expect(lang.parse("")).toBe("en-US");
  expect(lang.parse(undefined)).toBe("en-US");
});

test("envFlag truthy-set: true only for a listed token (=== 'true' semantics)", () => {
  const explicit = envFlag({ truthy: ["true"] });
  expect(explicit.parse("true")).toBe(true);
  expect(explicit.parse("TRUE")).toBe(true); // case-insensitive
  expect(explicit.parse(" true ")).toBe(true); // trimmed
  expect(explicit.parse("1")).toBe(false); // NOT in truthy set
  expect(explicit.parse("yes")).toBe(false);
  expect(explicit.parse("")).toBe(false);
  expect(explicit.parse(undefined)).toBe(false);
});

test("envFlag falsy-set: false only for a listed token, default true (!== 'no')", () => {
  const locked = envFlag({ falsy: ["no"] });
  expect(locked.parse("no")).toBe(false);
  expect(locked.parse("NO")).toBe(false); // case-insensitive
  expect(locked.parse("yes")).toBe(true);
  expect(locked.parse("")).toBe(true); // default true
  expect(locked.parse(undefined)).toBe(true);
  expect(locked.parse("anything")).toBe(true);
});
