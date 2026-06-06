// happy-dom coverage of the copy-markdown mount placement — the build-reserve
// zone path and the no-zone fallback. (The clipboard/menu behavior is exercised in
// the e2e copyMarkdown tier; here we only pin where the control lands, since
// that's what the CLS reserve depends on.)

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { installCopyMarkdown } from "./copyMarkdown.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("installCopyMarkdown: appends into the .subctl-zone when present (prod path)", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">T</h1>
      <p id="lede">l</p>
      <div class="subctl-zone"></div>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installCopyMarkdown(article);

  const zone = article.querySelector(".subctl-zone")!;
  // The control lives inside the reserved zone (so subscribe's copyMd.after(row)
  // lands there too), not as a loose sibling of the lede.
  expect(zone.querySelector(".copy-md")).not.toBeNull();
  expect(article.querySelectorAll(".copy-md").length).toBe(1);
});

test("installCopyMarkdown: falls back to the lede slot when no zone is present", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">T</h1>
      <p id="lede">l</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installCopyMarkdown(article);

  const lede = article.querySelector("#lede")!;
  expect((lede.nextElementSibling as HTMLElement).classList.contains("copy-md")).toBe(true);
});

test("installCopyMarkdown: idempotent — never renders two controls", () => {
  document.body.innerHTML = `<article data-narration-src="/x"><div class="subctl-zone"></div></article>`;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  installCopyMarkdown(article);
  installCopyMarkdown(article);
  expect(article.querySelectorAll(".copy-md").length).toBe(1);
});
