// Tier-2 e2e: the per-paragraph "preview suggested edits" gutter toggle (proposal
// 65 addendum). Author-only (any build): create a suggestion on a paragraph, then
// the gutter toggle flips that paragraph between the published original and the
// applied view, and back. Chromium-only; runs in author mode (the toggle is
// author-gated via the server /post-version isAuthor flag).

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  firstPostSlug,
  launchChrome,
  mintAuthorSessionCookie,
  resolveBlogDir,
  startBlogServer,
  type BlogServer,
} from "./harness.ts";

const SLUG = firstPostSlug(resolveBlogDir());
const POST_PATH = `/posts/${SLUG}`;

let browser: Browser;
let server: BlogServer;
let nonce = 0;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function gotoPost(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = await page.goto(`${server.baseURL}${POST_PATH}`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (r && r.ok()) {
      await page.waitForLoadState("networkidle").catch(() => {});
      return;
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`could not load ${POST_PATH}`);
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

async function firstProseIndex(page: Page): Promise<number> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")].findIndex(
      (b) => b.tagName === "P" && !b.closest("figure") && !b.closest(".narrate-drawer") && (b.textContent ?? "").trim().length > 80,
    ),
  );
}

test("[chromium] gutter preview toggle flips a paragraph to the applied view and back", async () => {
  const blogDir = resolveBlogDir();
  const cookie = await mintAuthorSessionCookie(blogDir, SLUG, `${++nonce}-${server.baseURL.split(":").pop()}`);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.waitForTimeout(700); // let author mode (/post-version) settle
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });

    const idx = await firstProseIndex(page);
    const block = page.locator("[data-comment-block-id]").nth(idx);
    const original = norm(await block.textContent());

    // Create a suggestion on that paragraph via in-place suggestion mode.
    await page.locator(".cmt-suggest-toggle").click();
    await page.evaluate((i) => {
      const el = [...document.querySelectorAll("[data-comment-block-id]")][i] as HTMLElement;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, idx);
    await page.locator(".cmt-editing").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => {
      const el = document.querySelector(".cmt-editing")!;
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(true);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.type("WIDGET ");
    await page.keyboard.press("Enter");
    // Enter posts the suggestion directly (no draft). Leave suggest mode.
    await page.locator(".cmt-highlight--suggestion").first().waitFor({ state: "attached", timeout: 5000 });
    await page.locator(".cmt-suggest-toggle").click();

    // The gutter preview toggle now exists for that paragraph (author-only).
    const toggle = block.locator(".cmt-preview-toggle");
    await toggle.waitFor({ state: "attached", timeout: 10_000 });
    // Original text is unchanged before previewing.
    expect(norm(await block.textContent())).toBe(original);

    // Toggle ON → applied view: the block gains the previewing state, an inserted
    // marker, and the proposed word now appears in the rendered text.
    await toggle.click();
    await block.locator(".cmt-preview-ins").first().waitFor({ state: "attached", timeout: 5000 });
    expect(await block.evaluate((el) => el.classList.contains("cmt-previewing"))).toBe(true);
    expect(await block.locator(".cmt-preview-ins").textContent()).toContain("WIDGET");
    expect(norm(await block.textContent()), "applied text differs from original").not.toBe(original);

    // Toggle OFF → back to the published original, no preview artifacts.
    await toggle.click();
    await page.waitForTimeout(200);
    expect(await block.locator(".cmt-preview-ins").count()).toBe(0);
    expect(await block.evaluate((el) => el.classList.contains("cmt-previewing"))).toBe(false);
    expect(norm(await block.textContent()), "reverted to the published original").toBe(original);
  } finally {
    await ctx.close();
  }
}, 120_000);

// Regression: an UNSUBMITTED draft suggestion (created via the pill flow, which
// still drafts) must also get a preview toggle — the preview once looked only at
// the saved snapshot and missed drafts entirely.
test("[chromium] preview toggle appears for an unsubmitted (pill) draft suggestion", async () => {
  const cookie = await mintAuthorSessionCookie(resolveBlogDir(), SLUG, `${++nonce}-${server.baseURL.split(":").pop()}`);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.waitForTimeout(700);
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });
    const idx = await firstProseIndex(page);
    const block = page.locator("[data-comment-block-id]").nth(idx);

    // Select text, then "Suggest edit" → a DRAFT (do not submit).
    await page.evaluate((i) => {
      const b = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")][i]!;
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let best: Node | null = null, n: Node | null;
      while ((n = w.nextNode())) if (!best || (n.textContent ?? "").length > (best.textContent ?? "").length) best = n;
      const r = document.createRange();
      r.setStart(best!, 0);
      r.setEnd(best!, Math.min(24, (best!.textContent ?? "").length));
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }, idx);
    await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-suggest").waitFor({ state: "visible", timeout: 8000 });
    await page.evaluate(() => document.querySelector(".cmt-action-suggest")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.locator('.cmt-card[data-draft="true"] .cmt-suggest-input').waitFor({ state: "visible", timeout: 5000 });

    // The gutter toggle shows for the draft, before any submit.
    await block.locator(".cmt-preview-toggle").waitFor({ state: "attached", timeout: 10_000 });
  } finally {
    await ctx.close();
  }
}, 120_000);
