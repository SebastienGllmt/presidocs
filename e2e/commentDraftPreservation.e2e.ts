// Tier-2 e2e: a half-typed comment must survive opening ANOTHER comment.
//
// Regression guard for the bug where starting a reply to a saved thread and
// then opening a NEW comment wiped the reply. Root cause: a reply's
// in-progress text lived only in its DOM <textarea>, while opening a new
// comment runs `renderAll()`, which tears down and rebuilds every card. That
// rebuild only rescued the *focused* composer (the capture/restore pass) — but
// making a text selection to open the new comment blurs the reply box first,
// so the rebuilt reply card came back empty. Drafts never had this problem
// because their body is replayed from an in-memory buffer on every render; the
// fix gives saved-thread replies the same buffer (`replyBodies`).
//
// This drives the real system end to end (minted dev session, real selection →
// "Comment" → submit → reply flow, real CRDT store + render pipeline). It
// faithfully reproduces the user gesture: the reply textarea is blurred before
// the second selection, exactly as dragging to select in the article body does
// — without that, the focus-based capture/restore would mask the bug.
//
// Chromium-only: the draft-preservation logic is plain, engine-agnostic JS
// (no CSS Anchor Positioning involved), so the cross-engine matrix that
// commentPositioning.e2e.ts runs would add cost without coverage.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Page } from "playwright";
import { mintSessionCookie, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const CHROME = process.env.PRESIDOCS_E2E_CHROME || "/usr/bin/google-chrome";

let server: BlogServer;
let nonce = 0; // distinct seed identity per test → isolation in the persisted store

beforeAll(async () => {
  server = await startBlogServer();
});
afterAll(async () => {
  await server?.stop();
});

/** Navigate to a post, retrying past the dev server's brief post-routes regen window. */
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

/** Indices of normal article paragraphs (real prose, not inside a figure). */
async function normalParagraphIndices(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")];
    const out: number[] = [];
    blocks.forEach((b, i) => {
      if (
        b.tagName === "P" &&
        !b.closest("figure") &&
        !b.closest(".narrate-drawer") &&
        (b.textContent ?? "").trim().length > 80
      ) {
        out.push(i);
      }
    });
    return out;
  });
}

/** Select a span of text inside the `blockIndex`-th commentable block. */
async function selectInBlock(page: Page, blockIndex: number): Promise<void> {
  const ok = await page.evaluate((idx) => {
    const block = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")][idx];
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
    range.setEnd(best, Math.min(28, (best.textContent ?? "").length));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }, blockIndex);
  expect(ok, `block ${blockIndex} should be a commentable text block`).toBe(true);
  await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-comment").waitFor({ state: "visible", timeout: 5000 });
}

/** Click the floating "Comment" pill (mousedown handler, so the selection survives). */
async function openCommentForSelection(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.querySelector(".cmt-action-comment")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );
}

/** Full selection → "Comment" → fill → submit flow, leaving a SAVED thread. */
async function seedThreadViaUI(page: Page, blockIndex: number, body: string): Promise<void> {
  await selectInBlock(page, blockIndex);
  await openCommentForSelection(page);
  const draft = page.locator('.cmt-card[data-draft="true"]');
  await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
  await draft.locator("textarea").fill(body);
  await draft.locator(".cmt-reply-submit").click();
  await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

test("[chromium] a half-typed reply survives opening a new comment", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `reply-keep-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);

    // A saved thread to reply to.
    await seedThreadViaUI(page, blocks[0]!, "the original comment");

    const saved = page.locator('.cmt-card:not([data-draft])');
    await saved.locator(".cmt-reply-input").waitFor({ state: "visible", timeout: 5000 });
    const threadId = await saved.first().getAttribute("data-thread-id");
    expect(threadId, "the saved thread has an id").toBeTruthy();

    // Start a reply — but DON'T submit it.
    const REPLY = "a reply I have not finished writing yet";
    await saved.locator(".cmt-reply-input").fill(REPLY);

    // Mimic the real gesture: dragging to select article text first blurs the
    // reply box. Without this blur, the focus-based capture/restore in
    // renderAll would rescue the text on its own and mask the regression.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Open a NEW comment on a different paragraph.
    await selectInBlock(page, blocks[Math.floor(blocks.length * 0.6)]!);
    await openCommentForSelection(page);
    await page.locator('.cmt-card[data-draft="true"] textarea').waitFor({ state: "visible", timeout: 5000 });

    // The in-progress reply must still be there in the original thread's card.
    const stillThere = await page.evaluate((id) => {
      const card = document.querySelector<HTMLElement>(`.cmt-card[data-thread-id="${id}"]`);
      const ta = card?.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
      return ta ? ta.value : null;
    }, threadId);

    expect(stillThere, "the half-typed reply must survive opening a new comment").toBe(REPLY);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// Companion guard for the case the report says still works — opening a new
// comment while ALREADY composing another (draft → draft). Drafts persist
// their body to a buffer per keystroke, so this path was never broken; the
// test pins that behavior so a future refactor of the buffer logic can't
// regress it alongside the reply fix.
test("[chromium] an in-progress draft survives opening another new comment", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `draft-keep-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);

    // Open a first draft and type into it (no submit).
    await selectInBlock(page, blocks[0]!);
    await openCommentForSelection(page);
    const firstDraft = page.locator('.cmt-card[data-draft="true"]');
    await firstDraft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    const firstId = await firstDraft.first().getAttribute("data-thread-id");
    const DRAFT = "a brand new comment, still mid-thought";
    await firstDraft.locator("textarea").fill(DRAFT);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Open a SECOND new comment elsewhere.
    await selectInBlock(page, blocks[Math.floor(blocks.length * 0.6)]!);
    await openCommentForSelection(page);
    // Two draft cards now exist.
    await page.locator('.cmt-card[data-draft="true"]').nth(1).waitFor({ state: "visible", timeout: 5000 });

    const stillThere = await page.evaluate((id) => {
      const card = document.querySelector<HTMLElement>(`.cmt-card[data-thread-id="${id}"]`);
      const ta = card?.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
      return ta ? ta.value : null;
    }, firstId);

    expect(stillThere, "the first draft's text must survive opening a second comment").toBe(DRAFT);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// Esc on an untouched new comment discards it — the light-dismiss users
// expect from a popover, extended to the desktop column card. The guard:
// once there's text in the box, Esc is inert so typed work is never lost.
test("[chromium] Esc discards an empty new comment but keeps one with text", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `esc-cancel-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);

    // Open an empty new comment, then press Esc — the draft should vanish.
    await selectInBlock(page, blocks[0]!);
    await openCommentForSelection(page);
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    await draft.locator("textarea").press("Escape");
    await draft.waitFor({ state: "detached", timeout: 5000 });
    expect(await draft.count(), "Esc on an empty new comment discards it").toBe(0);

    // Open another, type into it, then press Esc — it must NOT be discarded.
    await selectInBlock(page, blocks[Math.floor(blocks.length * 0.6)]!);
    await openCommentForSelection(page);
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    const TYPED = "I have started writing this one";
    await draft.locator("textarea").fill(TYPED);
    await draft.locator("textarea").press("Escape");
    await page.waitForTimeout(300);

    expect(await draft.count(), "Esc must NOT discard a new comment that has text").toBe(1);
    expect(
      await draft.locator("textarea").inputValue(),
      "the typed text is untouched after the inert Esc",
    ).toBe(TYPED);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// The dev-only test seam (`installTestHooks`, gated on __BUN_DEV__) exposed by
// the comment system so the suite can drive the two render paths
// deterministically: `forceRender` = an unconditional full re-render (the
// capture/restore path a delta-bearing background render relies on);
// `backgroundRender` = the guarded involuntary path (skip-on-no-delta + defer-
// during-IME). No user gesture produces a no-op background render, and timing
// the real 60s poll in a test is flaky — hence the seam.
type CmtTestHooks = { forceRender: () => void; backgroundRender: () => void };

// C4 — a live reply survives a delta-bearing re-render with text, caret, and
// focus intact, and the viewport doesn't jump. This is the capture/restore
// contract (the `preventScroll` focus snapshot); it guards that the Phase 1/2
// refactor never breaks the case a background render *does* have to redraw
// (e.g. a foreign reply lands) while you're typing.
test("[chromium] a live reply survives a re-render — text, caret, focus, no viewport jump", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `live-reply-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    await seedThreadViaUI(page, blocks[0]!, "the original comment");
    await page.locator('.cmt-card:not([data-draft]) .cmt-reply-input').waitFor({ state: "visible", timeout: 5000 });

    const REPLY = "half typed reply";
    const before = await page.evaluate((reply) => {
      const ta = document.querySelector<HTMLTextAreaElement>('.cmt-card:not([data-draft]) .cmt-reply-input')!;
      ta.focus();
      ta.value = reply;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.setSelectionRange(4, 4); // caret mid-word
      return { scrollY: window.scrollY };
    }, REPLY);

    // A full re-render fires while the reply is focused (stands in for a poll
    // tick that pulled a real change).
    await page.evaluate(() =>
      (window as unknown as { __cmtTest: CmtTestHooks }).__cmtTest.forceRender(),
    );

    const after = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.cmt-card:not([data-draft]) .cmt-reply-input');
      const active = document.activeElement;
      return {
        value: ta?.value ?? null,
        focused: !!ta && active === ta,
        caret: ta ? ta.selectionStart : -1,
        scrollY: window.scrollY,
      };
    });

    expect(after.value, "the in-progress reply text survives the re-render").toBe(REPLY);
    expect(after.focused, "focus returns to the reply box").toBe(true);
    expect(after.caret, "caret position is preserved").toBe(4);
    expect(after.scrollY, "the re-render must not yank the viewport").toBe(before.scrollY);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// C5 — Phase 1: a background poll that pulled NOTHING NEW must not tear the
// live composer down at all. We tag the textarea element and assert the tag
// (and focus/caret) survive — proving the no-delta render was skipped, not
// merely reconstructed.
test("[chromium] a no-delta background poll does not rebuild the live composer", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `noop-poll-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    await seedThreadViaUI(page, blocks[0]!, "the original comment");
    await page.locator('.cmt-card:not([data-draft]) .cmt-reply-input').waitFor({ state: "visible", timeout: 5000 });

    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement & { __identity?: string }>('.cmt-card:not([data-draft]) .cmt-reply-input')!;
      ta.focus();
      ta.value = "still writing this";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.setSelectionRange(5, 5);
      ta.__identity = "c5-marker"; // a JS prop dies with the element if rebuilt
    });

    // No new comments → signature unchanged → Phase 1 skips the teardown.
    await page.evaluate(() =>
      (window as unknown as { __cmtTest: CmtTestHooks }).__cmtTest.backgroundRender(),
    );

    const r = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement & { __identity?: string }>('.cmt-card:not([data-draft]) .cmt-reply-input');
      return {
        sameElement: ta?.__identity === "c5-marker",
        value: ta?.value ?? null,
        focused: !!ta && document.activeElement === ta,
        caret: ta ? ta.selectionStart : -1,
      };
    });

    expect(r.sameElement, "a no-delta background poll must NOT rebuild the live composer").toBe(true);
    expect(r.value, "text is untouched").toBe("still writing this");
    expect(r.focused, "focus is untouched").toBe(true);
    expect(r.caret, "caret is untouched").toBe(5);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// C6 — Phase 2: while an IME composition is active, Enter/Esc belong to the
// converter, not to us. Esc must NOT discard the draft mid-composition (it
// cancels the candidate conversion); a normal Esc still discards. `isComposing`
// is the platform signal. Matters for CJK input.
test("[chromium] Esc during IME composition doesn't discard a draft; a normal Esc does", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `ime-esc-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    await selectInBlock(page, blocks[0]!);
    await openCommentForSelection(page);
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });

    // Esc dispatched WITH isComposing set must be ignored.
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.cmt-card[data-draft="true"] .cmt-reply-input')!;
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150);
    expect(await draft.count(), "Esc mid-IME-composition must NOT discard the draft").toBe(1);

    // A normal Esc (no composition) still discards the empty draft.
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.cmt-card[data-draft="true"] .cmt-reply-input')!;
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: false, bubbles: true, cancelable: true }));
    });
    await draft.waitFor({ state: "detached", timeout: 5000 });
    expect(await draft.count(), "a normal Esc still discards the empty draft").toBe(0);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// C7 — a draft's in-progress body survives a full page reload (the localStorage
// round-trip via draftsStorage). Guards that the Phase 1 signature work didn't
// disturb draft persistence.
test("[chromium] an in-progress draft body survives a full page reload", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `draft-reload-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    await selectInBlock(page, blocks[0]!);
    await openCommentForSelection(page);
    const draft = page.locator('.cmt-card[data-draft="true"]');
    await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
    const BODY = "a draft I will reload the page on";
    await draft.locator("textarea").fill(BODY);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const draft2 = page.locator('.cmt-card[data-draft="true"]');
    await draft2.locator("textarea").waitFor({ state: "visible", timeout: 8000 });
    expect(
      await draft2.locator("textarea").inputValue(),
      "the draft body is restored from localStorage after reload",
    ).toBe(BODY);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);
