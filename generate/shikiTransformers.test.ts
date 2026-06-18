// Unit coverage for the build-time Shiki transformers (proposal 34). We run a
// real `@shikijs/core` highlighter (JS regex engine, Rust grammar, github-light)
// so the assertions exercise the actual hast pipeline, not a mock.

import { test, expect, beforeAll } from "bun:test";
import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { customTag, styleToClass } from "./shikiTransformers.ts";

let hl: HighlighterCore;
beforeAll(async () => {
  hl = await createHighlighterCore({
    langs: [import("@shikijs/langs/rust")],
    themes: [import("@shikijs/themes/github-light")],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
});

const render = (code: string, transformers: Parameters<HighlighterCore["codeToHtml"]>[1]["transformers"]) =>
  hl.codeToHtml(code, { lang: "rust", theme: "github-light", transformers });

test("customTag turns `@annotate:` into a callout span and drops the comment", () => {
  const html = render(
    ["struct S {", "  // @annotate: the field that matters", "  field: u32,", "}"].join("\n"),
    [customTag()],
  );
  // The comment line is gone; a typed callout carrying the message is inserted.
  expect(html).not.toContain("@annotate:");
  expect(html).toContain("twoslash-tag-annotate-line");
  expect(html).toContain("the field that matters");
  // The real code lines survive.
  expect(html).toContain("field");
});

test("customTag supports the other tag types with distinct classes", () => {
  const html = render(["let a = 1;", "// @warn: careful", "let b = 2;"].join("\n"), [customTag()]);
  expect(html).toContain("twoslash-tag-warn-line");
  expect(html).toContain("careful");
});

test("styleToClass removes every inline style and exposes the CSS", () => {
  const s2c = styleToClass();
  const html = render(["struct ZswapOutput {", "  commitment: CoinCommitment,", "}"].join("\n"), [s2c]);
  // The load-bearing CSP property: no inline style attributes survive.
  expect(html.match(/style="/g)).toBeNull();
  // Tokens carry generated classes instead.
  expect(html).toMatch(/class="[^"]*\bshk-[a-z0-9]+/);
  // And the collected CSS defines those classes with real colours.
  const css = s2c.getCss();
  expect(css).toMatch(/\.shk-[a-z0-9]+\{color:#[0-9A-Fa-f]{6}\}/);
});

test("styleToClass is deterministic — same colour, same class across blocks", () => {
  const a = styleToClass();
  render("struct A { x: u8 }", [a]);
  const b = styleToClass();
  render("struct B { y: u8 }", [b]);
  // `struct` is the same keyword colour in both, so the same class must appear.
  const classOf = (css: string) => css.match(/\.(shk-[a-z0-9]+)\{color:#D73A49\}/i)?.[1];
  expect(classOf(a.getCss())).toBeDefined();
  expect(classOf(a.getCss())).toBe(classOf(b.getCss()));
});
