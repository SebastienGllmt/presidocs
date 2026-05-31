// Round-trip tests for the time-unit conversions. Trivial in practice, but
// pinned so that any future change to the unit system (e.g. if we ever
// migrate to a `Microseconds` brand) has to delete or replace these — it
// can't silently rename `secondsToMs` to "× 1000.0" and miss a caller.

import { test, expect } from "bun:test";

import { asMs, asSeconds, msToSeconds, secondsToMs } from "./time.ts";

test("secondsToMs / msToSeconds round-trip", () => {
  const s = asSeconds(3.5);
  const ms = secondsToMs(s);
  expect(ms).toBe(asMs(3500));
  expect(msToSeconds(ms)).toBe(asSeconds(3.5));
});

test("zero is invariant under both conversions", () => {
  expect(secondsToMs(asSeconds(0))).toBe(asMs(0));
  expect(msToSeconds(asMs(0))).toBe(asSeconds(0));
});

test("integer ms round-trip exactly", () => {
  // Important for manifest-driven timing: mark times are integer ms,
  // and every `seekToMs(asMs(m.time + 10))` path in narrator.ts assumes
  // there's no floating-point creep when round-tripping.
  for (const n of [1, 999, 1000, 84300, 1_800_000]) {
    expect(secondsToMs(msToSeconds(asMs(n)))).toBe(asMs(n));
  }
});

test("ms→s rounds to the divisor cleanly for cents-precision", () => {
  // Shikwasa's audio config is second-based; the manifest is ms. Confirm
  // a 10-ms nudge (the chapter-jump offset used in setupDividerSpeakers
  // and the chapter-strip jump) survives the ms↔s round-trip.
  const t = asMs(10_010);
  expect(secondsToMs(msToSeconds(t))).toBe(asMs(10_010));
});
