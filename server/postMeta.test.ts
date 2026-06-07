import { describe, expect, test } from "bun:test";
import { parseAuthorEmailFromHtml, createPostMetaIndex, isPostAuthor } from "./postMeta.ts";

describe("parseAuthorEmailFromHtml", () => {
  test("reads the conventional name-then-content order", () => {
    const html = `<head><meta name="author-email" content="a@b.com"></head>`;
    expect(parseAuthorEmailFromHtml(html)).toBe("a@b.com");
  });

  test("reads the reversed content-then-name order", () => {
    const html = `<head><meta content="a@b.com" name="author-email"></head>`;
    expect(parseAuthorEmailFromHtml(html)).toBe("a@b.com");
  });

  test("tolerates other attributes interleaved between name and content", () => {
    const html = `<meta name="author-email" data-x="1" id="ae" content="a@b.com">`;
    expect(parseAuthorEmailFromHtml(html)).toBe("a@b.com");
  });

  test("accepts single-quoted and unquoted-ish real-world markup", () => {
    expect(parseAuthorEmailFromHtml(`<meta name='author-email' content='a@b.com'>`)).toBe("a@b.com");
  });

  test("trims surrounding whitespace in the content value", () => {
    expect(parseAuthorEmailFromHtml(`<meta name="author-email" content="  a@b.com  ">`)).toBe("a@b.com");
  });

  test("ignores unrelated meta tags and a similarly-named attribute", () => {
    const html = `
      <meta name="description" content="not an email">
      <meta name="data-author-email" content="decoy@b.com">
      <meta name="author-email" content="real@b.com">`;
    expect(parseAuthorEmailFromHtml(html)).toBe("real@b.com");
  });

  test("first author-email wins when duplicated", () => {
    const html = `<meta name="author-email" content="first@b.com"><meta name="author-email" content="second@b.com">`;
    expect(parseAuthorEmailFromHtml(html)).toBe("first@b.com");
  });

  test("an author-email meta with empty content is skipped, not matched", () => {
    const html = `<meta name="author-email" content=""><meta name="author-email" content="real@b.com">`;
    expect(parseAuthorEmailFromHtml(html)).toBe("real@b.com");
  });

  test("returns null when there is no author-email meta", () => {
    expect(parseAuthorEmailFromHtml(`<head><title>x</title></head>`)).toBeNull();
  });

  test("does not match the literal string inside a script/text body", () => {
    // A real parser does not see attribute syntax inside script text — a regex
    // scanning the raw string could be fooled by this.
    const html = `<script>const s = '<meta name="author-email" content="evil@b.com">';</script>`;
    expect(parseAuthorEmailFromHtml(html)).toBeNull();
  });
});

describe("createPostMetaIndex / isPostAuthor", () => {
  test("lowercases stored emails and matches verified sessions case-insensitively", () => {
    const idx = createPostMetaIndex({ "/posts/x": { authorEmail: "  A@B.com " } });
    const meta = idx.get("/posts/x");
    expect(meta?.authorEmail).toBe("a@b.com");
    expect(isPostAuthor({ email: "a@b.COM", emailVerified: true }, meta)).toBe(true);
    expect(isPostAuthor({ email: "a@b.com", emailVerified: false }, meta)).toBe(false);
    expect(isPostAuthor({ email: "other@b.com", emailVerified: true }, meta)).toBe(false);
    expect(isPostAuthor(null, meta)).toBe(false);
    expect(idx.get("/posts/missing")).toBeNull();
  });
});
