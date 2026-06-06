// Mobile tier: behaviour that only appears under real device emulation — a
// touch device with a coarse pointer and no hover, at a phone-width viewport.
//
// The other e2e tiers run a desktop context (1400×900 mouse). A narrow viewport
// alone does NOT reproduce a phone: it keeps a fine pointer and `hover: hover`,
// so `@media (pointer: coarse)` / `(hover: none)` rules and touch-only input go
// untested. This tier uses Playwright's device descriptor (harness MOBILE_DEVICE
// → isMobile + hasTouch + mobile UA) so the blog's mobile-only surfaces run the
// way a reader on a phone actually drives them.
//
// Mobile comments model (methodology → Comments → Responsive): a single small top-right button
// (`.cmt-comments-btn`, hidden ≥1100px) is the only comments chrome at rest. It
// opens ONE menu (`.cmt-menu`) — identity / sign-in / "comment on selection" /
// highlight-toggle — and every thread/draft card popover drops down from the
// SAME place (re-anchored under the button). There is no floating sign-in pill
// and no over-the-selection action bar on mobile.
//
// Chromium-only: device emulation (isMobile) is a Chromium feature, which suits
// this Chromium-primary harness. See methodology → Testing layout.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  launchChrome,
  mintSessionCookie,
  MOBILE_DEVICE,
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
 * Drive the real mobile comment-creation UI on the `blockIndex`-th block.
 *
 * The mobile path: select article text → tap the corner button
 * (which captures the selection on pointerdown, before the tap collapses it) →
 * tap "Leave comment on selection" in the menu → a draft card opens. We
 * reproduce that here: set a programmatic selection, then synchronously fire the
 * button's `pointerdown` + `click` (so the captured selection can't collapse in
 * between), then tap the menu's primary action. Requires a signed-in context.
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
    // Open the menu with the selection live: pointerdown captures it, click
    // opens the menu. Both synchronous so nothing collapses the selection.
    const btn = document.querySelector<HTMLButtonElement>(".cmt-comments-btn");
    if (!btn) return false;
    btn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    btn.click();
    return true;
  }, blockIndex);
  expect(ok, `block ${blockIndex} should be a commentable text block`).toBe(true);

  // The menu's primary action exists only when a selection was captured.
  await page.locator(".cmt-menu .cmt-menu-item-primary").waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".cmt-menu .cmt-menu-item-primary").click();

  const draft = page.locator('.cmt-card[data-draft="true"]');
  await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
  await draft.locator("textarea").fill(body);
  await draft.locator(".cmt-reply-submit").click();
  await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** Open + position state of the currently-open card popover (mobile = one at a time). */
async function openPopover(page: Page): Promise<{
  count: number;
  threadId: string | null;
  anchor: string | null;
  positionArea: string | null;
  cardTop: number | null;
}> {
  return page.evaluate(() => {
    const open = [...document.querySelectorAll<HTMLElement>(".cmt-card")].filter((c) => c.matches(":popover-open"));
    const c = open[0];
    return {
      count: open.length,
      threadId: c ? (c.dataset.threadId ?? null) : null,
      anchor: c ? c.style.getPropertyValue("position-anchor").trim() : null,
      positionArea: c ? getComputedStyle(c).getPropertyValue("position-area").trim() : null,
      cardTop: c ? Math.round(c.getBoundingClientRect().top) : null,
    };
  });
}

/** Bottom edge of the corner button, in viewport coords. */
async function buttonBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const b = document.querySelector<HTMLElement>(".cmt-comments-btn");
    return b ? Math.round(b.getBoundingClientRect().bottom) : 0;
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
 *      touch at the span's centre.
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

// The single comments button is mobile-only (hidden ≥1100px, where the column is
// the affordance) and a real touch tap opens the one menu.
test("the comments button is mobile-only and opens the menu on TAP", async () => {
  // Desktop contrast first: the button is display:none ≥1100px, so it's not in
  // the accessibility tree at all — proving the emulation drives the rule.
  const desktop = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  try {
    const dpage = await desktop.newPage();
    await gotoFirstPost(dpage);
    await dpage.locator('[data-narration-src], [role="main"]').first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    expect(await dpage.getByRole("button", { name: "Comments" }).count()).toBe(0);
  } finally {
    await desktop.close();
  }

  // Mobile: the button is exposed and a real touch tap opens the menu popover.
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-btn");
  const page = await ctx.newPage();
  try {
    await gotoFirstPost(page);
    const btn = page.getByRole("button", { name: "Comments" });
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    expect(await btn.getAttribute("aria-expanded"), "menu starts closed").toBe("false");
    // A genuine touchscreen tap (hasTouch), `force` because the small (44px)
    // position:fixed target is mis-hit-tested under the device scale factor.
    await btn.tap({ force: true });
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => ({
      menu: !!document.querySelector(".cmt-menu")?.matches(":popover-open"),
      expanded: document.querySelector(".cmt-comments-btn")?.getAttribute("aria-expanded"),
    }));
    expect(open.menu, "tapping the button opens the menu popover").toBe(true);
    expect(open.expanded, "aria-expanded reflects the open menu").toBe("true");
  } finally {
    await ctx.close();
  }
}, 60_000);

// Signed in: the menu carries the identity + sign out, and there is NO persistent
// floating pill on mobile (the desktop `.cmt-identity` rail is display:none here).
test("signed in, the menu shows the identity + sign out, with no persistent pill", async () => {
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-id-in");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    const pill = await page.evaluate(() => {
      const id = document.querySelector<HTMLElement>(".cmt-identity");
      return id ? getComputedStyle(id).display : "absent";
    });
    expect(pill, "the desktop identity pill is not shown on mobile").toBe("none");

    const btn = page.getByRole("button", { name: "Comments" });
    await btn.waitFor({ state: "visible", timeout: 15_000 });
    await btn.tap({ force: true });
    await page.waitForTimeout(300);
    await page.locator(".cmt-menu .cmt-menu-item", { hasText: "Sign out" }).waitFor({ state: "visible", timeout: 5000 });
    expect(
      await page.locator(".cmt-menu .cmt-menu-name").count(),
      "the menu shows who you're signed in as",
    ).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
}, 60_000);

// Signed out: no pill, and the menu offers JIT sign-in (the only place sign-in
// is asked on mobile). Even WITH a selection captured, the logged-out menu shows
// ONLY sign-in — never a redundant "Leave comment on selection" entry that could
// just route to the sign-in already shown (we can't pre-pick the account).
test("signed out, the menu offers sign-in only — no redundant compose entry", async () => {
  const ctx = await newMobileContext(browser);
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-comments-btn").waitFor({ state: "visible", timeout: 15_000 });

    // Reproduce the exact scenario: select article text, then open the menu with
    // the selection live (pointerdown captures it, click opens) — all synchronous.
    const opened = await page.evaluate(() => {
      const block = [...document.querySelectorAll<HTMLElement>("[data-comment-block-id]")].find(
        (b) => b.tagName === "P" && !b.closest("figure") && (b.textContent ?? "").trim().length > 80,
      );
      if (!block) return false;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text) return false;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(28, (text.textContent ?? "").length));
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const btn = document.querySelector<HTMLButtonElement>(".cmt-comments-btn");
      if (!btn) return false;
      btn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      btn.click();
      return true;
    });
    expect(opened, "could set a selection and open the menu").toBe(true);
    await page.waitForTimeout(300);

    expect(
      await page.locator(".cmt-menu .cmt-identity-provider").count(),
      "the menu offers sign-in providers when logged out",
    ).toBeGreaterThanOrEqual(1);
    expect(
      await page.locator(".cmt-menu .cmt-menu-item-primary").count(),
      "no redundant 'Leave comment on selection' entry when logged out",
    ).toBe(0);
  } finally {
    await ctx.close();
  }
}, 60_000);

// Tap-to-popover placement on a REAL touch device. The card does not anchor
// below its highlight — every comment surface drops from the
// corner button, so the open card anchors to `--cmt-comments-btn` and sits below
// the button. Regression guard: the desktop `top: anchor(top)` must not leak into
// `:popover-open` (it would pin the card mid-article), and `position-area` must
// resolve (not be dropped to `none`).
test("a tapped highlight opens its card as a top-layer popover under the comments button", async () => {
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
    await hl.waitFor({ state: "visible", timeout: 15_000 });
    const before = await openPopover(page);
    expect(before.count, "nothing is open before the tap").toBe(0);

    await tapHighlight(page, 0);

    const r = await openPopover(page);
    expect(r.count, "tapping a highlight opens exactly one popover").toBe(1);
    expect(r.anchor, "the card anchors under the comments button").toBe("--cmt-comments-btn");
    // The dropdown rule resolves `block-end span-inline-start` (serialized
    // "end span-start"); the regression guard is that it isn't dropped to
    // `none` (the old `span-inline` bug) and isn't the desktop placement.
    expect(r.positionArea, "position-area resolves (not dropped to none)").not.toBe("none");
    expect(r.positionArea, "placed via the dropdown rule (span-inline-start)").toContain("span-start");
    expect(
      r.cardTop!,
      `the card drops below the button (card ${r.cardTop} vs button bottom)`,
    ).toBeGreaterThanOrEqual((await buttonBottom(page)) - 8);
  } finally {
    await ctx.close();
  }
}, 90_000);

// The canonical mobile interaction as a state machine — open, re-tap to close,
// tap a different highlight to swap. Only one card is ever a live popover. Since
// every card now anchors to the same button, we discriminate the open card by
// its `data-thread-id` (not by anchor) to prove a swap surfaced a DIFFERENT card.
test("tapping highlights drives the popover: open → re-tap closes → a different tap swaps", async () => {
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-flow");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);
    await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.3)]!, "mobile flow comment one");
    await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.6)]!, "mobile flow comment two");

    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-highlight").first().waitFor({ state: "attached", timeout: 15_000 });
    expect(await page.locator(".cmt-highlight").count(), "two seeded threads → two highlights").toBeGreaterThanOrEqual(2);
    expect((await openPopover(page)).count, "nothing open on a fresh load").toBe(0);

    // 1) Tap the first highlight → its card opens as a top-layer popover.
    await tapHighlight(page, 0);
    const first = await openPopover(page);
    expect(first.count, "tapping highlight #1 opens exactly one popover").toBe(1);
    expect(first.threadId, "the open card has a thread id").toBeTruthy();
    expect(first.positionArea, "placed under the button via the dropdown rule").not.toBe("none");

    // 2) Tap the SAME highlight again → it toggles closed.
    await tapHighlight(page, 0);
    expect((await openPopover(page)).count, "re-tapping the same highlight closes it").toBe(0);

    // 3) Reopen the first, then tap the SECOND highlight → the popover swaps.
    await tapHighlight(page, 0);
    expect((await openPopover(page)).threadId, "first reopened").toBe(first.threadId);
    await tapHighlight(page, 1);
    const swapped = await openPopover(page);
    expect(swapped.count, "still exactly one popover after the swap").toBe(1);
    expect(swapped.threadId, "a DIFFERENT card surfaced (swap, not reopen)").not.toBe(first.threadId);
  } finally {
    await ctx.close();
  }
}, 120_000);

// Anti-stacking + light-dismiss. On mobile there is no cascade: cards are
// one-at-a-time top-layer popovers. Even two comments on the same passage never
// show two stacked cards, and tapping outside light-dismisses the open one.
test("same-passage comments never stack on mobile — one popover at a time, tap-outside dismisses", async () => {
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-overlap");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    const blocks = await normalParagraphIndices(page);
    expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);
    const same = blocks[Math.floor(blocks.length * 0.4)]!;
    await seedThreadViaUI(page, same, "same-passage comment one");
    await seedThreadViaUI(page, same, "same-passage comment two");

    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-highlight").first().waitFor({ state: "attached", timeout: 15_000 });
    expect(await page.locator(".cmt-highlight").count(), "two threads → two highlights").toBeGreaterThanOrEqual(2);
    expect((await openPopover(page)).count, "nothing open on a fresh load").toBe(0);

    await tapHighlight(page, 0);
    const a = await openPopover(page);
    expect(a.count, "the first same-passage highlight opens exactly one popover").toBe(1);

    await tapHighlight(page, 1);
    const b = await openPopover(page);
    expect(b.count, "the second still shows exactly one popover — no stacking").toBe(1);
    expect(b.threadId, "it surfaced the OTHER same-passage thread, not the same one").not.toBe(a.threadId);

    // Light-dismiss: a tap outside the popover closes it. The card now drops
    // from the top-right and is ~full-width, so the top of the screen is UNDER
    // it — tap at a point just below the card's bottom edge instead (still well
    // above the narrator dock).
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await page.waitForTimeout(200);
    const pt = await page.evaluate(() => {
      const c = [...document.querySelectorAll<HTMLElement>(".cmt-card")].find((x) => x.matches(":popover-open"));
      const rect = c!.getBoundingClientRect();
      return { x: 8, y: Math.round(rect.bottom + 40) };
    });
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(400);
    expect((await openPopover(page)).count, "tapping outside light-dismisses the open popover").toBe(0);
  } finally {
    await ctx.close();
  }
}, 120_000);

// Highlight visibility is toggled from a MENU ITEM now (folded in from the old
// FAB). Hiding flattens the highlights, body.cmt-highlights-hidden is set, the
// choice persists to localStorage, and reopening the menu shows the inverse label.
test("hiding highlights from the menu flattens them and persists across reload", async () => {
  const ctx = await newMobileContext(browser);
  await authorize(ctx, "mobile-hide");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");
    const blocks = await normalParagraphIndices(page);
    await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.4)]!, "hide-highlights comment");

    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-highlight").first().waitFor({ state: "attached", timeout: 15_000 });

    const btn = page.getByRole("button", { name: "Comments" });
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await btn.tap({ force: true });
    const hide = page.locator(".cmt-menu .cmt-menu-item", { hasText: "Hide comment highlights" });
    await hide.waitFor({ state: "visible", timeout: 5000 });
    await hide.click();
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => document.body.classList.contains("cmt-highlights-hidden")),
      "highlights are flattened (body.cmt-highlights-hidden)",
    ).toBe(true);

    // Reload → the hidden choice persists (written to localStorage).
    await gotoPost(page, "/posts/offer-files");
    await page.waitForTimeout(600);
    expect(
      await page.evaluate(() => document.body.classList.contains("cmt-highlights-hidden")),
      "the hidden choice survives a reload",
    ).toBe(true);

    // Reopening the menu shows the inverse label.
    const btn2 = page.getByRole("button", { name: "Comments" });
    await btn2.tap({ force: true });
    await page.locator(".cmt-menu .cmt-menu-item", { hasText: "Show comment highlights" }).waitFor({ state: "visible", timeout: 5000 });
  } finally {
    await ctx.close();
  }
}, 120_000);

// Media emulation: `prefers-reduced-motion` and `prefers-color-scheme` carried
// by the device context. happy-dom has no media model, and these `@media` rules
// only resolve in a real engine — so this is the device tier's job.
//
// Reduced motion: the engine honors it. Site-wide, base.css drops
// `html { scroll-behavior: smooth }` to `auto`; and the mobile comment UI's card
// animation (`.cmt-card { transition: top 180ms }`) is cancelled to `none`. We
// read both, and prove the *emulation* drives them by contrasting a plain
// (no-preference) mobile context where scroll-behavior is still `smooth`.
//
// Colour scheme: the engine is **light-only by design** — so the faithful
// assertion is that with the OS asking for dark, the document still declares no
// `color-scheme` (computed `normal`).
test("media emulation: reduced-motion is honored; colour-scheme stays light-only by design", async () => {
  const ctx = await browser.newContext({ ...MOBILE_DEVICE, reducedMotion: "reduce", colorScheme: "dark" });
  await authorize(ctx, "mobile-media");
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/posts/offer-files");

    const env = await page.evaluate(() => ({
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(env.reduce, "prefers-reduced-motion: reduce is emulated").toBe(true);
    expect(env.dark, "prefers-color-scheme: dark is emulated").toBe(true);
    expect(env.scrollBehavior, "reduced motion drops smooth scrolling to auto").toBe("auto");
    expect(env.colorScheme, "engine declares no color-scheme — light-only, doesn't flip to dark").toBe("normal");

    // The mobile card animation is suppressed under reduced motion: `.cmt-card`'s
    // default `transition: top 180ms` becomes `none` (0s). Seed one card to read
    // the live computed value (not a static rule).
    const blocks = await normalParagraphIndices(page);
    await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.4)]!, "reduced-motion card");
    const cardTransition = await page
      .locator(".cmt-card")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(cardTransition, "the card's top-animation is cancelled under reduced motion").toBe("0s");
  } finally {
    await ctx.close();
  }

  // Contrast: a plain mobile context has NO reduced-motion / dark.
  const plain = await newMobileContext(browser);
  const ppage = await plain.newPage();
  try {
    await gotoPost(ppage, "/posts/offer-files");
    const env = await ppage.evaluate(() => ({
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    }));
    expect(env.reduce, "no reduced-motion preference by default").toBe(false);
    expect(env.dark, "no dark preference by default").toBe(false);
    expect(env.scrollBehavior, "without reduced motion, scrolling is smooth").toBe("smooth");
  } finally {
    await plain.close();
  }
}, 90_000);
