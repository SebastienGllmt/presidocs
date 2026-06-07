// The happy-dom import MUST come first — installCitationLink touches
// `document`/`window`, and the pure emitter uses the global `URL` (available in
// Bun without the DOM, but we share one harness with the install test).
import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import {
  buildCitationHref,
  buildTextFragmentDirective,
  encodeTextFragmentTerm,
  installCitationLink,
  normalizeText,
} from "./citationLink.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("normalizeText collapses whitespace and trims", () => {
  expect(normalizeText("  a   b\n\tc ")).toBe("a b c");
});

test("encodeTextFragmentTerm encodes structural chars incl. the hyphen", () => {
  // comma / ampersand come from encodeURIComponent; the hyphen is encoded by us
  // because `-` is the prefix/suffix delimiter in the directive grammar.
  expect(encodeTextFragmentTerm("a, b & c-d")).toBe("a%2C%20b%20%26%20c%2Dd");
  // A space stays %20 (not "+"), per encodeURIComponent.
  expect(encodeTextFragmentTerm("two words")).toBe("two%20words");
});

test("short, unique selection → a bare text= directive", () => {
  const d = buildTextFragmentDirective({
    quote: "shared liquidity",
    haystack: "intro shared liquidity outro",
  });
  expect(d).toBe("text=shared%20liquidity");
});

test("empty / whitespace-only selection → null (no directive)", () => {
  expect(buildTextFragmentDirective({ quote: "   \n  " })).toBeNull();
});

test("long selection → a start,end range to keep the URL compact", () => {
  // 12 words (> MAX_EXACT_WORDS) → first 4 + last 4 as a range, unique so no context.
  const quote = "one two three four five six seven eight nine ten eleven twelve";
  const d = buildTextFragmentDirective({ quote, haystack: `prefix ${quote} suffix` });
  expect(d).toBe("text=one%20two%20three%20four,nine%20ten%20eleven%20twelve");
});

test("repeated quote → nearest prefix/suffix word is added as context", () => {
  // "the offer" appears twice, so the bare quote is ambiguous; the emitter pins
  // it with the adjacent words: prefix word "sign" before, suffix word "now" after.
  const d = buildTextFragmentDirective({
    quote: "the offer",
    prefix: "you sign",
    suffix: "now please",
    haystack: "first the offer here and again the offer there",
  });
  expect(d).toBe("text=sign-,the%20offer,-now");
});

test("no context is added when the quote is unique even if prefix/suffix given", () => {
  const d = buildTextFragmentDirective({
    quote: "uniquely worded passage",
    prefix: "some preceding text",
    suffix: "some following text",
    haystack: "lead in uniquely worded passage trailing off",
  });
  expect(d).toBe("text=uniquely%20worded%20passage");
});

test("buildCitationHref drops query + existing fragment, keeps origin+path", () => {
  expect(
    buildCitationHref("https://blog.example.com/posts/offer-files?utm=x#some-heading", "text=foo"),
  ).toBe("https://blog.example.com/posts/offer-files#:~:text=foo");
});

test("installCitationLink mounts a hidden, keyboard-reachable button once", () => {
  document.body.innerHTML = `<article data-narration-src="/x"><p>body</p></article>`;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installCitationLink(article);
  installCitationLink(article); // idempotent — second call is a no-op

  const buttons = document.querySelectorAll<HTMLButtonElement>("button.citation-link-btn");
  expect(buttons.length).toBe(1);
  const btn = buttons[0]!;
  expect(btn.hidden).toBe(true);
  // A real <button> (not a div) so it's focusable + reachable by keyboard.
  expect(btn.tagName).toBe("BUTTON");
  expect(btn.getAttribute("aria-label")).toBe("Copy a link to the selected text");
  expect(article.dataset.citationLink).toBe("installed");
});
