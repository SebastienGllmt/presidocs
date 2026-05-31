// First happy-dom test in the engine — a proof-of-concept that the opt-in
// browser environment (see ../happydom.ts) actually wires up `document` and
// friends for client/* modules. headerLinks.ts is the smallest pure-DOM
// surface in the bundle (no Shikwasa, no audio, no CRDT), so it's a clean
// sanity check; once this passes, the same harness can take on narrator.ts
// and comments.ts.
//
// The happy-dom import MUST come before the module under test — it has to
// register `document` etc. globally before headerLinks.ts evaluates.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { installHeadingLinks, slugify } from "./headerLinks.ts";

beforeEach(() => {
  // Reset the document between tests so installations / ids / used-id sets
  // from one test don't bleed into the next.
  document.body.innerHTML = "";
});

test("slugify lowercases, hyphenates, and strips accents", () => {
  expect(slugify("Hello World")).toBe("hello-world");
  expect(slugify("  Trim & punctuate!  ")).toBe("trim-punctuate");
  expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
  // Leading/trailing hyphens that fall out of the punctuation collapse get
  // trimmed, so headings like "— A note —" don't produce "-a-note-".
  expect(slugify("— A note —")).toBe("a-note");
});

test("installHeadingLinks backfills slug ids and attaches the anchor", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h2>First Section</h2>
      <h3>A sub heading</h3>
      <h4>Deeper still</h4>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installHeadingLinks(article);

  const h2 = article.querySelector("h2")!;
  const h3 = article.querySelector("h3")!;
  const h4 = article.querySelector("h4")!;
  expect(h2.id).toBe("first-section");
  expect(h3.id).toBe("a-sub-heading");
  expect(h4.id).toBe("deeper-still");

  // Each heading should now own a `.heading-link` anchor pointing at its id.
  const a = h2.querySelector<HTMLAnchorElement>("a.heading-link")!;
  expect(a).not.toBeNull();
  expect(a.getAttribute("href")).toBe("#first-section");
  expect(a.getAttribute("aria-label")).toBe("Copy link to this section");
});

test("installHeadingLinks preserves an author-supplied id", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h2 id="author-chose-this">Some heading text</h2>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installHeadingLinks(article);

  const h2 = article.querySelector("h2")!;
  // The id stays exactly what the author wrote — not reslugged from the text.
  expect(h2.id).toBe("author-chose-this");
  expect(h2.querySelector("a.heading-link")?.getAttribute("href"))
    .toBe("#author-chose-this");
});

test("installHeadingLinks dedupes colliding slugs with -2/-3 suffixes", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h2>Background</h2>
      <h2>Background</h2>
      <h2>Background</h2>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installHeadingLinks(article);

  const ids = Array.from(article.querySelectorAll("h2")).map((h) => h.id);
  expect(ids).toEqual(["background", "background-2", "background-3"]);
});

test("installHeadingLinks is idempotent on a second run", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h2>Only one section</h2>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installHeadingLinks(article);
  installHeadingLinks(article);

  const h2 = article.querySelector("h2")!;
  // No duplicated anchor on the second pass — the data-heading-link guard
  // is doing its job.
  expect(h2.querySelectorAll("a.heading-link").length).toBe(1);
  expect(h2.dataset.headingLink).toBe("installed");
});
