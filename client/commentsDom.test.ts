// Tier 1.2 — happy-dom coverage of the pure helpers that drive comment
// indexing, stale-anchor hashing, and the hide-all FAB's localStorage
// pref.
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
  loadHighlightsHidden,
  normalizeText,
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

test("walkBlocks — skips <nav> subtrees entirely (navigation chrome is not commentable)", () => {
  // The narrator drawer's outline panel is a <nav> full of LI/H3 (both in
  // BLOCK_TAGS) living INSIDE the indexed drawer root. The skip keeps those
  // out of the comment index AND keeps the positional `__b-<n>` fallback ids
  // of the blocks after the nav stable whether the nav is present or not.
  document.body.innerHTML = `
    <article>
      <p id="p1">before</p>
      <nav>
        <h3 id="trap-h">Part label</h3>
        <ol><li id="trap-li"><a href="#x">entry</a></li></ol>
      </nav>
      <p id="p2">after</p>
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
