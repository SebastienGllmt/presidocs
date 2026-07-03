// Emphasis serialization for in-place suggestion mode (proposal 65, increment 2).
// The editor is WYSIWYG (real <b>/<i>/<strong>/<em>/inline styles); commit
// normalizes all of it to <em>/<strong> text and maps offsets back to plain.

import "../../happydom.ts";
import { beforeEach, expect, test } from "bun:test";
import {
  parseEmphasis,
  plainOffset,
  serializeEmphasis,
  snapWindowToEmphasisTags,
  stripEmphasisTags,
} from "./emphasis.ts";
import { diffWindow } from "./blockEdit.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

function block(html: string): HTMLElement {
  const p = document.createElement("p");
  p.innerHTML = html;
  document.body.appendChild(p);
  return p;
}

test("plain text serializes unchanged", () => {
  expect(serializeEmphasis(block("the quick fox"))).toBe("the quick fox");
});

test("em / i / italic-style all become <em>", () => {
  expect(serializeEmphasis(block("a <em>b</em> c"))).toBe("a <em>b</em> c");
  expect(serializeEmphasis(block("a <i>b</i> c"))).toBe("a <em>b</em> c");
  expect(serializeEmphasis(block('a <span style="font-style: italic">b</span> c'))).toBe("a <em>b</em> c");
});

test("strong / b / bold-weight all become <strong>", () => {
  expect(serializeEmphasis(block("a <strong>b</strong> c"))).toBe("a <strong>b</strong> c");
  expect(serializeEmphasis(block("a <b>b</b> c"))).toBe("a <strong>b</strong> c");
  expect(serializeEmphasis(block('a <span style="font-weight: 700">b</span> c'))).toBe("a <strong>b</strong> c");
});

test("nested bold+italic nests both tags", () => {
  expect(serializeEmphasis(block("<strong><em>x</em></strong>"))).toBe("<strong><em>x</em></strong>");
  // a single element carrying both styles
  expect(serializeEmphasis(block('<span style="font-weight:bold;font-style:italic">x</span>'))).toBe("<strong><em>x</em></strong>");
});

test("other wrappers (links, code, comment highlights) collapse to inner content", () => {
  expect(serializeEmphasis(block('go <a href="/x">here</a> now'))).toBe("go here now");
  expect(serializeEmphasis(block('use <code>foo</code>'))).toBe("use foo");
  expect(serializeEmphasis(block('a <span class="cmt-highlight">b <em>c</em></span> d'))).toBe("a b <em>c</em> d");
});

test("stripEmphasisTags recovers the plain text (matches textContent basis)", () => {
  const rich = serializeEmphasis(block("the <em>quick</em> <strong>brown</strong> fox"));
  expect(stripEmphasisTags(rich)).toBe("the quick brown fox");
});

test("parseEmphasis is the inverse of serializeEmphasis for em/strong", () => {
  const host = document.createElement("div");
  host.append(...parseEmphasis("the <em>quick</em> <strong>brown</strong> fox"));
  expect(serializeEmphasis(host)).toBe("the <em>quick</em> <strong>brown</strong> fox");
  // nested
  const h2 = document.createElement("div");
  h2.append(...parseEmphasis("<strong><em>x</em></strong>"));
  expect(serializeEmphasis(h2)).toBe("<strong><em>x</em></strong>");
});

test("parseEmphasis treats any other markup as literal text (no innerHTML injection)", () => {
  const nodes = parseEmphasis('a <img src=x onerror=alert(1)> <em>b</em>');
  const host = document.createElement("div");
  host.append(...nodes);
  // the <img> is a text node, not an element — nothing was parsed as HTML
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelectorAll("em").length).toBe(1);
  expect(host.textContent).toBe("a <img src=x onerror=alert(1)> b");
});

test("snapWindowToEmphasisTags repairs a diff window that cut mid-tag", () => {
  // em→strong at the same position: the char trim shares "<" and ">" across
  // different tags, leaving unbalanced garbage without the snap.
  const o = "before <em>a</em> after";
  const e = "before <strong>a</strong> after";
  const win = snapWindowToEmphasisTags(o, e, diffWindow(o, e)!);
  expect(o.slice(win.start, win.end)).toBe("<em>a</em>");
  expect(win.replacement).toBe("<strong>a</strong>");
});

test("snapWindowToEmphasisTags leaves clean-boundary windows untouched", () => {
  const o = "plain word here";
  const e = "plain <em>word</em> here";
  const win = diffWindow(o, e)!;
  expect(snapWindowToEmphasisTags(o, e, win)).toEqual(win);
});

test("plainOffset maps a serialized offset to its plain-text position", () => {
  const rich = "the <em>quick</em> fox";
  //            plain: "the quick fox"
  // offset just before "quick" in `rich` is after "the <em>" = index 8
  expect(plainOffset(rich, 8)).toBe(4); // "the " → 4 plain chars
  // offset at end of the string → full plain length
  expect(plainOffset(rich, rich.length)).toBe("the quick fox".length);
  // a cut landing mid-tag drops the partial tag rather than counting "<e"
  expect(plainOffset("the <em>q", 6)).toBe(4); // "the <e" → "the " → 4
});
