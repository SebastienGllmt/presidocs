// happy-dom coverage of the back-link mount — the build-reserve swap path and
// the no-reserve fallback (prepend).

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { buildBackLink, installBackLink } from "./backLink.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("buildBackLink: muted '← All posts' anchor to the index with an accessible name", () => {
  const a = buildBackLink();
  expect(a.classList.contains("back-link")).toBe(true);
  expect(a.getAttribute("href")).toBe("/");
  expect(a.getAttribute("aria-label")).toBe("Back to all posts");
  expect(a.querySelector(".back-link-label")?.textContent).toBe("All posts");
  // The arrow is decorative.
  expect(a.querySelector(".back-link-icon")?.getAttribute("aria-hidden")).toBe("true");
});

test("installBackLink: prepends above the title when there is no reserve (fallback)", () => {
  document.body.innerHTML = `<article data-narration-src="/x"><h1 id="title">T</h1></article>`;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installBackLink(article);
  expect((article.firstElementChild as HTMLElement).classList.contains("back-link")).toBe(true);
});

test("installBackLink: replaces the .back-link-reserve placeholder in place (prod path)", () => {
  // Prod emits a fixed-height reserve as the article's first child; the client
  // swaps it for the real link so the title/body never drop.
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <div class="back-link-reserve" aria-hidden="true"></div>
      <h1 id="title">T</h1>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installBackLink(article);
  expect(article.querySelector(".back-link-reserve")).toBeNull();
  expect((article.firstElementChild as HTMLElement).classList.contains("back-link")).toBe(true);
  // Exactly one link (the swap, not an extra prepend).
  expect(article.querySelectorAll(".back-link").length).toBe(1);
});

test("installBackLink: idempotent — never renders two links", () => {
  document.body.innerHTML = `<article data-narration-src="/x"><h1 id="title">T</h1></article>`;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installBackLink(article);
  installBackLink(article);
  expect(article.querySelectorAll(".back-link").length).toBe(1);
});
