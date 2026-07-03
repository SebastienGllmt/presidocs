// Tier-2 e2e: suggestion mode — propose-an-edit comments (proposal 65,
// increment 1). Covers the whole increment-1 data model end-to-end:
//   - desktop: select → "Suggest edit" → composer with an editable proposed-text
//     box + live word-diff → submit (no note) → saved card shows the struck/
//     inserted diff, the article highlight is the green (suggestion) tint, and
//     the suggestion survives a reload.
//   - a note typed alongside the suggestion becomes a reply under the diff.
//   - logged-out: the affordance is suppressed exactly like commenting (no bar).
//   - mobile: the "Suggest edit on selection" menu entry routes through the same
//     capture path.
// Chromium-only DOM behaviour; engine-agnostic (drives firstPostSlug).

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

const POST_PATH = `/posts/${firstPostSlug(resolveBlogDir())}`;

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
    const r = await page
      .goto(`${server.baseURL}${POST_PATH}`, { waitUntil: "domcontentloaded", timeout: 8000 })
      .catch(() => null);
    if (r && r.ok()) {
      await page.waitForLoadState("networkidle").catch(() => {});
      return;
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`could not load ${POST_PATH}`);
}

async function signedIn(tag: string, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
  const cookie = await mintSessionCookie(resolveBlogDir(), `${tag}-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  return ctx;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

async function firstProseIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")];
    return blocks.findIndex(
      (b) => b.tagName === "P" && !b.closest("figure") && !b.closest(".narrate-drawer") && (b.textContent ?? "").trim().length > 80,
    );
  });
}

/** Select the first ~24 chars of the `idx`-th block's longest text node. */
async function selectInBlock(page: Page, idx: number): Promise<string> {
  return page.evaluate((i) => {
    const block = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")][i]!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let best: Node | null = null, n: Node | null;
    while ((n = walker.nextNode())) if (!best || (n.textContent ?? "").trim().length > (best.textContent ?? "").trim().length) best = n;
    const range = document.createRange();
    range.setStart(best!, 0);
    range.setEnd(best!, Math.min(24, (best!.textContent ?? "").length));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  }, idx);
}

const DESKTOP = { width: 1400, height: 900 };
const MOBILE = { width: 420, height: 860 };

// The headline flow: suggest an edit, watch the diff, submit with no note, and
// verify the persisted card + green highlight.
test("[chromium] select → Suggest edit → diff composer → submit → persisted suggestion", async () => {
  const ctx = await signedIn("suggest", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    const idx = await firstProseIndex(page);
    expect(idx, "post has a prose paragraph").toBeGreaterThanOrEqual(0);
    const selected = await selectInBlock(page, idx);
    expect(selected.trim().length).toBeGreaterThan(6);

    // Click "Suggest edit" on the floating bar (mousedown, so the selection isn't
    // lost first — same as the "Comment" pill).
    await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-suggest").waitFor({ state: "visible", timeout: 8000 });
    await page.evaluate(() => document.querySelector(".cmt-action-suggest")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const draft = page.locator('.cmt-card[data-draft="true"]');
    const proposed = draft.locator(".cmt-suggest-input");
    await proposed.waitFor({ state: "visible", timeout: 5000 });
    // Prefilled with the anchored text.
    expect(norm(await proposed.inputValue())).toBe(norm(selected));
    // A live diff preview exists.
    await draft.locator(".cmt-diff").waitFor({ state: "visible", timeout: 3000 });

    // Edit the proposal → the diff shows the inserted word.
    await proposed.fill(`${selected} EDITED`);
    await page.waitForFunction(
      () => [...document.querySelectorAll('.cmt-card[data-draft="true"] .cmt-diff-ins')].some((e) => (e.textContent ?? "").includes("EDITED")),
      { timeout: 3000 },
    );

    // Submit with NO note — a suggestion's note is optional.
    await draft.locator(".cmt-reply-submit").click();
    await draft.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    // The saved card carries the diff; the article highlight is the green tint.
    await page.locator(".cmt-highlight--suggestion").first().waitFor({ state: "attached", timeout: 5000 });
    const savedInsert = await page.locator(".cmt-card .cmt-diff-ins").first().textContent();
    expect(savedInsert).toContain("EDITED");

    // Reload → the suggestion persisted (green highlight + diff card).
    await gotoPost(page);
    await page.locator(".cmt-highlight--suggestion").first().waitFor({ state: "attached", timeout: 15_000 });
    const afterReload = await page.locator(".cmt-card .cmt-diff-ins").first().textContent();
    expect(afterReload).toContain("EDITED");
  } finally {
    await ctx.close();
  }
}, 90_000);

// A note typed alongside the suggestion is posted as a reply under the diff.
test("[chromium] a note on a suggestion becomes a reply beneath the diff", async () => {
  const ctx = await signedIn("suggest-note", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    const idx = await firstProseIndex(page);
    await selectInBlock(page, idx);
    await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-suggest").waitFor({ state: "visible", timeout: 8000 });
    await page.evaluate(() => document.querySelector(".cmt-action-suggest")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator(".cmt-suggest-input").waitFor({ state: "visible", timeout: 5000 });
    await draft.locator(".cmt-suggest-input").fill("replacement text");
    await draft.locator(".cmt-reply-input").fill("clearer wording");
    await draft.locator(".cmt-reply-submit").click();
    await draft.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

    await page.waitForFunction(
      () => [...document.querySelectorAll(".cmt-card .cmt-reply-text")].some((e) => (e.textContent ?? "").includes("clearer wording")),
      { timeout: 5000 },
    );
    // …and it lives on the same card as the diff.
    const onDiffCard = await page.evaluate(() =>
      [...document.querySelectorAll(".cmt-card")].some(
        (c) => c.querySelector(".cmt-diff") && (c.textContent ?? "").includes("clearer wording"),
      ),
    );
    expect(onDiffCard).toBe(true);
  } finally {
    await ctx.close();
  }
}, 90_000);

// Logged out: the suggest affordance is suppressed exactly like the comment one
// (the whole action bar stays hidden on selection).
test("[chromium] logged out, selecting text shows no action bar (mirrors commenting)", async () => {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    const idx = await firstProseIndex(page);
    await selectInBlock(page, idx);
    await page.waitForTimeout(300);
    expect(await page.locator(".cmt-action-bar:not([hidden])").count(), "no action bar when logged out").toBe(0);
    // The bar (and its suggest button) exist in the DOM but stay hidden — the
    // affordance is only *shown* when signed in, mirroring commenting exactly.
    expect(await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-suggest").count(), "no visible suggest button either").toBe(0);
  } finally {
    await ctx.close();
  }
}, 60_000);

// Increment 2 — in-place suggestion mode: toggle on → click a paragraph → edit
// it directly → Enter commits into an increment-1 draft. The published block is
// reverted (§3), the draft's diff carries the edit, and submitting persists it.
test("[chromium] suggestion mode: Enter posts the suggestion directly, published text reverts", async () => {
  const ctx = await signedIn("suggest-inplace", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });

    // Turn the mode on.
    await page.locator(".cmt-suggest-toggle").click();
    expect(await page.locator(".cmt-suggest-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(await page.evaluate(() => document.body.classList.contains("cmt-suggest-mode"))).toBe(true);

    // Click a prose paragraph → it becomes the editable block. (Dispatch the
    // click rather than a Playwright hit-tested click, which the article's
    // pointer-events:none comment column confuses; the handler is a normal
    // bubbling click listener either way.)
    const idx = await firstProseIndex(page);
    const block = page.locator("[data-comment-block-id]").nth(idx);
    const originalText = norm(await block.textContent());
    await page.evaluate((i) => {
      const el = [...document.querySelectorAll("[data-comment-block-id]")][i] as HTMLElement;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, idx);
    await page.locator(".cmt-editing").waitFor({ state: "visible", timeout: 5000 });
    expect(await block.getAttribute("contenteditable")).toBe("true");

    // Insert a marker word at the START of the block (deterministic non-empty
    // window — an append can land after trailing whitespace), then Enter commits.
    await page.evaluate(() => {
      const el = document.querySelector(".cmt-editing")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type("WIDGET ");
    await page.keyboard.press("Enter");

    // Enter POSTS the suggestion directly — no draft step. A green highlight and
    // a saved card with the diff appear immediately.
    await page.locator(".cmt-highlight--suggestion").first().waitFor({ state: "attached", timeout: 5000 });
    expect(await page.locator('.cmt-card[data-draft="true"]').count(), "Enter posts directly, no draft").toBe(0);
    await page.waitForFunction(
      () => [...document.querySelectorAll(".cmt-card .cmt-diff-ins")].some((e) => (e.textContent ?? "").includes("WIDGET")),
      { timeout: 5000 },
    );

    // §3 invariant: the published paragraph was reverted — the reader's edit is
    // NOT in the article DOM, only in the proposal.
    expect(await block.getAttribute("contenteditable"), "contenteditable stripped after commit").toBeNull();
    expect(norm(await block.textContent()), "published text reverted to original").toBe(originalText);
  } finally {
    await ctx.close();
  }
}, 90_000);

// Ctrl+B applies REAL bold in the editor (a rendered <b>/<strong> element, not
// literal tags), and that emphasis serializes to <strong> in the proposed text.
test("[chromium] suggestion mode: Ctrl+B renders real bold and serializes to <strong>", async () => {
  const ctx = await signedIn("suggest-bold", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".cmt-suggest-toggle").click();

    const idx = await firstProseIndex(page);
    await page.evaluate((i) => {
      const el = [...document.querySelectorAll("[data-comment-block-id]")][i] as HTMLElement;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, idx);
    await page.locator(".cmt-editing").waitFor({ state: "visible", timeout: 5000 });

    // Select the first ~5 real characters of the editable block's main text node.
    await page.evaluate(() => {
      const el = document.querySelector(".cmt-editing")!;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let best: Node | null = null, n: Node | null;
      while ((n = walker.nextNode())) if (!best || (n.textContent ?? "").trim().length > (best.textContent ?? "").trim().length) best = n;
      const t = best!.textContent ?? "";
      const s = Math.max(0, t.search(/\S/));
      const range = document.createRange();
      range.setStart(best!, s);
      range.setEnd(best!, Math.min(s + 5, t.length));
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.press("Control+b");

    // The editor now holds a REAL bold element (rendered), not literal tags.
    expect(await page.locator(".cmt-editing b, .cmt-editing strong").count(), "real bold element rendered").toBeGreaterThan(0);
    expect(await page.locator(".cmt-editing").textContent(), "no literal tags in the editor").not.toContain("<strong>");

    // Enter posts directly; the emphasis serialized to <strong>, visible as
    // literal tags in the saved card's diff.
    await page.keyboard.press("Enter");
    await page.locator(".cmt-highlight--suggestion").first().waitFor({ state: "attached", timeout: 5000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll(".cmt-card .cmt-diff-ins")].some((e) => (e.textContent ?? "").includes("<strong>")),
      { timeout: 5000 },
    );
  } finally {
    await ctx.close();
  }
}, 90_000);

// Esc reverts an in-place edit with no draft left behind.
test("[chromium] suggestion mode: Esc reverts the edit and creates no draft", async () => {
  const ctx = await signedIn("suggest-esc", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".cmt-suggest-toggle").click();
    const idx = await firstProseIndex(page);
    const block = page.locator("[data-comment-block-id]").nth(idx);
    const originalText = norm(await block.textContent());
    await page.evaluate((i) => {
      const el = [...document.querySelectorAll("[data-comment-block-id]")][i] as HTMLElement;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, idx);
    await page.locator(".cmt-editing").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => {
      const el = document.querySelector(".cmt-editing")!;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type(" SCRAP");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(await page.locator('.cmt-card[data-draft="true"]').count(), "Esc leaves no draft").toBe(0);
    expect(norm(await block.textContent()), "Esc reverts the text").toBe(originalText);
  } finally {
    await ctx.close();
  }
}, 90_000);

// Clicking away (blur) is NOT a submit — it keeps the edit as a recoverable
// draft (contrast with Enter, which posts directly).
test("[chromium] suggestion mode: clicking away keeps the edit as a draft, not posted", async () => {
  const ctx = await signedIn("suggest-blur", DESKTOP);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.locator(".cmt-suggest-toggle").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".cmt-suggest-toggle").click();
    const idx = await firstProseIndex(page);
    const block = page.locator("[data-comment-block-id]").nth(idx);
    const originalText = norm(await block.textContent());
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
    // Click away → blur.
    await page.evaluate(() => (document.querySelector(".cmt-editing") as HTMLElement | null)?.blur());

    // A recoverable DRAFT appears (editable proposed box), not a posted thread.
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator(".cmt-suggest-input").waitFor({ state: "visible", timeout: 5000 });
    expect(await draft.locator(".cmt-suggest-input").inputValue()).toContain("WIDGET");
    // §3 invariant: the published paragraph reverted regardless.
    expect(norm(await block.textContent())).toBe(originalText);
  } finally {
    await ctx.close();
  }
}, 90_000);

// Mobile: the menu offers "Suggest edit on selection" alongside the comment
// entry, and it opens a suggestion draft under the button.
test("[chromium] mobile menu offers a Suggest-edit entry that opens a suggestion draft", async () => {
  const ctx = await signedIn("suggest-mobile", MOBILE);
  const page = await ctx.newPage();
  try {
    await gotoPost(page);
    await page.locator(".cmt-comments-btn").waitFor({ state: "visible", timeout: 15_000 });
    const idx = await firstProseIndex(page);
    await selectInBlock(page, idx);
    await page.locator(".cmt-comments-btn").click();

    const suggest = page.locator(".cmt-menu .cmt-menu-item-suggest");
    await suggest.waitFor({ state: "visible", timeout: 5000 });
    await suggest.click();

    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator(".cmt-suggest-input").waitFor({ state: "visible", timeout: 5000 });
    expect(await draft.locator(".cmt-diff").count(), "the suggestion draft shows a diff preview").toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
}, 90_000);
