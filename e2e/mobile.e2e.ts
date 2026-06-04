// Mobile tier: behaviour that only appears under real device emulation — a
// touch device with a coarse pointer and no hover, at a phone-width viewport.
//
// The other e2e tiers run a desktop context (1400×900 mouse). A narrow viewport
// alone does NOT reproduce a phone: it keeps a fine pointer and `hover: hover`,
// so `@media (pointer: coarse)` / `(hover: none)` rules and touch-only input go
// untested. This tier uses Playwright's device descriptor (harness MOBILE_DEVICE
// → isMobile + hasTouch + mobile UA) so the blog's mobile-only surfaces — the
// hide-all FAB (hidden ≥1100px) and the tap-to-popover comment cards — run the
// way a reader on a phone actually drives them.
//
// Chromium-only: device emulation (isMobile) is a Chromium feature, which suits
// this Chromium-primary harness. See methodology → Testing layout.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  launchChrome,
  mintSessionCookie,
  newMobileContext,
  resolveBlogDir,
  startBlogServer,
  type BlogServer,
} from "./harness.ts";

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

/** Navigate to a path, retrying past the dev server's brief post-routes regen window. */
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

/** Follow the first post link from the landing page — blog-agnostic. */
async function gotoFirstPost(page: Page): Promise<void> {
  await gotoPost(page, "/");
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing should link to a post").toBeTruthy();
  await gotoPost(page, new URL(href!, server.baseURL).pathname);
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

/**
 * Drive the real comment-creation UI on the `blockIndex`-th block — the same
 * "comment fixture" `commentPositioning.e2e.ts` uses. It works unchanged under
 * the mobile context: the selection is a programmatic `Range` (viewport-
 * agnostic) and the action-bar → draft → submit path is width-independent, so a
 * comment seeds at phone width exactly as it does on desktop. The *interaction*
 * we actually test on a real device — the tap that opens the popover — is driven
 * by `page.tap()` below, not here.
 */
async function seedThreadViaUI(page: Page, blockIndex: number, body: string): Promise<void> {
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

  await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-btn").waitFor({ state: "visible", timeout: 5000 });
  // Handler is on mousedown (so the selection isn't lost to focus first).
  await page.evaluate(() =>
    document.querySelector(".cmt-action-btn")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );

  const draft = page.locator('.cmt-card[data-draft="true"]');
  await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
  await draft.locator("textarea").fill(body);
  await draft.locator(".cmt-reply-submit").click();
  await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** Open + position state of the currently-open popover card (mobile = one at a time). */
async function openPopover(page: Page): Promise<{ count: number; anchor: string | null; positionArea: string | null; cardTop: number | null }> {
  return page.evaluate(() => {
    const open = [...document.querySelectorAll<HTMLElement>(".cmt-card")].filter((c) => c.matches(":popover-open"));
    const c = open[0];
    return {
      count: open.length,
      anchor: c ? c.style.getPropertyValue("position-anchor").trim() : null,
      positionArea: c ? getComputedStyle(c).getPropertyValue("position-area").trim() : null,
      cardTop: c ? Math.round(c.getBoundingClientRect().top) : null,
    };
  });
}

/**
 * Tap the `index`-th comment highlight on a touch device, reliably.
 *
 * Two emulation gotchas make a naive `locator.tap()` flaky for these inline
 * spans:
 *   1. Hit-test: a highlight is an inline run, and a highlight low in the
 *      article can land under the fixed narration dock — Playwright's
 *      actionability then reports the `<p>` (or the dock) "intercepts pointer
 *      events" and the tap never fires. So we `{ force: true }` and dispatch the
 *      touch at the span's centre (the same reason the 44px FAB needs force).
 *   2. Stale point: the engine sets `html { scroll-behavior: smooth }`, so a
 *      plain `scrollIntoView` animates — a force-tap fired before it settles
 *      lands at the pre-scroll coordinate and is lost. We scroll **instantly**
 *      (`behavior: "instant"`) and let it settle, so the centre we tap is final.
 */
async function tapHighlight(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const el = document.querySelectorAll<HTMLElement>(".cmt-highlight")[i];
    el?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  }, index);
  await page.waitForTimeout(350);
  await page.locator(".cmt-highlight").nth(index).tap({ force: true });
  await page.waitForTimeout(400);
}

/** Add a minted dev session to a context so it can seed comments. */
async function authorize(ctx: import("playwright").BrowserContext, tag: string): Promise<void> {
  const cookie = await mintSessionCookie(resolveBlogDir(), `${tag}-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test("the mobile context emulates a real touch device (coarse pointer, no hover, device-width)", async () => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  try {
    await gotoFirstPost(page);
    const env = await page.evaluate(() => ({
      touch: navigator.maxTouchPoints,
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      width: window.innerWidth,
    }));
    // These are exactly the things a bare narrow viewport can't fake.
    expect(env.touch, "touch points").toBeGreaterThan(0);
    expect(env.coarse, "pointer: coarse").toBe(true);
    expect(env.noHover, "hover: none").toBe(true);
    // The blog ships <meta name="viewport" content="width=device-width">, so a
    // real post lays out at the phone width — below the 1100px mobile cutoff.
    expect(env.width, "device-width layout (< 1100px)").toBeLessThan(1100);
  } finally {
    await ctx.close();
  }
});

test("the hide-all-highlights FAB is mobile-only and toggles on TAP", async () => {
  // Desktop contrast first: the FAB is display:none ≥1100px, so it's not in the
  // accessibility tree at all — proving the emulation, not the test, drives the
  // responsive rule.
  const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const dpage = await desktop.newPage();
    await gotoFirstPost(dpage);
    // Let the comment layer mount, then confirm the FAB is absent at desktop width.
    await dpage.locator('[data-narration-src], [role="main"]').first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    expect(await dpage.getByRole("button", { name: "Toggle comment highlights" }).count()).toBe(0);
  } finally {
    await desktop.close();
  }

  // Mobile: the FAB is exposed and a real touch tap toggles aria-pressed.
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-fab");
  const page = await ctx.newPage();
  try {
    await gotoFirstPost(page);
    const fab = page.getByRole("button", { name: "Toggle comment highlights" });
    await fab.waitFor({ state: "visible", timeout: 15_000 });
    const before = await fab.getAttribute("aria-pressed");
    expect(before === "true" || before === "false", "aria-pressed is a boolean").toBe(true);
    // A genuine touchscreen tap (hasTouch), not a mouse click. `force` because
    // Playwright's actionability hit-test mis-resolves the tap point on this
    // small (44px) position:fixed target under the device's 2.75 scale factor —
    // the element is already asserted visible + in the a11y tree above, and a
    // real 44px touch target is tappable; force sends the touch at its center.
    await fab.tap({ force: true });
    const after = await fab.getAttribute("aria-pressed");
    expect(after === "true" || after === "false").toBe(true);
    expect(after, "a tap flips the pressed state").not.toBe(before);
  } finally {
    await ctx.close();
  }
}, 60_000);

// Tap-to-popover placement on a REAL touch device. This is the device-emulated
// successor to the old `commentPositioning.e2e.ts` "mobile popover anchors below
// its highlight" test, which faked mobile by resizing a *desktop* context (a
// fine pointer with hover) and opened the card with a mouse `.click()`. Here the
// context is a genuine phone (coarse pointer, no hover, touch) and the card is
// opened by a real `tap()`.
//
// Regression guard for two spec bugs the original test caught: `span-inline`
// (not a real `position-area` keyword → the declaration is dropped and the
// value computes to `none`) and the desktop `top: anchor(top)` leaking into
// `:popover-open` (which would pin the popover at the anchor's top instead of
// letting `position-area: block-end span-all` place it below).
//
// Seeding note: the comment is seeded at phone width (the fixture works
// unchanged — see `seedThreadViaUI`), then we RELOAD so the page opens in a
// pristine reader state (comments rehydrated from the CRDT store, nothing
// open). On mobile a freshly-submitted card is left open as its popover, so the
// reload is what gives a clean "reader taps an existing highlight" starting
// point. The tap itself is a plain `page.tap()` (no `{ force }`, no manual
// `scrollIntoView`): a highlight is a normal-size inline span, so Playwright's
// actionability scroll + hit-test resolve it correctly — and a manual
// pre-scroll would make the immediately-following tap land stale (the click
// fires at the pre-scroll point). Contrast the FAB above, a 44px `position:
// fixed` target that genuinely needs `{ force }`.
test("a tapped highlight opens its card as a top-layer popover placed below it", async () => {
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-popover");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);
    await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.4)]!, "mobile tap-to-popover placement");

    // Reload → pristine reader state (nothing open).
    await gotoPost(page, "/posts/offer-files");
    const hl = page.locator(".cmt-highlight").first();
    await hl.waitFor({ state: "attached", timeout: 15_000 });

    // Real touch tap opens the popover. Assert visible first.
    await hl.waitFor({ state: "visible", timeout: 15_000 });
    const before = await openPopover(page);
    expect(before.count, "nothing is open before the tap").toBe(0);

    await tapHighlight(page, 0);

    const r = await openPopover(page);
    const hlBottom = await hl.evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
    expect(r.count, "tapping a highlight opens exactly one popover").toBe(1);
    // It's genuinely top-layer (the Popover API `:popover-open` state).
    expect(r.positionArea, "position-area should resolve to block-end, not be dropped").toContain("block-end");
    // Placed BELOW the anchor, not pinned at its top via a leaked desktop `top`.
    expect(
      r.cardTop!,
      `popover should sit below the highlight (card ${r.cardTop} vs highlight bottom ${hlBottom})`,
    ).toBeGreaterThanOrEqual(hlBottom - 4);
  } finally {
    await ctx.close();
  }
}, 90_000);
