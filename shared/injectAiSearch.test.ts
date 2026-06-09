// Coverage for the AI-search landing injector: markup shape, placement before
// the post list (and the no-post-list fallback), the bundled <script> in <head>,
// data-site-url baking, and idempotence.

import { expect, test } from "bun:test";

import { buildAiSearchHtml, injectAiSearch } from "./injectAiSearch.ts";

const LANDING =
  `<!DOCTYPE html><html><head><title>t</title></head><body><main>` +
  `<h1>Blog</h1><p>Tagline</p>` +
  `<ul class="posts"><li><a href="/posts/x">X</a></li></ul>` +
  `</main></body></html>`;

test("buildAiSearchHtml: carries the marker, both providers, and the input", () => {
  const html = buildAiSearchHtml();
  expect(html).toContain('class="presidocs-ai-search"');
  expect(html).toContain('class="ai-search-input"');
  expect(html).toContain('data-provider="claude"');
  expect(html).toContain('data-provider="chatgpt"');
  expect(html).toContain('href="https://claude.ai/new"');
  expect(html).toContain('href="https://chatgpt.com/"');
  // Provider hand-off is a navigation, not a cross-origin form submit.
  expect(html).not.toContain('action="https://');
});

test("buildAiSearchHtml: bakes data-site-url only when a siteUrl is given", () => {
  expect(buildAiSearchHtml({ siteUrl: "https://blog.example.com" })).toContain(
    'data-site-url="https://blog.example.com"',
  );
  expect(buildAiSearchHtml({ siteUrl: null })).not.toContain("data-site-url");
  expect(buildAiSearchHtml()).not.toContain("data-site-url");
});

test("injectAiSearch: inserts the section before <ul class=posts>", () => {
  const out = injectAiSearch(LANDING);
  expect(out).toContain('class="presidocs-ai-search"');
  expect(out.indexOf("presidocs-ai-search")).toBeLessThan(out.indexOf('class="posts"'));
});

test("injectAiSearch: injects the client <script> into <head>", () => {
  const out = injectAiSearch(LANDING);
  expect(out).toContain('src="./engine/client/aiSearch.ts"');
  expect(out.indexOf("aiSearch.ts")).toBeLessThan(out.indexOf("</head>"));
});

test("injectAiSearch: no post list → appended to the end of <main>", () => {
  const noPosts = `<html><head></head><body><main><h1>B</h1></main></body></html>`;
  const out = injectAiSearch(noPosts);
  expect(out).toContain("presidocs-ai-search");
  expect(out.indexOf("presidocs-ai-search")).toBeGreaterThan(out.indexOf("<h1>"));
});

test("injectAiSearch: idempotent — one section, one script on a second pass", () => {
  const once = injectAiSearch(LANDING, { siteUrl: "https://blog.example.com" });
  const twice = injectAiSearch(once, { siteUrl: "https://blog.example.com" });
  expect(twice).toBe(once);
  expect((twice.match(/class="presidocs-ai-search"/g) ?? []).length).toBe(1);
  expect((twice.match(/aiSearch\.ts/g) ?? []).length).toBe(1);
});
