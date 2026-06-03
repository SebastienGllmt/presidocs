import { test, expect } from "bun:test";
import {
  htmlToMarkdown,
  renderMarkdownDocument,
} from "./htmlToMarkdown.ts";

// A representative post exercising the transform's full surface: the title-h1
// we render ourselves, prose with inline marks, both list kinds, a figure with
// a <figcaption>, a figure with only an aria-label, a blockquote, a code block,
// an aria-hidden decorative node, the author byline, and the narration dock
// sibling. The golden below is the exact emitted document.
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
  <p aria-hidden="true">decorative noise that should vanish</p>
  <div class="byline">By Someone</div>
</article>
<div class="narrate-dock" role="region" aria-label="Narration player"><div class="chapter-strip"></div></div>
</body></html>`;

const GOLDEN = `---
title: Fixture Post
source: "https://blog.example/posts/fixture"
updated: "2026-06-03T12:00:00Z"
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
