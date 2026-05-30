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
