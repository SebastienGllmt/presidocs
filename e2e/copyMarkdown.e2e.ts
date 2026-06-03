// Tier-1 e2e for the "Copy as Markdown" split control (client/copyMarkdown.ts).
//
// This is surface A — the shipped feature — exercised end to end in a real
// browser: the control renders in the byline slot, the caret opens a menu with
// both actions, "Copy as Markdown" fetches the build-time `/posts/<slug>.md`
// and writes it to the clipboard (asserted two ways: the button flips to
// "Copied!", which only fires on a successful clipboard write, AND the
// clipboard text is the expected Markdown), and "View as Markdown" links the
// `.md` twin in a new tab. None of this is observable under happy-dom (no real
// click/clipboard, no layout), so it lives in the e2e tier.
//
// Assertions use bun:test's `expect` on resolved locator queries (not
// Playwright's web-first matchers, which bun:test doesn't provide) — the same
// style as articleA11y.e2e.ts; `locator.waitFor` / `page.waitForFunction` do
// the waiting.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchChrome, startBlogServer, type BlogServer } from "./harness.ts";

let browser: Browser;
let context: BrowserContext;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
  // Clipboard write/read need an explicit grant in headless Chromium; scope it
  // to the blog origin. The async Clipboard API then resolves instead of
  // rejecting (which is what the module's execCommand fallback is for in prod).
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

/** Open the landing page and follow the first post link — blog-agnostic. */
async function openFirstPost(page: Page): Promise<void> {
  await page.goto(`${server.baseURL}/`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing page should link to at least one post").toBeTruthy();
  await page.goto(new URL(href!, server.baseURL).href, { waitUntil: "domcontentloaded" });
}

test("the split control renders: a Copy button + a closed More-actions menu", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    const primary = page.locator(".copy-md-primary");
    await primary.waitFor({ state: "attached", timeout: 10_000 });
    expect(await primary.textContent()).toContain("Copy as Markdown");

    const more = page.getByRole("button", { name: "More Markdown actions" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    // Menu is `hidden` until opened, so it's absent from the a11y tree.
    expect(await page.getByRole("menu").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("the caret opens a menu with Copy + View items; View links the .md twin", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);
    const more = page.getByRole("button", { name: "More Markdown actions" });
    await more.click();

    expect(await more.getAttribute("aria-expanded")).toBe("true");
    await page.locator(".copy-md-menu").waitFor({ state: "visible", timeout: 5_000 });

    expect(await page.getByRole("menuitem", { name: /Copy as Markdown/ }).count()).toBe(1);
    const view = page.getByRole("menuitem", { name: /View as Markdown/ });
    expect(await view.count()).toBe(1);

    const href = await view.getAttribute("href");
    expect(href, "View item links the post's .md twin").toMatch(/\/posts\/.+\.md$/);
    expect(await view.getAttribute("target")).toBe("_blank");

    // Escape closes the menu and returns focus to the trigger.
    await page.keyboard.press("Escape");
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "More Markdown actions",
    );
  } finally {
    await page.close();
  }
});

test("Copy writes the .md to the clipboard and flips to Copied! without resizing", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    const primary = page.locator(".copy-md-primary");
    await primary.waitFor({ state: "visible", timeout: 10_000 });
    const widthBefore = (await primary.boundingBox())!.width;

    await primary.click();

    // The button enters the copied state only after copyToClipboard() resolves
    // true — so this proves the fetch→clipboard path succeeded.
    await page.waitForFunction(
      () => document.querySelector(".copy-md-primary")?.classList.contains("copy-md-copied"),
      undefined,
      { timeout: 5_000 },
    );

    // "Copied!" is overlaid on the (wider) default label, not swapped in, so the
    // button keeps its exact size.
    const widthAfter = (await primary.boundingBox())!.width;
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(0.5);

    // And the clipboard actually holds the Markdown document (front matter +
    // title heading), matching the build artifact.
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.startsWith("---\ntitle:")).toBe(true);
    expect(clip).toContain("\n# ");
  } finally {
    await page.close();
  }
});
