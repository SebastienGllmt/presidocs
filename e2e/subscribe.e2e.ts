// Tier-1 e2e for the subscribe split-controls (client/subscribe.ts), exercised
// in a real browser. The harness serves a content repo whose post HAS narration
// audio (a committed content-addressed manifest the dev server resolves), so
// BOTH controls render: the podcast control (gated on that audio) and the
// always-present article-feed control. We assert each renders, its menu carries
// the expected actions with the matching help deep-link, and the primary
// buttons copy the canonical `/podcast.xml` / `/feed.xml` — plus the podcast
// menu's per-episode "Copy episode audio" item copies the MP3. The
// audio-less-post path (article control alone) is unit-tested in
// client/subscribe.test.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchChrome, startBlogServer, type BlogServer } from "./harness.ts";

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

test("both controls render on an audio post: podcast + article feed", async () => {
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

test("podcast menu carries the four actions + the podcast help deep-link", async () => {
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

test("primary buttons copy the canonical feed URLs", async () => {
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

test("the podcast menu's Copy episode audio copies this episode's MP3", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    const more = page.getByRole("button", { name: "More podcast actions" });
    await more.waitFor({ state: "attached", timeout: 10_000 });
    await more.click();

    await page.getByRole("menuitem", { name: /Copy episode audio/ }).click();
    await waitForCopied(page, "Copy podcast feed"); // the podcast primary flashes
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\.mp3$/);
  } finally {
    await page.close();
  }
});
