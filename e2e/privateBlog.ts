// Private-blog tier (methodology → Private blogs; proposal 57): drives the
// PRIVATE fixture (`templates/private-content-repo`, BLOG_PRIVATE=1) through
// a full `bun run build` — which includes `audit-private.ts`, so a green boot
// here already proves the build-time half of the privacy ledger — and then
// asserts the RUNTIME half against the built worker under `wrangler dev`:
// the discovery artifacts 404, every response carries the unconditional
// `X-Robots-Tag: noindex`, the landing leaks no post link, and the post
// itself serves normally at its capability URL.
//
// Like the other build+wrangler tiers (serviceWorker.ts, cspConsole.ts,
// brokenLinks.ts) this is named WITHOUT the `.e2e.ts` infix so the
// `bun run test:e2e` loop skips it; run via `bun run test:e2e:private`.
// It pins its own fixture (ensurePrivateFixtureBlog) instead of going through
// resolveBlogDir(): the private fixture is never the default target.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensurePrivateFixtureBlog,
  startWranglerServer,
  type BlogServer,
} from "./harness.ts";

const BLOG_DIR = ensurePrivateFixtureBlog();

// The fixture's one post — discovered, not hardcoded, so re-minting the
// fixture's token never touches this file. Its filename IS the capability.
const POST_SLUG = readdirSync(join(BLOG_DIR, "posts"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))[0]!;

let server: BlogServer;

beforeAll(async () => {
  // Full build (runs audit-private.ts — the build-time privacy proof) +
  // wrangler dev on the built worker.
  server = await startWranglerServer(BLOG_DIR);
}, 240_000);

afterAll(async () => {
  await server?.stop();
});

test("the post serves normally at its capability URL — privacy is not breakage", async () => {
  const res = await fetch(`${server.baseURL}/posts/${POST_SLUG}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("<article");
  // The build injected the noindex meta (the belt for the header's suspenders).
  expect(html).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
  // The .md twin rides the same capability.
  const md = await fetch(`${server.baseURL}/posts/${POST_SLUG}.md`);
  expect(md.status).toBe(200);
});

test("the enumeration artifacts do not exist", async () => {
  for (const path of ["/sitemap.xml", "/llms.txt", "/feed.xml", "/podcast.xml"]) {
    const res = await fetch(`${server.baseURL}${path}`);
    expect(res.status, `${path} must not exist on a private blog`).toBe(404);
  }
});

test("robots.txt exists, default-allow, no Sitemap pointer, AI crawlers denied", async () => {
  const res = await fetch(`${server.baseURL}/robots.txt`);
  expect(res.status).toBe(200);
  const body = await res.text();
  // Default-allow on purpose: a blanket Disallow would stop a crawler from
  // ever SEEING the noindex on a leaked link (URL-only indexing). The
  // index-exclusion work is the noindex header/meta.
  expect(body).toMatch(/^User-agent: \*\nAllow: \//m);
  expect(body).not.toMatch(/^Sitemap:/m);
  // Private default: ROBOTS_AI_CRAWLERS=deny (named training/answer bots).
  expect(body).toContain("User-agent: GPTBot");
});

test("every response carries the unconditional noindex header", async () => {
  for (const path of ["/", `/posts/${POST_SLUG}`, "/robots.txt", "/help"]) {
    const res = await fetch(`${server.baseURL}${path}`);
    expect(res.headers.get("X-Robots-Tag"), `${path} must be noindexed`).toBe("noindex");
  }
  // The path-stripping referrer policy (part of the capability model: an
  // outbound click from a private post leaks the origin, never the slug).
  const post = await fetch(`${server.baseURL}/posts/${POST_SLUG}`);
  expect(post.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
});

test("the landing (the one guessable URL) leaks no post link, no feeds, no Ask-this-blog", async () => {
  const res = await fetch(`${server.baseURL}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain('href="/posts/');
  expect(html).not.toContain("presidocs-ai-search");
  expect(html).not.toContain('type="application/atom+xml"');
  expect(html).not.toContain('type="application/rss+xml"');
});

test("the built dist carries the audit's guarantees on disk too", () => {
  // Redundant with audit-private.ts by design (belt and suspenders): if the
  // audit were ever accidentally dropped from the template's build script,
  // this tier still fails.
  const dist = join(BLOG_DIR, "dist");
  for (const name of ["sitemap.xml", "llms.txt", "feed.xml", "podcast.xml"]) {
    expect(readdirSync(dist), `dist/${name} must not be built`).not.toContain(name);
  }
  expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('content="noindex"');
});
