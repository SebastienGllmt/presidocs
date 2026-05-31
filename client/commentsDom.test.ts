// Tier 1.2 — happy-dom coverage of the pure helpers that drive comment
// indexing, stale-anchor hashing, mobile-popover placement, and the
// hide-all FAB's localStorage pref.
//
// Class-level behavior (cards-column layout, selection-driven draft
// creation, the second-click-hide latch) requires standing up the full
// CommentSystem with stubs for the CRDT store, sync layer, and identity
// — out of scope here; see the proposal-19 manual checklist for the
// real-browser side of those.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import {
  BLOCK_TAGS,
  computePopoverPositionForRect,
  loadHighlightsHidden,
  normalizeText,
  POPOVER_MIN_HEIGHT_PX,
  POPOVER_TOP_MARGIN_PX,
  saveHighlightsHidden,
  walkBlocks,
} from "./commentsDom.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

// ---- normalizeText (hash-stability primitive) ------------------------

test("normalizeText — collapses runs of whitespace and trims", () => {
  expect(normalizeText("  hello   world  ")).toBe("hello world");
});

test("normalizeText — newlines and tabs collapse like spaces (source wrap is irrelevant)", () => {
  expect(normalizeText("hello\n\nworld\tagain")).toBe("hello world again");
});

test("normalizeText — empty / whitespace-only inputs become empty", () => {
  expect(normalizeText("")).toBe("");
  expect(normalizeText("   \n\t  ")).toBe("");
});

test("normalizeText — preserves single spaces between words (no over-collapse)", () => {
  expect(normalizeText("the quick brown fox")).toBe("the quick brown fox");
});

test("normalizeText — case and unicode form are preserved (deliberate)", () => {
  // The hash is over what readers see; renormalizing case would silently
  // make "Foo" and "foo" the same content, surprising the author.
  expect(normalizeText("Hello World")).toBe("Hello World");
  expect(normalizeText("café")).toBe("café");
});

// ---- walkBlocks (commentable-block indexer) --------------------------

test("walkBlocks — yields direct children in document order (BLOCK_TAGS subset)", () => {
  document.body.innerHTML = `
    <article>
      <h2 id="h">Heading</h2>
      <p id="p1">para one</p>
      <p id="p2">para two</p>
    </article>
  `;
  const root = document.querySelector("article")!;
  const ids = Array.from(walkBlocks(root, BLOCK_TAGS)).map((el) => el.id);
  expect(ids).toEqual(["h", "p1", "p2"]);
});

test("walkBlocks — depth-first walks INTO non-matching containers (<div>, <section>)", () => {
  document.body.innerHTML = `
    <article>
      <section>
        <p id="p1">in section</p>
        <div><p id="p2">in nested div</p></div>
      </section>
      <p id="p3">outside section</p>
    </article>
  `;
  const root = document.querySelector("article")!;
  const ids = Array.from(walkBlocks(root, BLOCK_TAGS)).map((el) => el.id);
  expect(ids).toEqual(["p1", "p2", "p3"]);
});

test("walkBlocks — does NOT recurse into a matched block (no nested <p> inside <p>)", () => {
  // The "leaves only" rule from methodology — a matched block is a leaf
  // for the walker, so a synthetic nested case (which we wouldn't author
  // but might encounter mid-edit) still indexes the outer block once.
  document.body.innerHTML = `
    <article>
      <blockquote id="bq">outer<p id="inner-p">inner</p></blockquote>
    </article>
  `;
  const root = document.querySelector("article")!;
  const ids = Array.from(walkBlocks(root, BLOCK_TAGS)).map((el) => el.id);
  expect(ids).toEqual(["bq"]);
});

test("walkBlocks — skips <script> and <style> subtrees entirely", () => {
  document.body.innerHTML = `
    <article>
      <p id="p1">visible</p>
      <script>
        // <p id="trap">should-not-yield</p>  (RAWTEXT, but defensive)
      </script>
      <style>
        p#trap2 { display: block }
      </style>
      <p id="p2">visible-too</p>
    </article>
  `;
  const root = document.querySelector("article")!;
  const ids = Array.from(walkBlocks(root, BLOCK_TAGS)).map((el) => el.id);
  expect(ids).toEqual(["p1", "p2"]);
});

test("walkBlocks — empty root yields nothing", () => {
  document.body.innerHTML = `<article></article>`;
  const root = document.querySelector("article")!;
  expect(Array.from(walkBlocks(root, BLOCK_TAGS))).toEqual([]);
});

test("walkBlocks — root itself is NOT yielded even when it would match", () => {
  // A `<p>` root walked over its own descendants must not yield itself
  // (the walker yields blocks INSIDE root, not root). Defensive against
  // a caller that hands in a paragraph by mistake.
  document.body.innerHTML = `<p id="r"><span id="x">x</span></p>`;
  const root = document.querySelector("p")!;
  expect(Array.from(walkBlocks(root, BLOCK_TAGS))).toEqual([]);
});

// ---- computePopoverPositionForRect (mobile popover math) -------------

test("placeholder anchor with plenty of room below → places below, top set", () => {
  // Viewport 800, dock 100, anchor at y=100..130 → spaceBelow ≈ 562,
  // far above MIN_HEIGHT. Choose `below`.
  const pos = computePopoverPositionForRect(
    { top: 100, bottom: 130 },
    { viewportHeight: 800, dockHeight: 100 },
  );
  expect(pos.top).toBeDefined();
  expect(pos.bottom).toBeUndefined();
  // top is rect.bottom + GAP (130 + 8 = 138).
  expect(pos.top).toBe("138px");
  expect(parseInt(pos.maxHeight, 10)).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT_PX);
});

test("anchor near viewport bottom (no room below) → places above, bottom set", () => {
  // Viewport 800, dock 100, anchor at y=700..730 → spaceBelow ≈ -38
  // (overlapped with the dock reserve); spaceAbove ≈ 676. Flip to above.
  const pos = computePopoverPositionForRect(
    { top: 700, bottom: 730 },
    { viewportHeight: 800, dockHeight: 100 },
  );
  expect(pos.top).toBeUndefined();
  expect(pos.bottom).toBeDefined();
  expect(parseInt(pos.maxHeight, 10)).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT_PX);
});

test("anchor flush at the top — placeBelow wins because spaceAbove is tiny", () => {
  // Anchor at y=0..20 → spaceAbove = 0 - 16 - 8 = -24; spaceBelow is
  // huge. Below is the choice.
  const pos = computePopoverPositionForRect(
    { top: 0, bottom: 20 },
    { viewportHeight: 800, dockHeight: 100 },
  );
  expect(pos.top).toBeDefined();
  // Clamped to TOP_MARGIN minimum so the popover never crosses the
  // viewport's top edge.
  expect(parseInt(pos.top!, 10)).toBeGreaterThanOrEqual(POPOVER_TOP_MARGIN_PX);
});

test("maxHeight never falls below MIN_HEIGHT (even in cramped layout)", () => {
  // Vanishingly thin viewport (300px) with a big dock (200px) leaves
  // negative spaceBelow. We still must report at least MIN_HEIGHT so the
  // popover renders something usable rather than collapsing to 0.
  const pos = computePopoverPositionForRect(
    { top: 50, bottom: 80 },
    { viewportHeight: 300, dockHeight: 200 },
  );
  expect(parseInt(pos.maxHeight, 10)).toBeGreaterThanOrEqual(POPOVER_MIN_HEIGHT_PX);
});

test("zero dock + plenty of viewport → 'below' has nearly the full viewport", () => {
  // Dock isn't always mounted (passive readers, opt-out posts). The
  // positioner must still produce a coherent placement.
  const pos = computePopoverPositionForRect(
    { top: 200, bottom: 230 },
    { viewportHeight: 1000, dockHeight: 0 },
  );
  expect(pos.top).toBeDefined();
  // spaceBelow ≈ 1000 - 24 - 230 - 8 = 738
  expect(parseInt(pos.maxHeight, 10)).toBe(738);
});

// ---- hide-all FAB localStorage round-trip ----------------------------

const inMemoryStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
};

test("loadHighlightsHidden — absent ⇒ false (default visible)", () => {
  expect(loadHighlightsHidden(inMemoryStorage())).toBe(false);
});

test("loadHighlightsHidden — '1' ⇒ true", () => {
  const s = inMemoryStorage();
  s.setItem("blog-comments-highlights-hidden", "1");
  expect(loadHighlightsHidden(s)).toBe(true);
});

test("loadHighlightsHidden — '0' ⇒ false (explicit visible)", () => {
  const s = inMemoryStorage();
  s.setItem("blog-comments-highlights-hidden", "0");
  expect(loadHighlightsHidden(s)).toBe(false);
});

test("loadHighlightsHidden — anything else ⇒ false (only '1' is special)", () => {
  // Defensive: a future feature writing a third sentinel must NOT
  // accidentally hide the highlights.
  const s = inMemoryStorage();
  s.setItem("blog-comments-highlights-hidden", "true");
  expect(loadHighlightsHidden(s)).toBe(false);
});

test("loadHighlightsHidden — null storage and throw-on-read both ⇒ false", () => {
  expect(loadHighlightsHidden(null)).toBe(false);
  expect(loadHighlightsHidden(undefined)).toBe(false);
  const throwy: Storage = {
    ...inMemoryStorage(),
    getItem: () => {
      throw new Error("disabled");
    },
  };
  expect(loadHighlightsHidden(throwy)).toBe(false);
});

test("saveHighlightsHidden — round-trip true then load reads true", () => {
  const s = inMemoryStorage();
  saveHighlightsHidden(s, true);
  expect(loadHighlightsHidden(s)).toBe(true);
});

test("saveHighlightsHidden — round-trip false then load reads false (toggle-back)", () => {
  // The common toggle-on-then-off-again flow has to land back at
  // "visible" cleanly, not at the default.
  const s = inMemoryStorage();
  saveHighlightsHidden(s, true);
  saveHighlightsHidden(s, false);
  expect(loadHighlightsHidden(s)).toBe(false);
});

test("saveHighlightsHidden — storage throw is swallowed (best-effort persistence)", () => {
  const throwy = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  // Must not throw — the in-memory class state is still authoritative
  // for this session, only the next page load loses the preference.
  expect(() => saveHighlightsHidden(throwy, true)).not.toThrow();
});
