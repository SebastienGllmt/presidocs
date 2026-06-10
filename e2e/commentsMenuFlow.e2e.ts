// Mobile comments MENU FLOW tier — the logic that the device tier
// (`mobile.e2e.ts`) doesn't directly assert, run in a plain narrow context.
// (Design: methodology → Comments → Responsive, "The single button and menu".)
//
// Why narrow-desktop, not device emulation: the mobile mode is gated purely on
// viewport width (`matchMedia("(max-width: 1099px)")` → `isMobile`), so the menu
// logic — selection capture + RETENTION across the button tap, the compose
// entry, the pending-selection cue, the no-selection hint, figure threads —
// activates at any sub-1100px viewport. And a real Playwright `.click()` fires a
// genuine `pointerdown` (where the selection is captured) before the tap
// collapses the selection, so this faithfully exercises the fragile retention
// mechanic without the cost of full device emulation. The genuine-touch surface
// (coarse pointer / no hover / real `tap()`) stays covered in `mobile.e2e.ts`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  firstPostSlug,
  launchChrome,
  mintSessionCookie,
  resolveBlogDir,
  startBlogServer,
  type BlogServer,
} from "./harness.ts";

// The deployable post the suite drives — content-agnostic (harness.firstPostSlug),
// so the same tests run against any content repo, including the engine's own
// e2e fixture (templates/content-repo).
const POST_PATH = `/posts/${firstPostSlug(resolveBlogDir())}`;

let browser: Browser;
let server: BlogServer;
let nonce = 0;

const VIEWPORT = { width: 420, height: 860 };

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
});
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function gotoPost(page: Page, path: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await page.goto(`${server.baseURL}${path}`, { waitUntil: "domcontentloaded", timeout: 8000 });
      if (resp && resp.ok()) {
        await page.waitForLoadState("networkidle").catch(() => {});
        return;
      }
    } catch {
      /* retry */
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`could not load ${path}`);
}

/** A signed-in narrow (sub-1100px → mobile-mode) context. */
async function narrowSignedIn(tag: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const cookie = await mintSessionCookie(resolveBlogDir(), `${tag}-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  return ctx;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

/** Indices of normal prose paragraphs (not in a figure / drawer). */
async function normalParagraphIndices(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")];
    const out: number[] = [];
    blocks.forEach((b, i) => {
      if (b.tagName === "P" && !b.closest("figure") && !b.closest(".narrate-drawer") && (b.textContent ?? "").trim().length > 80) {
        out.push(i);
      }
    });
    return out;
  });
}

/** Select the first ~40 chars of the longest text node in the `idx`-th block; return the selected string. */
async function selectInBlock(page: Page, idx: number): Promise<string> {
  return page.evaluate((i) => {
    const block = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")][i];
    if (!block) return "";
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let best: Node | null = null;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (!best || (n.textContent ?? "").trim().length > (best.textContent ?? "").trim().length) best = n;
    }
    if (!best) return "";
    const range = document.createRange();
    range.setStart(best, 0);
    range.setEnd(best, Math.min(40, (best.textContent ?? "").length));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  }, idx);
}

const hasSelectionCue = (page: Page) =>
  page.evaluate(() => document.body.classList.contains("cmt-has-selection"));

test("the comments button + menu activate at a sub-1100px viewport (mouse)", async () => {
  const ctx = await narrowSignedIn("menu-activate");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, POST_PATH);
    const btn = page.getByRole("button", { name: "Comments" });
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    expect(await page.evaluate(() => matchMedia("(max-width: 1099px)").matches), "viewport is in mobile mode").toBe(true);
    await btn.click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => !!document.querySelector(".cmt-menu")?.matches(":popover-open")), "the menu opens").toBe(true);
  } finally {
    await ctx.close();
  }
}, 60_000);

// THE headline flow + the load-bearing retention mechanic. Select text → the
// button cues → open the menu (a real click fires pointerdown, which captures
// the selection just before the tap collapses it) → "Leave comment on selection"
// appears with a snippet of the selection → compose opens (anchored under the
// button) → submit. After a reload, the persisted thread's quote must match the
// ORIGINALLY-selected text — proving the captured range survived the button tap.
test("select → menu → compose creates a thread on the SELECTED text (capture survives the button tap)", async () => {
  const ctx = await narrowSignedIn("menu-compose");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, POST_PATH);
    await page.locator(".cmt-comments-btn").waitFor({ state: "visible", timeout: 15_000 });
    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post has prose paragraphs").toBeGreaterThan(2);

    const selected = await selectInBlock(page, blocks[Math.floor(blocks.length * 0.5)]!);
    expect(selected.trim().length, "selected a non-trivial run of text").toBeGreaterThan(8);
    expect(await hasSelectionCue(page), "the button cues a pending selection (body.cmt-has-selection)").toBe(true);

    // A real click → pointerdown captures the live selection before it collapses.
    await page.locator(".cmt-comments-btn").click();
    const primary = page.locator(".cmt-menu .cmt-menu-item-primary");
    await primary.waitFor({ state: "visible", timeout: 5000 });
    const snippet = await page.locator(".cmt-menu-snippet").textContent();
    expect(norm(snippet), "the menu snippet shows the captured selection").toContain(norm(selected).slice(0, 20));

    await primary.click();
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    expect(
      await draft.evaluate((el) => el.style.getPropertyValue("position-anchor").trim()),
      "the draft card drops down under the button",
    ).toBe("--cmt-comments-btn");
    await draft.locator("textarea").fill("retention check");
    await draft.locator(".cmt-reply-submit").click();
    await draft.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    // Reload → the thread persisted, anchored to the text we originally selected.
    await gotoPost(page, POST_PATH);
    await page.locator(".cmt-highlight").first().waitFor({ state: "attached", timeout: 15_000 });
    const quotes = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cmt-card .cmt-quote-text")].map((e) => e.textContent ?? ""),
    );
    expect(
      quotes.some((q) => norm(q).includes(norm(selected).slice(0, 20))),
      `a thread was created on the selected text (quotes: ${quotes.map(norm).join(" | ")})`,
    ).toBe(true);
  } finally {
    await ctx.close();
  }
}, 90_000);

// Signed in with NO selection: the menu shows the hint + identity, and NO
// "Leave comment on selection" entry (there's nothing to comment on).
test("signed in with no selection, the menu shows the hint and no compose entry", async () => {
  const ctx = await narrowSignedIn("menu-hint");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, POST_PATH);
    const btn = page.getByRole("button", { name: "Comments" });
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    // Make sure there's no stray selection.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await btn.click();
    await page.waitForTimeout(200);
    expect(await page.locator(".cmt-menu .cmt-menu-item-primary").count(), "no compose entry without a selection").toBe(0);
    await page.locator(".cmt-menu .cmt-menu-hint").waitFor({ state: "visible", timeout: 5000 });
    await page.locator(".cmt-menu .cmt-menu-item", { hasText: "Sign out" }).waitFor({ state: "visible", timeout: 5000 });
  } finally {
    await ctx.close();
  }
}, 60_000);

// The pending-selection cue tracks the live selection: on when there's a
// commentable selection, off the moment it collapses.
test("the pending-selection cue (body.cmt-has-selection) follows the live selection", async () => {
  const ctx = await narrowSignedIn("menu-cue");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, POST_PATH);
    await page.locator(".cmt-comments-btn").waitFor({ state: "visible", timeout: 15_000 });
    const blocks = await normalParagraphIndices(page);

    await selectInBlock(page, blocks[Math.floor(blocks.length * 0.4)]!);
    expect(await hasSelectionCue(page), "cue is on while text is selected").toBe(true);

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.waitForTimeout(100);
    expect(await hasSelectionCue(page), "cue clears when the selection collapses").toBe(false);
  } finally {
    await ctx.close();
  }
}, 60_000);

// Proposal point 4: tapping a figure's indicator opens that figure's thread as a
// card under the button (the same one-menu surface). Seeds a graphic comment via
// the figure "+" affordance, then reloads and opens it from the indicator.
test("a figure comment opens its thread in a card under the button", async () => {
  const ctx = await narrowSignedIn("menu-figure");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, POST_PATH);
    await page.locator(".cmt-comments-btn").waitFor({ state: "visible", timeout: 15_000 });

    const addBtn = page.locator(".cmt-graphic-btn").first();
    if ((await addBtn.count()) === 0) {
      // No commentable figure on this post — nothing to assert here.
      console.warn("[menu-figure] post has no commentable figure; skipping");
      return;
    }
    await addBtn.click({ force: true });
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    await draft.locator("textarea").fill("figure comment");
    await draft.locator(".cmt-reply-submit").click();
    await draft.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    // Reload → open the figure's thread from its indicator badge.
    await gotoPost(page, POST_PATH);
    const indicator = page.locator(".cmt-graphic-indicator:not([hidden])").first();
    await indicator.waitFor({ state: "visible", timeout: 15_000 });
    await indicator.click({ force: true });
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => {
      const c = [...document.querySelectorAll<HTMLElement>(".cmt-card")].find((x) => x.matches(":popover-open"));
      return {
        count: [...document.querySelectorAll<HTMLElement>(".cmt-card")].filter((x) => x.matches(":popover-open")).length,
        anchor: c ? c.style.getPropertyValue("position-anchor").trim() : null,
        kind: c ? (c.dataset.kind ?? null) : null,
      };
    });
    expect(open.count, "tapping the figure indicator opens exactly one card").toBe(1);
    expect(open.anchor, "the figure thread drops down under the button").toBe("--cmt-comments-btn");
    expect(open.kind, "the open card is the graphic thread").toBe("graphic");
  } finally {
    await ctx.close();
  }
}, 90_000);
