// Tier 1.2 — happy-dom coverage of the pure DOM/offset helpers extracted from
// comments.ts (workstream 4.1). These are the highlight math that anchors
// text comments: offset resolution round-trips and the wrap/unwrap reversibility
// the render engine relies on. See methodology.md → Comments.

import "../../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import {
  anchorNameForGraphic,
  anchorNameForText,
  findBlockFor,
  nodeAtOffset,
  offsetInBlock,
  unwrap,
  wrapRangeInBlock,
} from "./highlights.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

function block(html: string): HTMLElement {
  const p = document.createElement("p");
  p.innerHTML = html;
  document.body.appendChild(p);
  return p;
}

// ---- anchor-name builders (CSS <dashed-ident> safety) ----------------

test("anchorNameForText / anchorNameForGraphic — sanitize id punctuation", () => {
  expect(anchorNameForText("article:__b-3")).toBe("--cmt-article___b-3");
  expect(anchorNameForGraphic("id:fig")).toBe("--cmt-graphic-id_fig");
});

// ---- offsetInBlock / nodeAtOffset round-trip -------------------------

test("offsetInBlock ↔ nodeAtOffset — round-trip across nested nodes", () => {
  const p = block("Hello <em>brave</em> world");
  for (const charOffset of [0, 3, 6, 9, 11, 16]) {
    const at = nodeAtOffset(p, charOffset);
    expect(at).not.toBeNull();
    const back = offsetInBlock(p, at!.node, at!.offset);
    expect(back).toBe(charOffset);
  }
});

// ---- wrapRangeInBlock + unwrap reversibility -------------------------

test("wrapRangeInBlock — wraps exactly the requested character span", () => {
  const p = block("Hello brave world");
  wrapRangeInBlock(p, 6, 11, "t1"); // "brave"
  const span = p.querySelector<HTMLElement>(".cmt-highlight");
  expect(span).not.toBeNull();
  expect(span!.textContent).toBe("brave");
  expect(span!.dataset.threadId).toBe("t1");
});

test("unwrap — restores the block's text and normalizes", () => {
  const p = block("Hello brave world");
  const original = p.textContent;
  wrapRangeInBlock(p, 6, 11, "t1");
  for (const s of [...p.querySelectorAll<HTMLElement>(".cmt-highlight")]) unwrap(s);
  expect(p.querySelector(".cmt-highlight")).toBeNull();
  expect(p.textContent).toBe(original);
});

// ---- suggestion tint (proposal 65) -----------------------------------

test("wrapRangeInBlock — suggestion flag adds the green tint class", () => {
  const p = block("Hello brave world");
  wrapRangeInBlock(p, 6, 11, "t1", true);
  const span = p.querySelector<HTMLElement>(".cmt-highlight")!;
  expect(span.classList.contains("cmt-highlight--suggestion")).toBe(true);
});

test("wrapRangeInBlock — a plain thread gets no suggestion tint class", () => {
  const p = block("Hello brave world");
  wrapRangeInBlock(p, 6, 11, "t1");
  const span = p.querySelector<HTMLElement>(".cmt-highlight")!;
  expect(span.classList.contains("cmt-highlight--suggestion")).toBe(false);
});

// ---- findBlockFor ----------------------------------------------------

test("findBlockFor — climbs to the nearest [data-comment-block-id]", () => {
  const p = block("some <em>emphasized</em> text");
  p.dataset.commentBlockId = "article:__b-0";
  const em = p.querySelector("em")!;
  expect(findBlockFor(em.firstChild!)).toBe(p);
  expect(findBlockFor(document.body)).toBeNull();
});
