import { test, expect } from "bun:test";
import {
  injectArticleChromeReserve,
  hideNarrateDockForReveal,
  injectPostChrome,
} from "./articleChromeReserve.ts";

// ---- injectArticleChromeReserve (CLS: reserve the client-injected top chrome) -

const RESERVE_OPTS = {
  reserveBackLink: true,
  reserveControls: true,
  reserveByline: true,
  reservePostMeta: true,
};

test("injectArticleChromeReserve: back-link first, post-meta after #title, control zone + byline after #lede", () => {
  const out = injectArticleChromeReserve(
    `<article data-narration-src="/x"><h1 id="title">T</h1><p id="lede">l</p><p>body</p></article>`,
    "/posts/offer-files",
    RESERVE_OPTS,
  );
  // back-link prepended above the title; post-meta wedges between title and
  // lede; control zone then byline land after the lede.
  expect(out).toContain(
    `<article data-narration-src="/x"><div class="back-link-reserve" aria-hidden="true"></div><h1 id="title">T</h1><div class="post-meta-reserve" aria-hidden="true"></div><p id="lede">l</p><div class="subctl-zone"></div><div class="byline-reserve" aria-hidden="true"></div>`,
  );
});

test("injectArticleChromeReserve: no lede → post-meta, control zone, byline all after #title (document order)", () => {
  const out = injectArticleChromeReserve(
    `<article data-narration-src="/x"><h1 id="title">T</h1><p>body</p></article>`,
    "/posts/p",
    RESERVE_OPTS,
  );
  expect(out).toContain(
    `<h1 id="title">T</h1><div class="post-meta-reserve" aria-hidden="true"></div><div class="subctl-zone"></div><div class="byline-reserve" aria-hidden="true"></div>`,
  );
});

test("injectArticleChromeReserve: honours the per-element flags", () => {
  const backLinkOnly = injectArticleChromeReserve(
    `<article><h1 id="title">T</h1><p id="lede">l</p></article>`,
    "/posts/p",
    { reserveBackLink: true, reserveControls: false, reserveByline: false, reservePostMeta: false },
  );
  expect(backLinkOnly).toContain('class="back-link-reserve"');
  expect(backLinkOnly).not.toContain('class="subctl-zone"');
  expect(backLinkOnly).not.toContain('class="byline-reserve"');
  expect(backLinkOnly).not.toContain('class="post-meta-reserve"');

  // No flags → untouched.
  const noop = `<article><h1 id="title">T</h1></article>`;
  expect(
    injectArticleChromeReserve(noop, "/posts/p", {
      reserveBackLink: false,
      reserveControls: false,
      reserveByline: false,
      reservePostMeta: false,
    }),
  ).toBe(noop);
});

test("injectArticleChromeReserve: idempotent and scoped to posts", () => {
  const once = injectArticleChromeReserve(
    `<article><h1 id="title">T</h1><p id="lede">l</p></article>`,
    "/posts/p",
    RESERVE_OPTS,
  );
  expect(injectArticleChromeReserve(once, "/posts/p", RESERVE_OPTS)).toBe(once);
  // Non-post pages never get a reserve.
  const landing = `<main><article>card</article></main>`;
  expect(injectArticleChromeReserve(landing, "/index", RESERVE_OPTS)).toBe(landing);
});

// ---- hideNarrateDockForReveal (CLS: dock reveals zero-shift once mounted) ----

test("hideNarrateDockForReveal: ships the dock hidden (data-hidden + aria-hidden)", () => {
  const out = hideNarrateDockForReveal(
    `<article data-narration-src="/x"><div class="narrate-dock"><div id="narrate-player"></div></div></article>`,
    "/posts/p",
  );
  expect(out).toContain('<div class="narrate-dock" data-hidden="true" aria-hidden="true">');
});

test("hideNarrateDockForReveal: idempotent, respects an author flag, scoped to posts", () => {
  const once = hideNarrateDockForReveal(`<div class="narrate-dock"></div>`, "/posts/p");
  expect(once).toContain('data-hidden="true"');
  expect(hideNarrateDockForReveal(once, "/posts/p")).toBe(once);
  // An author-set data-hidden is left intact.
  const authored = `<div class="narrate-dock" data-hidden="false"></div>`;
  expect(hideNarrateDockForReveal(authored, "/posts/p")).toBe(authored);
  // Non-post pages untouched.
  const landing = `<div class="narrate-dock"></div>`;
  expect(hideNarrateDockForReveal(landing, "/index")).toBe(landing);
});

// ---- injectPostChrome (the one-call wrapper the plugin uses) ----------------

test("injectPostChrome: hides the dock and reserves chrome, gated by author/version", () => {
  const html = `<article data-narration-src="/x"><h1 id="title">T</h1><p id="lede">l</p><div class="narrate-dock"></div></article>`;
  const full = injectPostChrome(html, "/posts/p", { hasAuthor: true, hasVersion: true });
  expect(full).toContain('class="back-link-reserve"');
  expect(full).toContain('class="subctl-zone"');
  expect(full).toContain('class="byline-reserve"');
  expect(full).toContain('class="post-meta-reserve"');
  expect(full).toContain('<div class="narrate-dock" data-hidden="true" aria-hidden="true">');

  // No author / no version → the unconditional reserves stay, the gated ones drop.
  const gated = injectPostChrome(html, "/posts/p", { hasAuthor: false, hasVersion: false });
  expect(gated).toContain('class="back-link-reserve"');
  expect(gated).toContain('class="subctl-zone"');
  expect(gated).not.toContain('class="byline-reserve"');
  expect(gated).not.toContain('class="post-meta-reserve"');
});

test("injectPostChrome: no-op on non-post pages", () => {
  const landing = `<main><article><div class="narrate-dock"></div></article></main>`;
  expect(injectPostChrome(landing, "/index", { hasAuthor: true, hasVersion: true })).toBe(landing);
});
