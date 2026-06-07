import { test, expect } from "bun:test";
import { auditPostHtml, validateHtmlStructure } from "./audit-posts.ts";

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

// --- html-validate structural sub-check (validateHtmlStructure) ---

const ruleIds = (v: { rule: string }[]) => v.map((x) => x.rule);

test("structural check passes clean served markup with no errors or warnings", async () => {
  const { errors, warnings } = await validateHtmlStructure(CLEAN);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test("flags a duplicate id as a hard error (breaks aria-labelledby/fragments/anchors)", async () => {
  const dup = CLEAN.replace("</article>", '<span id="dup"></span><span id="dup"></span></article>');
  const { errors } = await validateHtmlStructure(dup);
  expect(ruleIds(errors)).toContain("no-dup-id");
});

test("flags invalid HTML5 nesting as a hard error", async () => {
  // a block <div> inside a <p> is not permitted content
  const bad = CLEAN.replace("<h1>A Post</h1>", "<h1>A Post</h1><p><div>nope</div></p>");
  const { errors } = await validateHtmlStructure(bad);
  expect(errors.length).toBeGreaterThan(0);
});

test("flags a skipped heading level as a hard error", async () => {
  const skip = CLEAN.replace("<h1>A Post</h1>", "<h1>A Post</h1><h3>jumped past h2</h3>");
  const { errors } = await validateHtmlStructure(skip);
  expect(ruleIds(errors)).toContain("heading-level");
});

test("flags aria-label on a roleless element as an error, cleared by a supporting role", async () => {
  // aria-label on a roleless <div> is an ineffective accessible name — a hard error.
  const misuse = CLEAN.replace("</article>", '<div aria-label="Chapters"></div></article>');
  expect(ruleIds((await validateHtmlStructure(misuse)).errors)).toContain("aria-label-misuse");
  // a role that supports a name makes the label valid — the chapter-strip fix
  // (role="group"). No error and no warning remain.
  const fixed = CLEAN.replace("</article>", '<div role="group" aria-label="Chapters"></div></article>');
  const { errors, warnings } = await validateHtmlStructure(fixed);
  expect(ruleIds(errors)).not.toContain("aria-label-misuse");
  expect(ruleIds(warnings)).not.toContain("aria-label-misuse");
});
