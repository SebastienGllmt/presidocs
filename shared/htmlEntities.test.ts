import { test, expect } from "bun:test";
import { decodeHtmlEntities } from "./htmlEntities.ts";

test("decodes common named entities", () => {
  expect(decodeHtmlEntities("Presidocs &mdash; talks")).toBe("Presidocs — talks");
  expect(decodeHtmlEntities("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
  expect(decodeHtmlEntities("don&rsquo;t")).toBe("don’t");
});

test("decodes numeric (decimal + hex) entities", () => {
  expect(decodeHtmlEntities("don&#39;t")).toBe("don't");
  expect(decodeHtmlEntities("em&#x2014;dash")).toBe("em—dash");
});

test("leaves unknown entities untouched", () => {
  expect(decodeHtmlEntities("&notareal; &amp;")).toBe("&notareal; &");
});

test("is a no-op on entity-free text", () => {
  expect(decodeHtmlEntities("plain text 123")).toBe("plain text 123");
});

// The hand-rolled table knew 18 entities; everything else passed through
// un-decoded and then double-escaped at the destination (the shipped bug).
// `decodeHTMLStrict` decodes the full WHATWG named set — lock a few that the
// old table missed so a regression to a narrow table is caught.
test("decodes named entities beyond the legacy 18", () => {
  expect(decodeHtmlEntities("caf&eacute;")).toBe("café");
  expect(decodeHtmlEntities("&pound;5 &euro;5")).toBe("£5 €5");
  expect(decodeHtmlEntities("&frac12; &dagger; &rarr; &alpha;")).toBe("½ † → α");
});

// STRICT requires the terminating `;`: a bare legacy reference stays literal,
// where non-strict `decodeHTML` would apply the longest-prefix rule and corrupt
// prose (`&notareal;` → `¬areal;`). This is the must-not-get-wrong detail.
test("requires the trailing semicolon (no legacy longest-prefix decode)", () => {
  expect(decodeHtmlEntities("&not")).toBe("&not");
  expect(decodeHtmlEntities("&copy 2026")).toBe("&copy 2026");
});

// Documented semantics change: the old table mapped `&nbsp;` to a regular
// space (U+0020); the spec — and `entities` — decode it to U+00A0, the
// non-breaking space the author actually typed.
test("&nbsp; decodes to a non-breaking space (U+00A0)", () => {
  expect(decodeHtmlEntities("a&nbsp;b")).toBe("a\u00A0b");
});
