// Unit tests for the build-time HTML strip. Regex-based stripping is
// easy to get subtly wrong (attribute order, multiline bodies, quote
// styles, neighboring tags getting eaten), so cover each tag type with
// representative source HTML plus negative cases ("this should NOT be
// removed") to guard against the regex over-matching.

import { test, expect } from "bun:test";
import { stripServedHtml } from "./stripServedHtml.ts";

// ---------- <meta name="author-email"> ----------

test("strips meta author-email tag (name then content)", () => {
  const html = `<head>
<meta charset="UTF-8" />
<meta name="author-email" content="me@example.com" />
<title>x</title>
</head>`;
  const out = stripServedHtml(html);
  expect(out).not.toContain("author-email");
  expect(out).not.toContain("me@example.com");
  expect(out).toContain("<title>x</title>");
  expect(out).toContain("UTF-8");
});

test("strips meta author-email tag with reversed attribute order", () => {
  const html = `<head>
<meta content="me@example.com" name="author-email" />
</head>`;
  expect(stripServedHtml(html)).not.toContain("author-email");
});

test("strips meta author-email tag with single quotes", () => {
  const html = `<meta name='author-email' content='me@example.com'>`;
  expect(stripServedHtml(html)).not.toContain("author-email");
});

test("keeps other meta tags intact", () => {
  const html = `<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="A blog post about hashing." />
<meta name="author-email" content="me@example.com" />
</head>`;
  const out = stripServedHtml(html);
  expect(out).toContain('name="viewport"');
  expect(out).toContain('name="description"');
  expect(out).toContain("UTF-8");
  expect(out).not.toContain("author-email");
});

// ---------- <script type="text/narration"> ----------

test("strips narration script blocks (multiline, with attributes)", () => {
  const html = `<body>
<p>Visible content.</p>
<script type="text/narration" data-chapter-id="intro" data-chapter-title="Welcome">
  <mark name="title"/>
  Hello and welcome.
  <mark name="lede"/>
</script>
<p>More content.</p>
</body>`;
  const out = stripServedHtml(html);
  expect(out).not.toContain("text/narration");
  expect(out).not.toContain("Hello and welcome");
  expect(out).not.toContain('<mark name="title"');
  expect(out).toContain("Visible content");
  expect(out).toContain("More content");
});

test("strips multiple narration blocks", () => {
  const html = `<script type="text/narration" data-chapter-id="a">alpha</script>
<p>between</p>
<script type="text/narration" data-chapter-id="b">beta</script>`;
  const out = stripServedHtml(html);
  expect(out).not.toContain("text/narration");
  expect(out).not.toContain("alpha");
  expect(out).not.toContain("beta");
  expect(out).toContain("between");
});

test("keeps module / unrelated script tags intact", () => {
  const html = `<script type="module" src="./client/narrator.ts"></script>
<script type="text/narration" data-chapter-id="x">stripped</script>
<script type="application/ld+json">{"@type":"Article"}</script>`;
  const out = stripServedHtml(html);
  expect(out).toContain('type="module"');
  expect(out).toContain('type="application/ld+json"');
  expect(out).not.toContain("text/narration");
  expect(out).not.toContain("stripped");
});

// ---------- <script type="application/pls+xml"> ----------

test("strips PLS lexicon scripts (multiline)", () => {
  const html = `<head>
<script type="application/pls+xml">
<lexicon version="1.0">
  <lexeme><grapheme>RIPEMD-160</grapheme><alias>RIPE-M-D-1-60</alias></lexeme>
</lexicon>
</script>
</head>`;
  const out = stripServedHtml(html);
  expect(out).not.toContain("application/pls+xml");
  expect(out).not.toContain("RIPEMD-160");
  expect(out).not.toContain("<lexicon");
});

// ---------- General behavior ----------

test("idempotent — running twice yields the same output", () => {
  const html = `<meta name="author-email" content="x@y.com" />
<p>hi</p>
<script type="text/narration" data-chapter-id="a">narr</script>`;
  const once = stripServedHtml(html);
  const twice = stripServedHtml(once);
  expect(twice).toBe(once);
});

test("returns the input unchanged when no targets are present", () => {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><title>x</title></head>
<body><p>hello</p></body></html>`;
  expect(stripServedHtml(html)).toBe(html);
});

test("empty input doesn't throw", () => {
  expect(stripServedHtml("")).toBe("");
});

test("removes the element node while leaving siblings intact", () => {
  // HTMLRewriter strips the element but does not touch surrounding
  // whitespace text nodes — the line where the tag used to be may
  // become a blank/indented line, which is inert in HTML and not
  // worth post-processing. What matters is the tag is gone and the
  // sibling structure is preserved.
  const html = `<head>
    <meta name="author-email" content="me@example.com" />
    <title>x</title>
</head>`;
  const out = stripServedHtml(html);
  expect(out).not.toContain("author-email");
  expect(out).not.toContain("me@example.com");
  expect(out).toContain("<title>x</title>");
  expect(out).toContain("</head>");
});

// ---------- End-to-end realistic example ----------

test("end-to-end: post HTML loses three tag types, keeps everything else", () => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="author-email" content="me@example.com" />
<title>What is a hash function?</title>
<link rel="stylesheet" href="../client/narrator.css" />
<script type="module" src="../client/narrator.ts"></script>

<script type="application/pls+xml">
<lexicon version="1.0">
  <lexeme><grapheme>RIPEMD-160</grapheme><alias>RIPE-M-D-1-60</alias></lexeme>
</lexicon>
</script>

<script type="text/narration" data-chapter-id="intro" data-chapter-title="Welcome">
  <mark name="title"/>
  Welcome to the post.
</script>
</head>
<body>
  <article>
    <h1 id="title">What is a hash function?</h1>
    <p>The article body stays.</p>
  </article>
</body>
</html>`;
  const out = stripServedHtml(html);
  // Stripped:
  expect(out).not.toContain("author-email");
  expect(out).not.toContain("me@example.com");
  expect(out).not.toContain("application/pls+xml");
  expect(out).not.toContain("RIPEMD-160");
  expect(out).not.toContain("text/narration");
  expect(out).not.toContain("Welcome to the post");
  // Preserved:
  expect(out).toContain("<title>What is a hash function?</title>");
  expect(out).toContain('rel="stylesheet"');
  expect(out).toContain('type="module"');
  expect(out).toContain('id="title"');
  expect(out).toContain("The article body stays");
});
