import { test, expect } from "bun:test";
import { auditPostHtml } from "./audit-posts.ts";

// A minimal post that satisfies every rule. Individual tests mutate it to
// trigger one violation at a time.
const CLEAN = `<!DOCTYPE html>
<html lang="en">
<head>
<title>A Post</title>
<meta name="description" content="A short summary." />
</head>
<body>
<article role="main">
  <h1>A Post</h1>
  <img src="/a.png" alt="a diagram" />
</article>
</body>
</html>`;

const rules = (html: string) => auditPostHtml(html).map((v) => v.rule).sort();

test("a well-formed post has no violations", () => {
  expect(auditPostHtml(CLEAN)).toEqual([]);
});

test("flags a missing/empty title", () => {
  expect(rules(CLEAN.replace("<title>A Post</title>", "<title></title>"))).toContain("title");
});

test("flags a missing html lang", () => {
  expect(rules(CLEAN.replace('<html lang="en">', "<html>"))).toContain("html-lang");
});

test("flags a missing meta description", () => {
  expect(rules(CLEAN.replace(/<meta name="description"[^>]*>/, ""))).toContain("meta-description");
});

test("flags an empty meta description", () => {
  expect(rules(CLEAN.replace('content="A short summary."', 'content="  "'))).toContain("meta-description");
});

test("flags zero main landmarks", () => {
  const v = auditPostHtml(CLEAN.replace(' role="main"', ""));
  expect(v.find((x) => x.rule === "landmark-one-main")?.detail).toContain("found 0");
});

test("flags two main landmarks", () => {
  const two = CLEAN.replace("</article>", '</article><div role="main">second</div>');
  expect(auditPostHtml(two).find((x) => x.rule === "landmark-one-main")?.detail).toContain("found 2");
});

test("a <main role=main> counts once, not twice", () => {
  const m = CLEAN.replace('<article role="main">', '<main role="main"><article>').replace(
    "</article>\n</body>",
    "</article></main>\n</body>",
  );
  expect(rules(m)).not.toContain("landmark-one-main");
});

test("flags an <img> with no alt attribute, allows alt=''", () => {
  expect(rules(CLEAN.replace('alt="a diagram"', ""))).toContain("image-alt");
  expect(rules(CLEAN.replace('alt="a diagram"', 'alt=""'))).not.toContain("image-alt");
});
