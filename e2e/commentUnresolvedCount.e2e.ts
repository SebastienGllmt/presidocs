// Tier-2 e2e: the author-only unresolved-count badge and the "Draft" card tag.
//
// Regression guard for a real confusion: comments typed but never submitted are
// just *drafts* (they don't enter the CRDT, so the "N unresolved" count — which
// counts saved threads — correctly doesn't move). A draft looked almost like a
// posted card (only a thin blue frame set it apart), so it read as done. Two
// fixes are covered here: (1) every draft card carries a visible "Draft" tag;
// (2) the author's unresolved-count badge calls out unsent drafts — "N unsent
// drafts" when nothing's posted yet, or a "(+N draft)" suffix alongside the
// unresolved count once something is.
//
// Runs in *author mode* (the badge is author-only): the session is minted with
// the post's own author email so the server-authoritative isAuthor check
// passes. Chromium-only — this is DOM/text behaviour, engine-agnostic.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Page } from "playwright";
import { firstPostSlug, mintAuthorSessionCookie, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const CHROME = process.env.PRESIDOCS_E2E_CHROME || "/usr/bin/google-chrome";
const SLUG = firstPostSlug(resolveBlogDir());

let server: BlogServer;
let nonce = 0;

beforeAll(async () => { server = await startBlogServer(); });
afterAll(async () => { await server?.stop(); });

async function gotoPost(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = await page.goto(`${server.baseURL}/posts/${SLUG}`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (r && r.ok()) { await page.waitForLoadState("networkidle").catch(() => {}); return; }
    await page.waitForTimeout(700);
  }
  throw new Error(`could not load /posts/${SLUG}`);
}

async function normalParagraphIndices(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out: number[] = [];
    [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")].forEach((b, i) => {
      if (b.tagName === "P" && !b.closest("figure") && !b.closest(".narrate-drawer") && (b.textContent ?? "").trim().length > 80) out.push(i);
    });
    return out;
  });
}

/** Open a draft on the `idx`-th block (selection → "Comment" pill). Does NOT submit. */
async function openDraft(page: Page, idx: number): Promise<void> {
  await page.evaluate((i) => {
    const block = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")][i]!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let best: Node | null = null, n: Node | null;
    while ((n = walker.nextNode())) if (!best || (n.textContent ?? "").trim().length > (best.textContent ?? "").trim().length) best = n;
    const range = document.createRange();
    range.setStart(best!, 0); range.setEnd(best!, Math.min(28, (best!.textContent ?? "").length));
    const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
  }, idx);
  await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-comment").waitFor({ state: "visible", timeout: 5000 });
  await page.evaluate(() => document.querySelector(".cmt-action-comment")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await page.locator('.cmt-card[data-draft="true"] textarea').last().waitFor({ state: "visible", timeout: 5000 });
}

const badge = (page: Page) => page.locator(".cmt-unresolved-count");

test("[chromium] the badge counts unsent drafts, and draft cards are tagged", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const blogDir = resolveBlogDir();
    const cookie = await mintAuthorSessionCookie(blogDir, SLUG, `${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page);
    await page.waitForTimeout(700); // let author mode (/post-version) settle

    const blocks = await normalParagraphIndices(page);

    // Nothing posted, no drafts → no badge.
    expect(await badge(page).count(), "no badge on a fresh post with nothing to report").toBe(0);

    // Open a draft (don't submit). The card is visibly tagged "Draft", and the
    // badge appears as a drafts-only nudge — NOT silently absent.
    await openDraft(page, blocks[0]!);
    const tag = page.locator('.cmt-card[data-draft="true"] .cmt-draft-tag');
    await tag.waitFor({ state: "visible", timeout: 5000 });
    expect(await tag.textContent(), "draft cards carry a visible Draft tag").toBe("Draft");
    await page.waitForTimeout(200);
    expect(await badge(page).count(), "badge appears once there's an unsent draft").toBe(1);
    expect(await badge(page).textContent()).toBe("1 unsent draft");
    expect(await badge(page).getAttribute("data-state")).toBe("drafts");

    // Submit it → it becomes a real unresolved thread; the draft note clears.
    await page.locator('.cmt-card[data-draft="true"] .cmt-reply-input').fill("now this one is posted");
    await page.locator('.cmt-card[data-draft="true"] .cmt-reply-submit').click();
    await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    expect(await badge(page).textContent()).toBe("1 unresolved comment");

    // Start a second comment but leave it as a draft → the count keeps the
    // posted total and appends the draft suffix.
    await openDraft(page, blocks[2]!);
    await page.waitForTimeout(200);
    expect(await badge(page).textContent()).toBe("1 unresolved comment (+1 draft)");
    expect(await badge(page).getAttribute("data-state")).toBe("pending");

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);
