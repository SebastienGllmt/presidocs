// Tier-1 e2e for citation deep-links (client/citationLink.ts).
//
// The directive *generation* — word-boundary expansion + uniqueness
// disambiguation — runs in `fragment-generation-utils`, which needs a real
// browser layout, `Intl.Segmenter`, and a live `Selection`; none of that exists
// under happy-dom. So the behaviours that motivated adopting the library are
// proven here, against the two failure modes a naive string emitter has:
//
//   1. WORD BOUNDARIES — a selection that STARTS MID-WORD must still produce a
//      link that actually resolves. The W3C matcher only accepts a fragment
//      bounded by word boundaries, so a mid-word `textStart` scrolls nowhere.
//      We select mid-word, copy the link, reopen it in a fresh navigation, and
//      assert the browser scrolled to it (proof the fragment resolved).
//
//   2. UNIQUENESS — a `#:~:text=` directive has no metadata slot, so a repeated
//      phrase can only be disambiguated by extending context/range. We inject a
//      duplicated phrase, select the second copy, and assert the emitted
//      directive is MORE than the bare (ambiguous) quote.
//
// Plus the prose-scoping guard: a selection inside a <figure> gets no button.
//
// Assertions use bun:test's `expect`; `locator.waitFor` / `page.waitForFunction`
// do the waiting (same style as copyMarkdown.e2e.ts).

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchChrome, startBlogServer, type BlogServer } from "./harness.ts";

let browser: Browser;
let context: BrowserContext;
let server: BlogServer;

beforeAll(async () => {
  [browser, server] = await Promise.all([launchChrome(), startBlogServer()]);
  // The copy gesture writes to the clipboard; reading it back needs an explicit
  // grant in Chromium, scoped to the blog origin (mirrors copyMarkdown.e2e.ts).
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: server.baseURL,
  });
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop();
});

/** Open the landing page and follow the first post link — blog-agnostic. */
async function openFirstPost(page: Page): Promise<string> {
  await page.goto(`${server.baseURL}/`, { waitUntil: "domcontentloaded" });
  const href = await page.locator('a[href*="/posts/"]').first().getAttribute("href");
  expect(href, "landing page should link to at least one post").toBeTruthy();
  const url = new URL(href!, server.baseURL).href;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return url;
}

/** Click the citation button and return the URL it wrote to the clipboard. */
async function copyViaButton(page: Page): Promise<string> {
  const btn = page.locator("button.citation-link-btn");
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click();
  // The copied state is only entered after copyToClipboard() resolves true — so
  // waiting for it proves the write happened before we read the clipboard.
  await page.waitForFunction(
    () => document.querySelector("button.citation-link-btn")?.classList.contains("citation-link-copied"),
    undefined,
    { timeout: 5_000 },
  );
  return page.evaluate(() => navigator.clipboard.readText());
}

test("a mid-word-start selection still yields a passage link that resolves on reload", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    // Select starting INSIDE the first word of a deep paragraph and ending on a
    // real word boundary a few words later — the exact shape that broke the
    // home-grown emitter (mid-word textStart fails the spec's word-boundary
    // check). Deep in the page so a successful resolve produces a visible scroll.
    const selected = await page.evaluate(() => {
      const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
      const ps = [...article.querySelectorAll("p")].filter((p) => {
        const tn = [...p.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().split(/\s+/).length >= 8,
        );
        return tn != null && (tn.textContent ?? "").trim().length > 40 && /^\S{4,}\s/.test((tn.textContent ?? "").trimStart());
      });
      const target = ps[ps.length - 1];
      if (!target) return null;
      const tn = [...target.childNodes].find(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().split(/\s+/).length >= 8,
      )!;
      const text = tn.textContent ?? "";
      const lead = text.length - text.trimStart().length; // leading whitespace
      const start = lead + 2; // mid first word (word is >=4 chars by the filter)
      // End at the boundary after the 5th word.
      let spaces = 0;
      let end = text.length;
      for (let i = start; i < text.length; i++) {
        if (/\s/.test(text[i]!)) {
          spaces += 1;
          if (spaces === 5) {
            end = i;
            break;
          }
        }
      }
      const range = document.createRange();
      range.setStart(tn, start);
      range.setEnd(tn, end);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range); // fires selectionchange → citationLink generates
      return text.slice(start, end);
    });
    expect(selected, "found a deep paragraph to select mid-word").toBeTruthy();

    const copied = await copyViaButton(page);
    // Generation succeeded → a precise passage link, NOT the section fallback.
    expect(copied).toContain("#:~:text=");

    // Reopen the link in a fresh navigation and confirm the browser actually
    // scrolled to the fragment. A broken (mid-word, non-matching) directive
    // would leave the page pinned at the top.
    const reader = await context.newPage();
    try {
      await reader.goto(copied, { waitUntil: "load" });
      await reader.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 5_000 });
      expect(await reader.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    } finally {
      await reader.close();
    }
  } finally {
    await page.close();
  }
});

test("a repeated phrase is disambiguated beyond the bare quote", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    // Inject the SAME phrase twice, far apart, then select the second copy. The
    // bare quote is ambiguous, so a correct emitter must add context/range; a
    // naive `text=<quote>` would silently resolve to the first copy.
    const phrase = "collide here citation marker";
    const bare = await page.evaluate((phraseText) => {
      const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
      const mk = (tail: string) => {
        const p = document.createElement("p");
        p.textContent = `Lead in ${phraseText} ${tail}.`;
        return p;
      };
      const first = mk("alpha");
      const second = mk("omega");
      article.prepend(first);
      article.append(second);

      // Select exactly the repeated phrase inside the SECOND paragraph.
      const tn = second.firstChild!;
      const text = tn.textContent ?? "";
      const idx = text.indexOf(phraseText);
      const range = document.createRange();
      range.setStart(tn, idx);
      range.setEnd(tn, idx + phraseText.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      // Confirm the bare phrase really is non-unique in the live document.
      const occurrences = (document.body.innerText.match(new RegExp(phraseText, "g")) ?? []).length;
      return occurrences;
    }, phrase);
    expect(bare, "the injected phrase appears more than once").toBeGreaterThanOrEqual(2);

    const copied = await copyViaButton(page);
    expect(copied).toContain("#:~:text=");
    const directive = decodeURIComponent(new URL(copied).hash.split(":~:text=")[1] ?? "");
    // A disambiguated directive carries context (prefix-,/,-suffix) or a range —
    // i.e. it is NOT just the bare phrase.
    expect(directive).not.toBe(phrase);
    expect(/,|-/.test(directive)).toBe(true);
  } finally {
    await page.close();
  }
});

test("a selection inside a <figure> gets no citation button (prose-scoped)", async () => {
  const page = await context.newPage();
  try {
    await openFirstPost(page);

    await page.evaluate(() => {
      const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
      const fig = document.createElement("figure");
      const cap = document.createElement("figcaption");
      cap.textContent = "A graphic caption that should not be citable as prose.";
      fig.appendChild(cap);
      article.appendChild(fig);
      const tn = cap.firstChild!;
      const range = document.createRange();
      range.setStart(tn, 2);
      range.setEnd(tn, 20);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Give the debounce + (non-)generation time to run, then assert the button
    // never showed.
    await page.waitForTimeout(500);
    const visible = await page.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>("button.citation-link-btn");
      return b ? !b.hidden : false;
    });
    expect(visible).toBe(false);
  } finally {
    await page.close();
  }
});
