// Tier-2 e2e: comment-card vertical positioning, through the REAL pipeline.
//
// Regression guard for the bug where every comment card stacks at the top of
// the page instead of sitting beside the text it annotates. Root cause: the
// cards anchor to their highlights with `top: anchor(top)`, which only
// resolves when the card's containing block contains the highlight — so the
// `.cmt-column` wrapper must NOT be a positioned box (see comments.css). When
// it was `position: absolute`, every `anchor()` fell back and the cards piled
// up at the top.
//
// This drives the real system end to end: a minted dev session, the real
// selection → "Comment" → submit flow (real CRDT store + anchoring + upload),
// then asserts each rendered card tracks its highlight. No hand-built DOM, no
// mocked rects — the kind of test the project distrusts (methodology → "tests
// that pass only against their own fake") is exactly what this avoids. It runs
// on every engine the host can launch (Chromium always; Firefox/WebKit when
// installed), because the bug lives in CSS Anchor Positioning where engines
// genuinely differ.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { mintSessionCookie, resolveBlogDir, startBlogServer, type BlogServer } from "./harness.ts";

const CHROME = process.env.PRESIDOCS_E2E_CHROME || "/usr/bin/google-chrome";

const ENGINES: Array<{ name: string; type: BrowserType; opts: Parameters<BrowserType["launch"]>[0] }> = [
  { name: "chromium", type: chromium, opts: { executablePath: CHROME, args: ["--no-sandbox"] } },
  { name: "firefox", type: firefox, opts: {} },
  { name: "webkit", type: webkit, opts: {} },
];

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
      // Main-article prose only: skip figures and the narration drawer (drawer
      // transcript blocks are a separate, transform-ed/scrolling context with
      // their own anchoring rules — not the article-comment layout under test).
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

/** Drive the real comment-creation UI on the `blockIndex`-th block. */
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

  await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-comment").waitFor({ state: "visible", timeout: 5000 });
  // Handler is on mousedown (so the selection isn't lost to focus first).
  await page.evaluate(() =>
    document.querySelector(".cmt-action-comment")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );

  const draft = page.locator('.cmt-card[data-draft="true"]');
  await draft.locator("textarea").waitFor({ state: "visible", timeout: 5000 });
  await draft.locator("textarea").fill(body);
  await draft.locator(".cmt-reply-submit").click();
  await page.locator('.cmt-card[data-draft="true"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** Per-card: its top and its matching highlight's top (document coords). */
async function positions(page: Page): Promise<Array<{ cardTop: number; highlightTop: number }>> {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".cmt-card:not([data-draft])")];
    const highlights = [...document.querySelectorAll<HTMLElement>(".cmt-highlight")];
    return cards.map((card) => {
      const anchorName = card.style.getPropertyValue("position-anchor").trim();
      const hl = highlights.find((s) => `--cmt-${s.dataset.threadId}` === anchorName);
      return {
        cardTop: Math.round(card.getBoundingClientRect().top + window.scrollY),
        highlightTop: hl ? Math.round(hl.getBoundingClientRect().top + window.scrollY) : -1,
      };
    });
  });
}

for (const engine of ENGINES) {
  test(`[${engine.name}] comment cards track their highlights (not stacked)`, async () => {
    let browser: Browser;
    try {
      browser = await engine.type.launch(engine.opts);
    } catch (err) {
      console.log(`[${engine.name}] unavailable — skipping (${(err as Error).message.split("\n")[0]})`);
      return; // graceful skip when the engine/deps aren't installed
    }
    try {
      // Unique identity per test → only this test's freshly-seeded threads are
      // visible (the dev comment store persists across runs).
      const cookie = await mintSessionCookie(resolveBlogDir(), `${engine.name}-${++nonce}-${server.baseURL.split(":").pop()}`);
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
      const page = await ctx.newPage();
      await gotoPost(page, "/posts/offer-files");

      const blocks = await normalParagraphIndices(page);
      expect(blocks.length, "post should have several normal paragraphs").toBeGreaterThan(2);

      // Seed two threads far apart vertically.
      await seedThreadViaUI(page, blocks[0]!, "first comment near the top");
      await seedThreadViaUI(page, blocks[Math.floor(blocks.length * 0.6)]!, "second comment lower down");

      // Settle before measuring: cards have a `transition: top 180ms`, so a card
      // anchored far down is mid-animation right after render — disable the
      // transition and let layout settle so we read final positions, not frames.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.addStyleTag({ content: ".cmt-card { transition: none !important }" });
      await page.waitForTimeout(600);
      const pos = await positions(page);
      console.log(`[${engine.name}]`, JSON.stringify(pos));

      expect(pos.length, "two threads should render as cards").toBeGreaterThanOrEqual(2);

      // 1) Each card sits near its highlight (anchor positioning resolved).
      for (const p of pos) {
        expect(
          Math.abs(p.cardTop - p.highlightTop),
          `[${engine.name}] card should sit near its highlight (card=${p.cardTop}, highlight=${p.highlightTop})`,
        ).toBeLessThan(140);
      }
      // 2) The cards are at clearly different heights — i.e. NOT stacked.
      const tops = pos.map((p) => p.cardTop).sort((a, b) => a - b);
      expect(
        tops[tops.length - 1]! - tops[0]!,
        `[${engine.name}] cards must not stack — tops were ${JSON.stringify(tops)}`,
      ).toBeGreaterThan(400);

      await ctx.close();
    } finally {
      await browser.close();
    }
  }, 90_000);
}

// A DRAFT (an in-progress, unsubmitted comment) must also anchor to its
// selection. It used to get no highlight, so its card fell to the top and the
// auto-focus yanked the viewport there while composing — even though the
// submitted comment landed correctly. Chromium-only: the anchor-resolution
// mechanics are already covered cross-engine above; this guards the
// draft-gets-a-highlight logic, which is engine-agnostic.
test("[chromium] an in-progress draft anchors to its selection (no scroll-to-top)", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `draft-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    const mid = blocks[Math.floor(blocks.length * 0.5)]!;

    // Open a draft but DON'T submit it.
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
    }, mid);
    expect(ok).toBe(true);

    await page.locator(".cmt-action-bar:not([hidden]) .cmt-action-comment").waitFor({ state: "visible", timeout: 5000 });
    await page.evaluate(() => document.querySelector(".cmt-action-comment")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await page.locator('.cmt-card[data-draft="true"] textarea').waitFor({ state: "visible", timeout: 5000 });
    await page.addStyleTag({ content: ".cmt-card { transition: none !important }" });
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.cmt-card[data-draft="true"]')!;
      const anchorName = card.style.getPropertyValue("position-anchor").trim();
      const hl = [...document.querySelectorAll<HTMLElement>(".cmt-highlight")].find(
        (s) => `--cmt-${s.dataset.threadId}` === anchorName,
      );
      return {
        hasHighlight: !!hl,
        cardTop: Math.round(card.getBoundingClientRect().top + window.scrollY),
        hlTop: hl ? Math.round(hl.getBoundingClientRect().top + window.scrollY) : -1,
      };
    });

    expect(r.hasHighlight, "the draft's selection should be highlighted (its anchor)").toBe(true);
    // The draft card tracks its highlight rather than collapsing to the top.
    expect(Math.abs(r.cardTop - r.hlTop), `draft card should sit near its highlight (card=${r.cardTop}, highlight=${r.hlTop})`).toBeLessThan(140);
    expect(r.hlTop, "the selection is mid-article, so the anchored card is far from the top").toBeGreaterThan(1000);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// The mobile popover's below-the-highlight placement is now covered on a REAL
// device (coarse pointer + touch `tap()`) in `e2e/mobile.e2e.ts` —
// "a tapped highlight opens its card as a top-layer popover placed below it".
// It used to live here, faking mobile by resizing this desktop context to
// 800px (which keeps a fine pointer + hover) and opening with a mouse click;
// that under-tested the touch path, so it moved to the device-emulated tier.

// The column's permanent "header" surfaces (identity card, version banner,
// version history, unresolved count) live in a fixed rail pinned to the top
// gutter. Regression guard: when the column became `position: static` (so cards
// could anchor), those in-flow surfaces must NOT fall to the bottom of the page
// — the rail keeps them pinned top-right.
test("[chromium] the comment header rail stays pinned in the top gutter, not at the page bottom", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `rail-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-rail").waitFor({ state: "attached", timeout: 10000 });

    const r = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>(".cmt-rail")!;
      const id = document.querySelector<HTMLElement>(".cmt-identity")!;
      const rr = rail.getBoundingClientRect();
      return {
        position: getComputedStyle(rail).position,
        top: Math.round(rr.top),
        right: Math.round(rr.right),
        vw: window.innerWidth,
        idInRail: rail.contains(id),
      };
    });

    expect(r.position, "rail is pinned").toBe("fixed");
    expect(r.idInRail, "the identity header lives in the rail").toBe(true);
    expect(r.top, "rail is near the top, not dumped at the page bottom").toBeLessThan(200);
    expect(r.right, "rail sits in the right gutter").toBeGreaterThan(r.vw - 120);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// The pinned rail shares the cards' gutter, so a card anchored near the top of
// the article would rest *under* it (identity card / version surfaces / unresolved
// count occluded). `adjustCardStacking` seeds the cascade with the rail's bottom
// so those cards fall below it. We force the overlap deterministically by growing
// the rail (independent of this post's exact top geometry), then assert the top
// card cleared it. Chromium-only: the stack pass is plain, engine-agnostic JS.
test("[chromium] a comment anchored under the header rail cascades below it", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `railcollide-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");
    await page.locator(".cmt-rail").waitFor({ state: "attached", timeout: 10000 });

    const blocks = await normalParagraphIndices(page);
    // Topmost prose paragraph — its card anchors highest, nearest the rail.
    await seedThreadViaUI(page, blocks[0]!, "comment near the very top");

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.addStyleTag({ content: ".cmt-card { transition: none !important }" });

    // Stage the overlap regardless of where this post's first paragraph sits:
    // grow the rail tall enough to cover the top card, then nudge the stack pass
    // (it re-runs on resize) to react to the new rail height.
    await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>(".cmt-rail")!;
      const filler = document.createElement("div");
      filler.style.height = "600px";
      rail.appendChild(filler);
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>(".cmt-rail")!.getBoundingClientRect();
      const cards = [...document.querySelectorAll<HTMLElement>(".cmt-card:not([data-draft])")];
      return {
        railBottom: Math.round(rail.bottom),
        railHeight: Math.round(rail.height),
        tops: cards.map((c) => Math.round(c.getBoundingClientRect().top)),
      };
    });
    console.log("[chromium] rail-collide:", JSON.stringify(r));

    expect(r.railHeight, "rail was grown to overlap the top card").toBeGreaterThan(400);
    expect(r.tops.length, "the seeded comment renders as a card").toBeGreaterThanOrEqual(1);
    // No card rests inside the rail's band — each clears its bottom (1px slack).
    for (const t of r.tops) {
      expect(
        t,
        `card top ${t} must sit below the rail bottom ${r.railBottom}, not under it`,
      ).toBeGreaterThanOrEqual(r.railBottom - 1);
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// Google-Docs margin-note behavior: a card is glued to its anchor's DOCUMENT
// position and scrolls off with the text — it must NOT vanish the instant the
// anchor leaves the viewport. Concretely: with the anchor scrolled just above
// the top, a stacked card (offset downward) is still on-screen and visible.
test("[chromium] cards don't vanish when their anchor scrolls off — they scroll with the document", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `gdoc-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    const sameBlock = blocks[Math.floor(blocks.length * 0.4)]!;
    // Two threads on the same passage → one cascades below the other.
    await seedThreadViaUI(page, sameBlock, "anchored comment one");
    await seedThreadViaUI(page, sameBlock, "anchored comment two");
    await page.waitForTimeout(400);

    // Scroll so the anchor highlight sits ~150px ABOVE the viewport top.
    const anchorDoc = await page.evaluate(() => {
      const h = document.querySelector<HTMLElement>(".cmt-highlight");
      return h ? Math.round(h.getBoundingClientRect().top + window.scrollY) : 0;
    });
    await page.evaluate((a) => window.scrollTo(0, a + 150), anchorDoc);
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const h = document.querySelector<HTMLElement>(".cmt-highlight")!;
      const cards = [...document.querySelectorAll<HTMLElement>(".cmt-card:not([data-draft])")];
      return {
        anchorOffTop: Math.round(h.getBoundingClientRect().top) < 0,
        anyCardOnScreen: cards.some((c) => {
          const b = c.getBoundingClientRect();
          return b.bottom > 0 && b.top < window.innerHeight && getComputedStyle(c).visibility === "visible";
        }),
      };
    });

    expect(r.anchorOffTop, "the anchor should be scrolled above the viewport").toBe(true);
    // The decoupling: a card is still visible even though its anchor isn't.
    expect(r.anyCardOnScreen, "a card must remain visible after its anchor scrolls off (not vanish with it)").toBe(true);

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);

// Two comments on the same (or overlapping) text resolve to the same anchored
// `top` and would render on top of each other. `adjustCardStacking` must push
// the lower one down so they cascade. Chromium-only: the collision pass is
// plain JS, engine-agnostic.
test("[chromium] overlapping comments cascade instead of stacking on top of each other", async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const cookie = await mintSessionCookie(resolveBlogDir(), `collide-${++nonce}-${server.baseURL.split(":").pop()}`);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await ctx.newPage();
    await gotoPost(page, "/posts/offer-files");

    const blocks = await normalParagraphIndices(page);
    const sameBlock = blocks[Math.floor(blocks.length * 0.4)]!;

    // Two threads on the SAME block — their highlights anchor at the same top.
    await seedThreadViaUI(page, sameBlock, "first comment on this passage");
    await seedThreadViaUI(page, sameBlock, "second comment on the same passage");

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(700);

    const rects = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cmt-card:not([data-draft])")].map((c) => {
        const r = c.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      }),
    );
    console.log("[chromium] overlap rects:", JSON.stringify(rects));
    expect(rects.length).toBeGreaterThanOrEqual(2);

    // Sorted top-to-bottom, each card must start at/after the previous card's
    // bottom (allowing 1px rounding) — i.e. they don't visually overlap.
    const sorted = [...rects].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i]!.top,
        `card ${i} (top ${sorted[i]!.top}) must not overlap the card above it (bottom ${sorted[i - 1]!.bottom})`,
      ).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom - 1);
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
}, 90_000);
