// Tier-1 e2e: the merged selection bar. For a logged-in desktop reader, the
// comment action bar hosts BOTH "Comment" and "Copy link" in one bar, and the
// standalone citation pill stays suppressed — so there are never two competing
// dark pills. (The standalone pill for logged-out readers is covered by
// citationLink.e2e.ts.)

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  launchChrome,
  startBlogServer,
  mintSessionCookie,
  resolveBlogDir,
  type BlogServer,
} from "./harness.ts";

let browser: Browser;
let context: BrowserContext;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.baseURL });
  const cookie = await mintSessionCookie(resolveBlogDir(), `citebar-${server.baseURL.split(":").pop()}`);
  await context.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
});

async function openFirstPost(page: Page): Promise<void> {
  await page.goto(`${server.baseURL}/`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  await page.goto(new URL(href!, server.baseURL).href, { waitUntil: "domcontentloaded" });
}

/** Select a chunk of the first registered comment block (raises the bar). */
async function selectCommentableText(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>("[data-comment-block-id]");
    if (!block) return false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let best: Node | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (!best || (n.textContent ?? "").trim().length > (best.textContent ?? "").trim().length) best = n;
    }
    if (!best) return false;
    const range = document.createRange();
    range.setStart(best, 0);
    range.setEnd(best, Math.min(40, (best.textContent ?? "").length));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  });
  expect(ok, "found a commentable text block to select").toBe(true);
}

test("logged-in: one bar with Comment + Copy link; standalone citation suppressed", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    // Trigger the lazy comments boot, then wait for blocks to be indexed.
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => !!document.querySelector("[data-comment-block-id]"), undefined, {
      timeout: 15_000,
    });

    await selectCommentableText(page);

    // The comment action bar appears with its "Comment" button…
    await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-comment").waitFor({
      state: "visible",
      timeout: 10_000,
    });
    // …and the "Copy link" button appears in the SAME bar once generation lands.
    const copyLink = page.locator(".cmt-action-bar .cmt-action-copylink");
    await copyLink.waitFor({ state: "visible", timeout: 10_000 });

    // Both live inside the one bar.
    expect(await page.locator(".cmt-action-bar .cmt-action-comment").count()).toBe(1);
    expect(await page.locator(".cmt-action-bar .cmt-action-copylink").count()).toBe(1);

    // The standalone citation pill stays out of the way.
    const standaloneVisible = await page.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>("button.citation-link-btn");
      return b ? !b.hidden : false;
    });
    expect(standaloneVisible, "standalone citation button must be suppressed").toBe(false);

    // Copy link writes a precise passage URL to the clipboard.
    await copyLink.dispatchEvent("mousedown");
    await page.waitForFunction(
      () => document.querySelector(".cmt-action-copylink")?.classList.contains("cmt-action-copied"),
      undefined,
      { timeout: 5_000 },
    );
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("#:~:text=");
  } finally {
    await page.close();
  }
});
