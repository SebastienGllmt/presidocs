import { test, expect } from "bun:test";
import { auditSourceIds, duplicateIds } from "./audit-source-ids.ts";

test("a post with all-unique ids has no violations", () => {
  const html = `<h1 id="a">A</h1><table id="b"></table><figure id="c"></figure>`;
  expect(duplicateIds(html)).toEqual([]);
  expect(auditSourceIds(html)).toEqual([]);
});

test("flags two elements sharing an id (the table case)", () => {
  const html = `<table id="t1"></table><p>x</p><table id="t1"></table>`;
  expect(duplicateIds(html)).toEqual(["t1"]);
  expect(auditSourceIds(html).map((v) => v.rule)).toEqual(["no-dup-id"]);
  expect(auditSourceIds(html)[0]!.detail).toContain('id="t1"');
});

test("reports each duplicated id once, sorted, even with 3+ collisions", () => {
  const html = `<i id="z"></i><i id="z"></i><i id="z"></i><b id="a"></b><b id="a"></b>`;
  expect(duplicateIds(html)).toEqual(["a", "z"]);
});

test("does NOT count data-chapter-id as an id (narration pairs it with a divider id on purpose)", () => {
  const html = `<script type="text/narration" data-chapter-id="p-zswap"></script>
    <div class="section-divider-labeled" id="p-zswap">zSwap intro</div>`;
  expect(duplicateIds(html)).toEqual([]);
});

test("ignores id-looking text inside a narration <script> (script content is raw text)", () => {
  const html = `<h2 id="real">real</h2>
    <script type="text/narration"><mark id="not-an-element"/> stray id="also-not"</script>`;
  expect(duplicateIds(html)).toEqual([]);
});
