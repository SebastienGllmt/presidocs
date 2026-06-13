import { test, expect } from "bun:test";
import { parse } from "yaml";
import {
  htmlToMarkdown,
  renderMarkdownDocument,
} from "./htmlToMarkdown.ts";

// Parse the `---`-fenced front-matter block back into an object.
function parseFrontMatter(doc: string): Record<string, unknown> {
  const m = doc.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no front matter block");
  return parse(m[1]!) as Record<string, unknown>;
}

// A representative post exercising the transform's full surface: the title-h1
// we render ourselves, prose with inline marks, both list kinds, a figure with
// a <figcaption>, a figure with only an aria-label, a blockquote, a code block,
// a GFM table (header + rows, a cell with inline <em> + an entity, a cell with a
// `|` to exercise escaping, and a stray inline <svg> that must NOT leak), a
// <del> strikethrough, an aria-hidden decorative node, the author byline, and
// the narration dock sibling. The golden below is the exact emitted document.
// (Task-list items are GFM too but are covered separately: Readability strips
// the <input type=checkbox>, so they only survive the article-root fallback
// path — see the dedicated test below.)
const FIXTURE = `<!DOCTYPE html><html lang="en"><head><title>Fixture Post: a subtitle</title></head>
<body>
<article data-narration-src="/generated/fixture/manifest.json" role="main">
  <h1 id="title">Fixture Post</h1>
  <p id="lede">A short lede that introduces the piece with <em>emphasis</em>.</p>
  <h2>First section</h2>
  <p>A paragraph with a <a href="https://example.com/x">link</a>, some <strong>bold</strong>, and <code>inline()</code>.</p>
  <ul><li>alpha</li><li>beta</li></ul>
  <figure id="fig1">
    <svg class="x-static" role="img" aria-label="Fallback alt that should be ignored when a figcaption exists"></svg>
    <figcaption>A diagram of the thing.</figcaption>
  </figure>
  <h3>A sub-section</h3>
  <ol><li>one</li><li>two</li></ol>
  <blockquote><p>A quoted remark.</p></blockquote>
  <figure id="fig2"><svg role="img" aria-label="Only an aria-label here."></svg></figure>
  <pre><code>const x = 1;
const y = 2;</code></pre>
  <h2>Data table</h2>
  <table>
    <thead><tr><th>Category</th><th>Examples</th><th>Share</th></tr></thead>
    <tbody>
      <tr><td>Memecoin</td><td>Pepe &amp; <em>Spacebucks</em></td><td>27%</td></tr>
      <tr><td>Has a | pipe</td><td><svg role="img" aria-label="leaked"></svg>icon text</td><td>3%</td></tr>
    </tbody>
  </table>
  <p>An edit: <del>struck out</del> stays.</p>
  <p aria-hidden="true">decorative noise that should vanish</p>
  <div class="byline">By Someone</div>
</article>
<div class="narrate-dock" role="region" aria-label="Narration player"><div class="chapter-strip"></div></div>
</body></html>`;

const GOLDEN = `---
title: Fixture Post
source: https://blog.example/posts/fixture
updated: 2026-06-03T12:00:00Z
---

# Fixture Post

A short lede that introduces the piece with _emphasis_.

## First section

A paragraph with a [link](https://example.com/x), some **bold**, and \`inline()\`.

-   alpha
-   beta

> _Figure: A diagram of the thing._

### A sub-section

1.  one
2.  two

> A quoted remark.

> _Figure: Only an aria-label here._

\`\`\`
const x = 1;
const y = 2;
\`\`\`

## Data table

| Category | Examples | Share |
| --- | --- | --- |
| Memecoin | Pepe & _Spacebucks_ | 27% |
| Has a \\| pipe | icon text | 3%  |

An edit: ~~struck out~~ stays.
`;

test("full document matches the golden vector", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const doc = renderMarkdownDocument(extract, {
    title: extract.title,
    url: "https://blog.example/posts/fixture",
    updated: "2026-06-03T12:00:00Z",
  });
  expect(doc).toBe(GOLDEN);
});

test("front-matter carries license + code_license, after updated (proposal 59)", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const doc = renderMarkdownDocument(extract, {
    title: extract.title,
    url: "https://blog.example/posts/fixture",
    updated: "2026-06-03T12:00:00Z",
    license: "CC-BY-4.0",
    codeLicense: "MIT",
  });
  const fm = parseFrontMatter(doc);
  expect(fm.license).toBe("CC-BY-4.0");
  expect(fm.code_license).toBe("MIT");
  // Emitted order is title → source → updated → license → code_license.
  expect(doc.indexOf("license:")).toBeGreaterThan(doc.indexOf("updated:"));
  expect(doc.indexOf("code_license:")).toBeGreaterThan(doc.indexOf("license:"));
});

test("front-matter omits license fields when unset", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const doc = renderMarkdownDocument(extract, { title: extract.title });
  expect(doc).not.toContain("license:");
  expect(doc).not.toContain("code_license:");
});

test("title comes from the <h1 id=title>, not the SEO <title>", () => {
  expect(htmlToMarkdown(FIXTURE).title).toBe("Fixture Post");
});

test("the title-h1 is not duplicated in the body", () => {
  const { markdown } = htmlToMarkdown(FIXTURE);
  expect(markdown).not.toContain("# Fixture Post");
});

test("runtime chrome is stripped", () => {
  const { markdown } = htmlToMarkdown(FIXTURE);
  expect(markdown).not.toContain("Narration player");
  expect(markdown).not.toContain("By Someone");
  expect(markdown).not.toContain("decorative noise");
});

test("figures collapse to a caption note — figcaption wins, aria-label is the fallback", () => {
  const { markdown } = htmlToMarkdown(FIXTURE);
  expect(markdown).toContain("> _Figure: A diagram of the thing._");
  expect(markdown).toContain("> _Figure: Only an aria-label here._");
  // The figcaption's sibling aria-label must NOT leak when a caption exists.
  expect(markdown).not.toContain("should be ignored");
  // No raw SVG markup survives the flatten.
  expect(markdown).not.toContain("<svg");
});

test("a figure with neither caption nor aria-label degrades to a placeholder", () => {
  const html =
    '<article data-narration-src="/x"><h1 id="title">T</h1><p>body text that is long enough to keep.</p><figure><canvas></canvas></figure></article>';
  expect(htmlToMarkdown(html).markdown).toContain("Figure (omitted).");
});

test("tables become GFM pipe tables (header + separator row), not flattened text", () => {
  const { markdown } = htmlToMarkdown(FIXTURE);
  // Header row, the alignment/separator row, and a body row — the three lines a
  // GFM table needs. Without the GFM rule Turndown would emit the cell text as a
  // structureless run-on line with no pipes.
  expect(markdown).toContain("| Category | Examples | Share |");
  expect(markdown).toContain("| --- | --- | --- |");
  expect(markdown).toContain("| Memecoin | Pepe & _Spacebucks_ | 27% |");
  // A literal `|` inside a cell is escaped so it can't break the table grammar.
  expect(markdown).toContain("Has a \\| pipe");
  // A stray inline <svg> inside a cell is still dropped (svg-removal wins inside
  // the table rule's cell recursion); its content survives.
  expect(markdown).toContain("| icon text |");
  expect(markdown).not.toContain("leaked");
});

test("<del>/<s> become ~~strikethrough~~", () => {
  const { markdown } = htmlToMarkdown(FIXTURE);
  expect(markdown).toContain("An edit: ~~struck out~~ stays.");
});

test("checkbox list items become GFM task-list items (article-root fallback path)", () => {
  // Readability strips <input>, so task lists only survive the fallback path —
  // a short post that fails Readability's readerability check. (A long post's
  // checkboxes are dropped by Readability before Turndown sees them; that's the
  // documented caveat, which is why the main golden has no task list.)
  const html =
    '<article data-narration-src="/x"><h1 id="title">T</h1>' +
    '<ul><li><input type="checkbox" checked> shipped</li>' +
    '<li><input type="checkbox"> pending</li></ul></article>';
  const { markdown, usedReadability } = htmlToMarkdown(html);
  expect(usedReadability).toBe(false);
  expect(markdown).toContain("[x]");
  expect(markdown).toContain("[ ]");
  expect(markdown).toContain("shipped");
  expect(markdown).toContain("pending");
});

test("a too-short post falls back to the article root rather than emitting nothing", () => {
  // One short paragraph: Readability returns null / too little, so the
  // article-root fallback path serializes it instead of yielding an empty body.
  const html =
    '<article data-narration-src="/x"><h1 id="title">Tiny</h1><p>Just one short line.</p></article>';
  const { markdown, title } = htmlToMarkdown(html);
  expect(title).toBe("Tiny");
  expect(markdown).toContain("Just one short line.");
});

test("front matter omits source/updated when not provided", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const doc = renderMarkdownDocument(extract, { title: extract.title });
  expect(doc).toContain("title: Fixture Post");
  expect(doc).not.toContain("source:");
  expect(doc).not.toContain("updated:");
});

// The reason the hand-rolled `yamlScalar()` heuristic was replaced: a
// boolean-/null-/number-shaped title was emitted bare, so a strict YAML
// consumer parsed `title:` as a boolean/null/number, not the author's string.
// `yaml.stringify` quotes exactly these so the provenance header round-trips as
// a string in every case.
test("a boolean-/null-/number-shaped title round-trips as a string", () => {
  const extract = htmlToMarkdown(FIXTURE);
  for (const t of ["true", "false", "null", "2026", "1.0", "yes: no"]) {
    const fmObj = parseFrontMatter(renderMarkdownDocument(extract, { title: t }));
    expect(typeof fmObj.title).toBe("string");
    expect(fmObj.title).toBe(t);
  }
});

// An embedded newline used to break the `---` block silently (neither the
// trigger regex nor the quote path handled control characters). It must now
// survive as a single scalar.
test("a title with an embedded newline stays a single valid scalar", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const fmObj = parseFrontMatter(renderMarkdownDocument(extract, { title: "line1\nline2" }));
  expect(fmObj.title).toBe("line1\nline2");
});

// Insertion order (title → source → updated) is the emitted field order; lock
// it so a future reorder of the assembly is caught.
test("front-matter fields are emitted in title → source → updated order", () => {
  const extract = htmlToMarkdown(FIXTURE);
  const doc = renderMarkdownDocument(extract, {
    title: extract.title,
    url: "https://blog.example/posts/fixture",
    updated: "2026-06-03T12:00:00Z",
  });
  expect(doc.indexOf("title:")).toBeLessThan(doc.indexOf("source:"));
  expect(doc.indexOf("source:")).toBeLessThan(doc.indexOf("updated:"));
});

// --- Figure source links (proposal 58) ---------------------------------------

// One animated figure (carries data-figure-src) + one static figure (none).
const FIG_HTML = `<!DOCTYPE html><html lang="en"><body>
<article data-narration-src="/generated/x/manifest.json" role="main">
  <h1 id="title">T</h1>
  <p>An intro paragraph with enough words that the extractor treats this as a real article body worth keeping around.</p>
  <figure id="deltas-vanish-figure" data-figure-src="deltasVanish">
    <figcaption>Deltas vanish on merge.</figcaption>
  </figure>
  <figure id="static-chart">
    <figcaption>A static chart.</figcaption>
  </figure>
  <p>More body text afterwards so the article has substantial content on both sides of the figures.</p>
</article></body></html>`;

test("a figure with data-figure-src + figureSrcBase gets a relative [source] link", () => {
  const { markdown } = htmlToMarkdown(FIG_HTML, { figureSrcBase: "offer-files" });
  expect(markdown).toContain("[source](offer-files/figures/deltasVanish.ts)");
  expect(markdown).toContain("Deltas vanish on merge.");
});

test("an absolute base produces a self-contained absolute [source] link", () => {
  const { markdown } = htmlToMarkdown(FIG_HTML, {
    figureSrcBase: "https://blog.example.com/posts/offer-files",
  });
  expect(markdown).toContain("[source](https://blog.example.com/posts/offer-files/figures/deltasVanish.ts)");
});

test("a private slug base is carried into the link verbatim (inherits the token)", () => {
  const { markdown } = htmlToMarkdown(FIG_HTML, { figureSrcBase: "offer-files--Xk3n8fQ2pLwz9" });
  expect(markdown).toContain("[source](offer-files--Xk3n8fQ2pLwz9/figures/deltasVanish.ts)");
});

test("no figureSrcBase (the dev-server route) → caption only, no link", () => {
  const { markdown } = htmlToMarkdown(FIG_HTML);
  expect(markdown).not.toContain("[source]");
  expect(markdown).toContain("Deltas vanish on merge.");
});

test("a static figure (no data-figure-src) gets no link, even with a base", () => {
  const { markdown } = htmlToMarkdown(FIG_HTML, { figureSrcBase: "offer-files" });
  expect(markdown).toContain("A static chart.");
  // exactly one source link total — only the animated figure is linked.
  expect(markdown.match(/\[source\]/g)?.length ?? 0).toBe(1);
});
