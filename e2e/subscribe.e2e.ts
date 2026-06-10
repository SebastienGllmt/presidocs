// Tier-1 e2e for the subscribe split-controls (client/subscribe.ts), exercised
// in a real browser. The harness serves a content repo whose post HAS narration
// audio (a committed content-addressed manifest the dev server resolves), so
// BOTH controls render: the podcast control (gated on that audio) and the
// always-present article-feed control. We assert each renders, its menu carries
// the expected actions with the matching help deep-link, and the primary
// buttons copy the canonical `/podcast.xml` / `/feed.xml` — plus the podcast
// menu's per-episode "Copy episode audio" item copies the STABLE shareable URL
// (`…/episode.mp3`, no hash), and we then fetch that URL to assert it serves
// with revalidation (strong ETag, no immutable), a conditional 304, a ranged
// 206 that echoes the ETag, and the If-Range cross-version guard — the
// spec-critical contract from proposals/32-stable-shareable-audio-url.md.
// The audio-less-post path (article control alone) is unit-tested in
// client/subscribe.test.ts; the pure helpers in shared/stableAudio.test.ts.
//
// Audio-gated: the podcast control renders ONLY on posts with narration audio
// (a committed generated/<slug>/ manifest), which a content repo may simply
// not have — the engine's e2e fixture is narration-free by design (no TTS in
// CI). The audio tests skip on such a repo (the article-feed test still runs);
// against personal-blog the audio is committed, so they all run.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { firstPostSlug, launchChrome, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const BLOG_DIR = resolveBlogDir();
const FIRST_SLUG = firstPostSlug(BLOG_DIR);
const GEN_DIR = join(BLOG_DIR, "generated", FIRST_SLUG);
// Same signal client/subscribe.ts keys the podcast control on: the post's
// narration manifest existing (generated/<slug>/manifest*.json).
const HAS_AUDIO = existsSync(GEN_DIR) && readdirSync(GEN_DIR).some((f) => /^manifest(\..*)?\.json$/.test(f));

let browser: Browser;
let context: BrowserContext;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
  context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: server.baseURL,
  });
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
});

async function openFirstPost(page: Page): Promise<void> {
  await page.goto(`${server.baseURL}/`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing page should link to at least one post").toBeTruthy();
  await page.goto(new URL(href!, server.baseURL).href, { waitUntil: "domcontentloaded" });
}

const primaryByLabel = (page: Page, label: string) =>
  page.locator(".subctl-primary", { hasText: label });

/** Poll until the control whose primary carries `label` enters the copied state. */
function waitForCopied(page: Page, label: string) {
  return page.waitForFunction(
    (lbl) =>
      [...document.querySelectorAll(".subctl-primary")].some(
        (b) => (b.textContent ?? "").includes(lbl) && b.classList.contains("subctl-copied"),
      ),
    label,
    { timeout: 5_000 },
  );
}

test.skipIf(!HAS_AUDIO)("both controls render on an audio post: podcast + article feed", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    await primaryByLabel(page, "Copy podcast feed").waitFor({ state: "attached", timeout: 10_000 });
    await primaryByLabel(page, "Copy article feed").waitFor({ state: "attached" });

    expect(
      await page.getByRole("button", { name: "More podcast actions" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      await page.getByRole("button", { name: "More article feed actions" }).getAttribute("aria-expanded"),
    ).toBe("false");
  } finally {
    await page.close();
  }
});

test.skipIf(!HAS_AUDIO)("podcast menu carries the four actions + the podcast help deep-link", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    const more = page.getByRole("button", { name: "More podcast actions" });
    await more.waitFor({ state: "attached", timeout: 10_000 });
    await more.click();

    expect(await page.getByRole("menuitem", { name: /Open in podcast app/ }).count()).toBe(1);
    expect(await page.getByRole("menuitem", { name: /Copy podcast feed/ }).count()).toBe(1);
    expect(await page.getByRole("menuitem", { name: /Copy episode audio/ }).count()).toBe(1);

    const learn = page.getByRole("menuitem", { name: /Learn more/ });
    expect(await learn.getAttribute("href")).toMatch(/\/help#subscribe-podcast$/);
    expect(await learn.getAttribute("target")).toBe("_blank");
  } finally {
    await page.close();
  }
});

test("article menu links the article help anchor", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    const more = page.getByRole("button", { name: "More article feed actions" });
    await more.waitFor({ state: "attached", timeout: 10_000 });
    await more.click();

    expect(await page.getByRole("menuitem", { name: /Open in feed reader/ }).count()).toBe(1);
    const learn = page.getByRole("menuitem", { name: /Learn more/ });
    expect(await learn.getAttribute("href")).toMatch(/\/help#subscribe-articles$/);
  } finally {
    await page.close();
  }
});

test.skipIf(!HAS_AUDIO)("primary buttons copy the canonical feed URLs", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    const podcast = primaryByLabel(page, "Copy podcast feed");
    await podcast.waitFor({ state: "visible", timeout: 10_000 });
    await podcast.click();
    await waitForCopied(page, "Copy podcast feed");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/podcast\.xml$/);

    const article = primaryByLabel(page, "Copy article feed");
    await article.click();
    await waitForCopied(page, "Copy article feed");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/feed\.xml$/);
  } finally {
    await page.close();
  }
});

// Copy the episode audio and return the STABLE URL it wrote to the clipboard.
async function copyEpisodeAudioUrl(page: Page): Promise<string> {
  await openFirstPost(page);
  const more = page.getByRole("button", { name: "More podcast actions" });
  await more.waitFor({ state: "attached", timeout: 10_000 });
  await more.click();
  await page.getByRole("menuitem", { name: /Copy episode audio/ }).click();
  await waitForCopied(page, "Copy podcast feed"); // the podcast primary flashes
  return page.evaluate(() => navigator.clipboard.readText());
}

test.skipIf(!HAS_AUDIO)("Copy episode audio copies the STABLE episode URL (no content hash)", async () => {
  const page = await context.newPage();
  try {
    const url = await copyEpisodeAudioUrl(page);
    expect(url).toMatch(/\/generated\/[^/]+\/episode\.mp3$/);
    // The whole point: the copied link must NOT be the swept-on-rebuild hashed file.
    expect(url).not.toMatch(/\/full\.[0-9a-f]{16}\.mp3$/);
  } finally {
    await page.close();
  }
});

test.skipIf(!HAS_AUDIO)("the stable episode URL serves with revalidation (ETag, 304, ranged 206, If-Range guard)", async () => {
  const page = await context.newPage();
  try {
    const url = await copyEpisodeAudioUrl(page);

    // Plain GET: 200, strong ETag, revalidating (NOT immutable), seekable.
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    const h = res.headers();
    const etag = h["etag"] ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/); // strong: no W/ prefix
    expect(h["cache-control"]).toBe("no-cache");
    expect(h["cache-control"]).not.toContain("immutable");
    expect(h["accept-ranges"]).toBe("bytes");
    expect(h["content-type"]).toContain("audio/mpeg");
    // RFC 9530 representation digest: sha-256=:<base64>: (proposals/32 §9).
    expect(h["repr-digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);

    // Conditional GET with the matching validator → 304.
    const notModified = await page.request.get(url, { headers: { "If-None-Match": etag } });
    expect(notModified.status()).toBe(304);

    // Ranged GET → 206 that ECHOES the strong ETag (the bare-Range guard).
    const ranged = await page.request.get(url, { headers: { Range: "bytes=0-99" } });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(ranged.headers()["etag"]).toBe(etag);

    // If-Range with a STALE validator → ignore Range, serve the full 200 (so a
    // client mid-seek can't stitch bytes across a regeneration).
    const stale = await page.request.get(url, {
      headers: { Range: "bytes=0-99", "If-Range": '"deadbeefdeadbeef"' },
    });
    expect(stale.status()).toBe(200);
    expect(stale.headers()["content-range"]).toBeUndefined();

    // If-Range with the CURRENT validator → honor Range (206).
    const fresh = await page.request.get(url, {
      headers: { Range: "bytes=0-99", "If-Range": etag },
    });
    expect(fresh.status()).toBe(206);

    // HEAD → 200 (not 206) with an empty body — dev mirrors prod (RFC 9110 §9.3.2).
    const head = await page.request.fetch(url, { method: "HEAD" });
    expect(head.status()).toBe(200);
    expect((await head.body()).byteLength).toBe(0);
  } finally {
    await page.close();
  }
});
