// Tier-2 e2e: the comment cards' computed ACCESSIBILITY TREE (proposal 22 §2).
//
// Positioning (commentPositioning.e2e.ts) and the column landmark
// (articleA11y.e2e.ts: complementary, never feed) are already guarded. This
// locks the per-CARD a11y shape — the cheapest-highest-value real-browser
// assertion left, and one happy-dom can't make (it builds no a11y tree):
//   1. Each rendered card is an <article> (so AT announces "article", a
//      discrete annotation) — and carries NO aria-posinset / aria-setsize.
//      Those attributes belong to a `feed`/`listitem` ("item X of Y"); their
//      ABSENCE is the regression guard against a future contributor turning the
//      column into a feed (the same misread articleA11y.e2e.ts guards at the
//      column level — see methodology → Testing layout).
//   2. The "hide all highlights" control exposes a real toggle state
//      (aria-pressed) that flips on click — a button that toggles must say so.
//
// Deferred (kept out so this stays deterministic): the version-history
// <details> expanded/collapsed snapshot. That control renders only for the
// post's *author* AND only when the post has ≥2 build versions, so asserting it
// needs a seeded multi-version fixture + an author session — more setup than
// its marginal coverage is worth today. Add it when a versioned fixture exists.
//
// Chromium-only: the accessibility tree is engine-agnostic enough that the
// cross-engine matrix (which positioning runs for CSS-anchor reasons) buys
// nothing here, and Chromium is the CI-primary engine (proposal 22 §3).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { mintSessionCookie, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const CHROME = process.env.PRESIDOCS_E2E_CHROME || "/usr/bin/google-chrome";

let browser: Browser;
let server: BlogServer;
let nonce = 0;

beforeAll(async () => {
  [browser, server] = await Promise.all([
    chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] }),
    startBlogServer(),
  ]);
});
afterAll(async () => {
  await browser?.close();
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

/** Indices of normal article paragraphs (real prose, not figures/drawer). */
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

/** Drive the real comment-creation UI on the `blockIndex`-th commentable block. */
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
  await page.evaluate(() =>
    document.querySelector(".cmt-action-btn")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );

  const draft = page.locator('.cmt-card[data-draft="true"]');
  await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
  await draft.locator("textarea").fill(body);
  await draft.locator(".cmt-reply-submit").click();
  await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** A logged-in page on the first post with two seeded comment threads. */
async function pageWithTwoThreads(): Promise<Page> {
  // Desktop viewport (matches commentPositioning.e2e.ts) so the full comment
  // rail/cards layout is in play, not the mobile popover path.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const cookie = await mintSessionCookie(resolveBlogDir(), `a11y-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();

  // Follow the first post link — blog-agnostic, like articleA11y.e2e.ts.
  await gotoPost(page, "/");
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing should link to a post").toBeTruthy();
  await gotoPost(page, new URL(href!, server.baseURL).pathname);

  // Cards animate their `top` (transition: top 180ms); disabling transitions
  // keeps the submit button (and later assertions) stable, the same settling
  // commentPositioning.e2e.ts does before it measures. We assert ARIA, not
  // geometry, so removing the animation changes nothing we check.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important }" });

  const blocks = await normalParagraphIndices(page);
  expect(blocks.length, "post should have commentable paragraphs").toBeGreaterThanOrEqual(2);
  await seedThreadViaUI(page, blocks[0]!, "first a11y-snapshot comment");
  await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.6)]!, "second a11y-snapshot comment");
  await page.locator(".cmt-card:not([data-draft])").first().waitFor({ state: "attached", timeout: 5000 });
  return page;
}

test("each comment card is an <article> with no aria-posinset/aria-setsize", async () => {
  const page = await pageWithTwoThreads();
  try {
    const shape = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>(".cmt-card:not([data-draft])")];
      return cards.map((c) => ({
        tag: c.tagName,
        posinset: c.hasAttribute("aria-posinset"),
        setsize: c.hasAttribute("aria-setsize"),
      }));
    });
    expect(shape.length, "two seeded threads → at least two cards").toBeGreaterThanOrEqual(2);
    for (const c of shape) {
      // <article> ⇒ implicit role "article": a discrete annotation, not a list item.
      expect(c.tag).toBe("ARTICLE");
      // Never "item X of Y" — the column is not a feed/list (proposal 22 §2).
      expect(c.posinset).toBe(false);
      expect(c.setsize).toBe(false);
    }

    // And the accessibility tree agrees: the cards surface as `article`s inside
    // the "Comments" complementary landmark (never a feed) — getByRole queries
    // the computed a11y tree, not the DOM.
    const column = page.getByRole("complementary", { name: "Comments" });
    await column.waitFor({ state: "attached", timeout: 10_000 });
    expect(await column.getByRole("article").count()).toBeGreaterThanOrEqual(2);
    expect(await page.getByRole("feed").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 90_000); // real seeding (browser launch + 2 CRDT-uploaded comments) > 5s default

test("the hide-all-highlights control exposes aria-pressed and toggles it", async () => {
  // The hide-all FAB is a MOBILE control — `@media (min-width: 1100px)` hides it
  // (comments.css), so it's only in the a11y tree below that width. It mounts on
  // any commentable post regardless of whether comments exist, so no seeding is
  // needed — we just need the player/comment system to boot.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const cookie = await mintSessionCookie(resolveBlogDir(), `fab-${++nonce}-${server.baseURL.split(":").pop()}`);
  await ctx.addCookies([
    { name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  try {
    await gotoPost(page, "/");
    const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
    expect(href, "landing should link to a post").toBeTruthy();
    await gotoPost(page, new URL(href!, server.baseURL).pathname);

    // getByRole queries the computed a11y tree, so this also asserts the FAB is
    // actually exposed (visible) at mobile width.
    const fab = page.getByRole("button", { name: "Toggle comment highlights" });
    await fab.waitFor({ state: "visible", timeout: 15_000 });
    // A toggle button MUST expose its pressed state (WAI-ARIA): present + boolean.
    const before = await fab.getAttribute("aria-pressed");
    expect(before === "true" || before === "false", "aria-pressed is a boolean").toBe(true);
    await fab.click();
    const after = await fab.getAttribute("aria-pressed");
    expect(after === "true" || after === "false").toBe(true);
    expect(after, "clicking flips the pressed state").not.toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);
