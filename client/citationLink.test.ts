// The happy-dom import MUST come first — installCitationLink touches
// `document`/`window`, and the pure helpers use the global `URL` (available in
// Bun without the DOM, but we share one harness with the install test).
//
// Note on coverage split: the actual fragment *generation* (word-boundary
// expansion + uniqueness disambiguation) lives in `fragment-generation-utils`,
// which needs a real browser layout + `Intl.Segmenter` + live Selection to run.
// That correctness is covered in the real-browser tier (e2e/citationLink.e2e.ts);
// here we test only the DOM-free surface around it — directive encoding, URL
// composition, and the "degrade, never emit a broken link" decision.
import "../happydom.ts";

import { expect, test } from "bun:test";

import type { TextFragment } from "text-fragments-polyfill/dist/fragment-generation-utils.js";
import {
  buildCitationHref,
  chooseCitation,
  directiveFromFragment,
  encodeTextFragmentTerm,
  installCitationLink,
  PASSAGE_LABEL,
  SECTION_LABEL,
} from "./citationLink.ts";

test("encodeTextFragmentTerm encodes structural chars incl. the hyphen", () => {
  // comma / ampersand come from encodeURIComponent; the hyphen is encoded by us
  // because `-` is the prefix/suffix delimiter in the directive grammar.
  expect(encodeTextFragmentTerm("a, b & c-d")).toBe("a%2C%20b%20%26%20c%2Dd");
  // A space stays %20 (not "+"), per encodeURIComponent.
  expect(encodeTextFragmentTerm("two words")).toBe("two%20words");
});

test("directiveFromFragment: bare textStart", () => {
  expect(directiveFromFragment({ textStart: "shared liquidity" })).toBe(
    "text=shared%20liquidity",
  );
});

test("directiveFromFragment: textStart,textEnd range", () => {
  expect(
    directiveFromFragment({ textStart: "one two three four", textEnd: "nine ten eleven twelve" }),
  ).toBe("text=one%20two%20three%20four,nine%20ten%20eleven%20twelve");
});

test("directiveFromFragment: prefix + suffix context, in grammar order", () => {
  const f: TextFragment = { prefix: "sign", textStart: "the offer", suffix: "now" };
  expect(directiveFromFragment(f)).toBe("text=sign-,the%20offer,-now");
});

test("directiveFromFragment: prefix + range + suffix (all four terms)", () => {
  const f: TextFragment = {
    prefix: "So",
    textStart: "an offer",
    textEnd: "the file",
    suffix: "again",
  };
  expect(directiveFromFragment(f)).toBe("text=So-,an%20offer,the%20file,-again");
});

test("buildCitationHref drops query + existing fragment, keeps origin+path", () => {
  expect(
    buildCitationHref(
      "https://blog.example.com/posts/offer-files?utm=x#some-heading",
      ":~:text=foo",
    ),
  ).toBe("https://blog.example.com/posts/offer-files#:~:text=foo");
});

test("chooseCitation: a generated fragment → a precise passage link", () => {
  const choice = chooseCitation({
    fragment: { textStart: "the offer", suffix: "now" },
    baseHref: "https://blog.example.com/posts/x#stale",
    sectionId: "some-section",
  });
  expect(choice).toEqual({
    href: "https://blog.example.com/posts/x#:~:text=the%20offer,-now",
    label: PASSAGE_LABEL,
  });
});

test("chooseCitation: no fragment (ambiguous/failed) → degrade to the section link", () => {
  const choice = chooseCitation({
    fragment: null,
    baseHref: "https://blog.example.com/posts/x?q=1",
    sectionId: "the-problem",
  });
  expect(choice).toEqual({
    href: "https://blog.example.com/posts/x#the-problem",
    label: SECTION_LABEL,
  });
});

test("chooseCitation: no fragment and no section → null (button stays hidden)", () => {
  expect(
    chooseCitation({ fragment: null, baseHref: "https://blog.example.com/posts/x", sectionId: null }),
  ).toBeNull();
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
