// Coverage for the build-time code-highlight pass (proposal 34).

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { highlightCodeInHtml, highlightOne } from "./highlightCode.ts";

const wrap = (inner: string) => `<article data-narration-src="/x">${inner}</article>`;

test("highlights a bare rust code block and de-inlines all styles (CSP)", async () => {
  const html = wrap('<pre><code class="language-rust">struct S { x: u8 }</code></pre>');
  const out = await highlightCodeInHtml(html);
  expect(out).toContain('class="shiki-code"');
  expect(out).toContain('data-lang="rust"');
  // CSP invariant: no inline style attributes anywhere in the output.
  expect(out.match(/style="/g)).toBeNull();
  // Token classes are present and the keyword is still there.
  expect(out).toMatch(/class="[^"]*\bshk-[a-z0-9]+/);
  expect(out).toContain("struct");
  // The page around the block is preserved byte-faithfully.
  expect(out.startsWith('<article data-narration-src="/x">')).toBe(true);
});

test("is idempotent — a second pass changes nothing", async () => {
  const html = wrap('<pre><code class="language-rust">let x = 1;</code></pre>');
  const once = await highlightCodeInHtml(html);
  const twice = await highlightCodeInHtml(once);
  expect(twice).toBe(once);
});

test("is nesting-agnostic — highlights a <pre> inside a <figure> (Pattern C)", async () => {
  const html = wrap(
    '<figure id="txstruct-figure"><svg><text>flow</text></svg>' +
      '<pre><code class="language-rust">struct Transaction { guaranteed_offer: Option<ZswapOffer> }</code></pre>' +
      "<figcaption>caption</figcaption></figure>",
  );
  const out = await highlightCodeInHtml(html);
  // The code inside the figure was highlighted...
  expect(out).toContain('class="shiki-code"');
  // ...and the sibling SVG + figcaption are untouched.
  expect(out).toContain("<svg><text>flow</text></svg>");
  expect(out).toContain("<figcaption>caption</figcaption>");
  expect(out).toContain('id="txstruct-figure"');
});

test("decodes HTML entities in the source before highlighting", async () => {
  // Authored generics arrive escaped (Option&lt;ZswapOffer&gt;).
  const html = wrap('<pre><code class="language-rust">fn f() -> Option&lt;u8&gt; { None }</code></pre>');
  const out = await highlightCodeInHtml(html);
  // Shiki saw real `<`/`>` (decoded), tokenized the generic into separate spans
  // — Option / `<` / u8 — and re-escaped `<` as the hex entity for output.
  expect(out).toContain("Option");
  expect(out).toContain("u8");
  expect(out).toContain("&#x3C;"); // the `<` of the generic, re-escaped
  expect(out).not.toContain("language-rust");
});

test("applies the @annotate callout and in-code notations", async () => {
  const html = wrap(
    '<pre><code class="language-rust">struct Z {\n  commitment: u8, // [!code highlight]\n  // @annotate: this is the leaf\n}</code></pre>',
  );
  const out = await highlightCodeInHtml(html);
  // Field-row highlight class from transformerNotationHighlight.
  expect(out).toContain("highlighted");
  // The @annotate line became a callout and the raw comment is gone.
  expect(out).toContain("twoslash-tag-annotate-line");
  expect(out).toContain("this is the leaf");
  expect(out).not.toContain("@annotate:");
});

test("`@note` becomes an overlay label on its field line, not a code line", async () => {
  const html = wrap(
    '<pre><code class="language-rust">struct S {\n  field: u8, // @note: the important one\n}</code></pre>',
  );
  const out = await highlightCodeInHtml(html);
  // The label is an overlay span tinting + annotating the field's own line...
  expect(out).toContain("code-anno");
  expect(out).toContain("the important one");
  // ...the comment text never tokenizes as code, and there's no extra callout line.
  expect(out).not.toContain("@note");
  expect(out).not.toContain("// the important one");
  expect(out).not.toContain("twoslash-tag");
  // The field line carries both its code and the overlay label.
  expect(out).toMatch(/field[\s\S]*code-anno/);
});

test("`@note-create` / `@note-spend` carry the semantic tint class", async () => {
  const html = wrap(
    '<pre><code class="language-rust">struct S {\n  a: u8, // @note-create: makes it\n  b: u8, // @note-spend: spends it\n}</code></pre>',
  );
  const out = await highlightCodeInHtml(html);
  expect(out).toContain("tok-create");
  expect(out).toContain("code-anno-create");
  expect(out).toContain("tok-spend");
  expect(out).toContain("code-anno-spend");
});

test("`// ...` elision renders as a bare `...` in the comment colour", async () => {
  const html = wrap('<pre><code class="language-rust">struct S {\n  // ...\n}</code></pre>');
  const out = await highlightCodeInHtml(html);
  // The rendered comment token keeps its (gray) comment class but drops the `//`.
  expect(out).toMatch(/class="[^"]*shk-[a-z0-9]+">\s*\.\.\.<\/span>/);
  // The bare `...` is no longer red (Rust would tokenize it as an operator).
  expect(out).not.toContain("// ...");
  // Indentation is preserved (the `...` stays aligned under the fields).
  expect(out).toMatch(/>\s\s\.\.\.</);
});

test("leaves an unsupported language untouched", async () => {
  const html = wrap('<pre><code class="language-python">x = 1</code></pre>');
  const out = await highlightCodeInHtml(html);
  expect(out).toContain('class="language-python"');
  expect(out).not.toContain("shiki-code");
});

test("no-op when the page has no code blocks", async () => {
  const html = wrap("<p>Just prose, no code.</p>");
  expect(await highlightCodeInHtml(html)).toBe(html);
});

test("every token class the pass emits is defined in the committed CSS", async () => {
  // The token colours ship as committed rules in base.css keyed by these class
  // names; if the theme ever produces a colour the CSS doesn't cover, tokens
  // would render unstyled. Highlight a Rust sample broad enough to hit the full
  // palette and assert each emitted `.shk-*` class is in base.css.
  const sample = [
    "// comment",
    "#[derive(Clone)]",
    "pub struct Foo<'a, T> { name: &'a str, n: u64, r: f32, ok: bool, d: Option<Vec<T>> }",
    'fn main() { let s = "hi"; let c = \'x\'; let h = 0xFF_u8; println!("{}", s); }',
    "enum E { A, B = 2 } const MAX: usize = 1024;",
  ].join("\n");
  const { css } = await highlightOne(sample, "rust");
  const emitted = [...css.matchAll(/\.(shk-[a-z0-9]+)\{color:/g)].map((m) => m[1]);
  expect(emitted.length).toBeGreaterThan(3);
  const baseCss = readFileSync(fileURLToPath(new URL("../client/base.css", import.meta.url)), "utf8");
  for (const cls of emitted) {
    expect(baseCss, `base.css is missing token class .${cls}`).toContain(`.${cls} `);
  }
});
