// Unit tests for the privacy gate's pure checkers (generate/audit-private.ts)
// — including the seeded-violation negative controls proposal 57's acceptance
// criteria call for: each rule must FIRE on its violation, not just stay
// silent on clean input. The fs/env orchestration in main() is exercised
// end-to-end by the private fixture's build (e2e/privateBlog.ts boots it).

import { test, expect } from "bun:test";
import {
  auditPrivateHtml,
  auditPrivateRobots,
  auditPrivateSlug,
  FORBIDDEN_ANNOUNCE_VARS,
  FORBIDDEN_DIST_FILES,
} from "./audit-private.ts";

const PAGE = (body: string, head = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta name="robots" content="noindex" />${head}</head><body>${body}</body></html>`;

test("post-link-leak: a non-post page linking into /posts/ fires; a post doing so does not", () => {
  const html = PAGE(`<a href="/posts/secret--Vq3xW8tR4hZcNdP5">read</a>`);
  expect(auditPrivateHtml(html, { isPost: false }).map((v) => v.rule)).toContain("post-link-leak");
  // Posts may link each other — same capability class.
  expect(auditPrivateHtml(html, { isPost: true })).toEqual([]);
  // Absolute URLs into /posts/ are caught too.
  const abs = PAGE(`<a href="https://blog.example.com/posts/secret--Vq3xW8tR4hZcNdP5">x</a>`);
  expect(auditPrivateHtml(abs, { isPost: false }).map((v) => v.rule)).toContain("post-link-leak");
  // Non-post links are fine anywhere.
  expect(auditPrivateHtml(PAGE(`<a href="/help">help</a>`), { isPost: false })).toEqual([]);
});

test("ai-search-leak: the Ask-this-blog affordance fires on a non-post page", () => {
  const html = PAGE(`<section class="presidocs-ai-search">…</section>`);
  expect(auditPrivateHtml(html, { isPost: false }).map((v) => v.rule)).toContain("ai-search-leak");
});

test("noindex-meta: missing or non-noindex robots meta fires; noindex passes", () => {
  const missing = `<!DOCTYPE html><html><head></head><body></body></html>`;
  expect(auditPrivateHtml(missing, { isPost: true }).map((v) => v.rule)).toContain("noindex-meta");
  const wrong = `<!DOCTYPE html><html><head><meta name="robots" content="index,follow" /></head><body></body></html>`;
  expect(auditPrivateHtml(wrong, { isPost: true }).map((v) => v.rule)).toContain("noindex-meta");
  expect(auditPrivateHtml(PAGE(""), { isPost: true })).toEqual([]);
});

test("slug-token: guessable slugs fire; token slugs and dev-only posts pass", () => {
  expect(auditPrivateSlug("my-secret-post")?.rule).toBe("slug-token");
  expect(auditPrivateSlug("short--abc")?.rule).toBe("slug-token"); // 3 chars < 11 floor
  expect(auditPrivateSlug("my-secret-post--Vq3xW8tR4hZcNdP5")).toBeNull(); // 16 chars
  expect(auditPrivateSlug("my-secret-post--abcDEF123_-x")).toBeNull(); // ≥11, full alphabet
  expect(auditPrivateSlug("_figjourneys")).toBeNull(); // dev-only, never deploys
});

test("robots-sitemap: a Sitemap: pointer fires; the sitemap-less private form passes", () => {
  expect(auditPrivateRobots("User-agent: *\nAllow: /\n\nSitemap: https://x/sitemap.xml\n").map((v) => v.rule)).toEqual([
    "robots-sitemap",
  ]);
  expect(auditPrivateRobots("User-agent: *\nAllow: /\n")).toEqual([]);
});

test("the ledger constants name the real artifacts/channels", () => {
  expect(FORBIDDEN_DIST_FILES).toEqual(["sitemap.xml", "llms.txt", "feed.xml", "podcast.xml"]);
  expect(FORBIDDEN_ANNOUNCE_VARS).toEqual(["DISCORD_WEBHOOK_URL", "SLACK_WEBHOOK_URL", "WEBHOOK_URL", "WEBSUB_HUB"]);
});
