// Tier-1 e2e: real CSS layout + the computed accessibility tree.
//
// These are the cheapest, least-flaky thing a real browser buys us (see
// methodology → Testing layout): no playback, no auth, no prod build — just
// "does Chromium compute the layout and a11y tree the audit assumed?" Both
// assertions are things happy-dom CANNOT make: it returns zeroed rects and
// builds no accessibility tree at all.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchChrome, startBlogServer, type BlogServer } from "./harness.ts";

let browser: Browser;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

/** Open the landing page and follow the first post link — blog-agnostic. */
async function openFirstPost(page: Page): Promise<void> {
  await page.goto(`${server.baseURL}/`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing page should link to at least one post").toBeTruthy();
  await page.goto(new URL(href!, server.baseURL).href, { waitUntil: "domcontentloaded" });
}

test("article renders with real (non-zero) CSS layout", async () => {
  const page = await browser.newPage();
  try {
    await openFirstPost(page);
    const h1 = page.locator("h1").first();
    const box = await h1.boundingBox();
    // happy-dom returns null / zeros here; a real engine lays the heading out.
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test("comments column is a 'complementary' landmark named Comments — never a feed", async () => {
  const page = await browser.newPage();
  try {
    await openFirstPost(page);

    // The column mounts client-side after identity load — wait for it.
    const column = page.getByRole("complementary", { name: "Comments" });
    await column.waitFor({ state: "attached", timeout: 10_000 });
    expect(await column.count()).toBeGreaterThan(0);

    // The audit explicitly rejected the tempting role="feed" upgrade. Guard it:
    // a future contributor "improving" the column to a feed (which would make a
    // screen reader announce a misleading "item X of Y") fails right here.
    expect(await page.getByRole("feed").count()).toBe(0);
  } finally {
    await page.close();
  }
});
