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

test("front-matter carries license + code_license, after updated", () => {
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

test("a figure wrapping a table is unwrapped — the table survives, not collapsed to a caption", () => {
  // Data tables are tagged <figure> only so readers can comment on them as a
  // graphic; the twin must still convert the <table>, not throw it away with a
  // `> _Figure: …_` note. Fallback path (short post) keeps it simple.
  const html =
    '<article data-narration-src="/x"><h1 id="title">T</h1>' +
    '<figure id="bench" aria-label="Prove time by layer (scrollable)">' +
    "<table><thead><tr><th>Layer</th><th>Time</th></tr></thead>" +
    "<tbody><tr><td>L1</td><td>2s</td></tr></tbody></table></figure></article>";
  const { markdown } = htmlToMarkdown(html);
  expect(markdown).toContain("| Layer | Time |");
  expect(markdown).toContain("| --- | --- |");
  // Cells are padded to column width by Turndown (`| L1  | 2s  |`).
  expect(markdown).toMatch(/\| L1 +\| 2s +\|/);
  // The figure must NOT have collapsed to a caption note.
  expect(markdown).not.toContain("Prove time by layer");
  expect(markdown).not.toContain("_Figure:");
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

// A "technical aside" as the post authors it: `<details class="aside">` with a
// `<summary>` title. Enough filler prose that Readability accepts the article
// (the real, long-post path); Readability keeps the <details>/<summary> tags.
const ASIDE_FIXTURE =
  '<article data-narration-src="/x" role="main"><h1 id="title">Aside Post</h1>' +
  Array.from(
    { length: 12 },
    (_, i) =>
      `<p>Filler paragraph ${i} with enough real words that Readability treats this as a genuine article body worth keeping in the extracted content.</p>`,
  ).join("") +
  '<details id="perf-aside" class="aside">' +
  "<summary>Technical aside - what <code>k</code> is, precisely (most readers can skip this)</summary>" +
  "<p>First aside paragraph explaining the technical point in a meaningful number of words.</p>" +
  "<p>Second aside paragraph continuing the explanation a little further along.</p>" +
  "</details></article>";

test("a <details> technical aside is preserved as a collapsible block, not flattened", () => {
  const { markdown } = htmlToMarkdown(ASIDE_FIXTURE);
  // The structure survives as raw HTML (GitHub & most renderers show it as a
  // real collapsible) rather than the summary collapsing into a bare paragraph.
  expect(markdown).toContain("<details>");
  expect(markdown).toContain("</details>");
  // Summary title carried through, with inline HTML converted to inline Markdown
  // (`<code>k</code>` → `` `k` ``).
  expect(markdown).toContain("<summary>Technical aside - what `k` is, precisely (most readers can skip this)</summary>");
  // The id is dropped (Markdown twins carry no element ids).
  expect(markdown).not.toContain("perf-aside");
  // Body paragraphs land inside the block as Markdown.
  expect(markdown).toContain("First aside paragraph explaining the technical point");
  expect(markdown).toContain("Second aside paragraph continuing the explanation");
});

test("the <details> block leaves the blank line GitHub needs to render the body as Markdown", () => {
  const { markdown } = htmlToMarkdown(ASIDE_FIXTURE);
  // The load-bearing detail: a blank line after </summary>. Without it GitHub
  // renders the body as literal text. (And a blank line before </details>.)
  expect(markdown).toContain("</summary>\n\nFirst aside paragraph");
  expect(markdown).toMatch(/\n\n<\/details>/);
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

// --- Figure source links ---------------------------------------

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

// --- Part dividers in the twin (methodology → Copy as Markdown) --------------

// A post with parts: two labeled dividers, each opening a section whose `<h2>`
// then contains an `<h3>`. Bodies are padded so the Readability path (not just
// the fallback) keeps the structure — this exercises the real extractor. The
// first divider carries the `Short-term · …` inline prefix that must survive
// verbatim (the implicit super-part is NOT reconstructed into its own level).
const PARTS_FIXTURE = `<!DOCTYPE html><html lang="en"><head><title>Parted</title></head>
<body>
<article data-narration-src="/generated/parted/manifest.json" role="main">
  <h1 id="title">Parted Post</h1>
  <p id="lede">An introduction long enough that the extractor treats this as a genuine article body worth keeping, rather than discarding the whole thing as too short to be readable content.</p>
  <section>
    <h2 id="intro">A pre-part intro section</h2>
    <p>This standalone section precedes the first part divider, so it is a top-level section and must stay at its original level rather than being demoted under a part that does not exist yet.</p>
  </section>
  <div class="section-divider-labeled" id="p-one">Short-term · First part</div>
  <section>
    <h2 id="s1">First section</h2>
    <p>Body text for the first section, again with enough words to be substantive and survive the extractor's readerability scoring without being pruned.</p>
    <h3 id="sub1">A subsection</h3>
    <p>Subsection prose continuing the discussion with additional detail and several more words so the document body stays comfortably weighty.</p>
  </section>
  <div class="section-divider-labeled" id="p-two">Second part</div>
  <section>
    <h2 id="s2">Second section</h2>
    <p>More body text for the second section so the whole document sits well above the extractor's minimum content-length threshold throughout.</p>
  </section>
</article>
</body></html>`;

test("a part divider becomes an h2 and authored headings cascade down one level", () => {
  const { markdown } = htmlToMarkdown(PARTS_FIXTURE);
  // part divider → ##, section <h2> → ###, subsection <h3> → ####
  expect(markdown).toContain("## Short-term · First part");
  expect(markdown).toContain("### First section");
  expect(markdown).toContain("#### A subsection");
  expect(markdown).toContain("## Second part");
  expect(markdown).toContain("### Second section");
});

test("a section before the first divider stays top-level (##), not demoted under a part", () => {
  // Position-aware demotion: only headings *inside* a part (after the first
  // divider) are bumped. A pre-part intro section is a sibling of the parts —
  // the outline drawer renders it ungrouped — so it keeps `##`, and there is no
  // `#`→`###` level skip at the top of the document.
  const { markdown } = htmlToMarkdown(PARTS_FIXTURE);
  expect(markdown).toContain("## A pre-part intro section");
  expect(markdown).not.toContain("### A pre-part intro section");
});

test("the divider label is emitted verbatim — the inline `Short-term · ` prefix is NOT reconstructed into its own level", () => {
  const { markdown } = htmlToMarkdown(PARTS_FIXTURE);
  // No deeper-than-#### heading is synthesized for the implicit super-part.
  expect(markdown).not.toContain("##### ");
  // The prefix rides along inside the part heading, exactly as authored — it is
  // never split out into a standalone `## Short-term` grouping heading.
  expect(markdown).not.toContain("## Short-term\n");
  expect(markdown).toContain("## Short-term · First part");
});

test("the part label is a heading, not orphaned plain text (the bug this fixes)", () => {
  const { markdown } = htmlToMarkdown(PARTS_FIXTURE);
  const lines = markdown.split("\n");
  // The label must not appear as a bare paragraph line anywhere — only ever as
  // an `##`-prefixed heading.
  expect(lines).not.toContain("Short-term · First part");
  expect(lines).not.toContain("Second part");
});

test("a post with no dividers is untouched: <h2>→##, <h3>→### (no demotion)", () => {
  // The main golden already locks this for FIXTURE; assert it explicitly as the
  // regression guard — the heading rebuild is keyed on dividers being present.
  const { markdown } = htmlToMarkdown(FIXTURE);
  expect(markdown).toContain("## First section");
  expect(markdown).toContain("### A sub-section");
  expect(markdown).not.toContain("#### ");
});
