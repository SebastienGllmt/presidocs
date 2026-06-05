// Pure-DOM coverage for the figure-id copy affordance. We exercise
// installFigureIdCopies directly (not boot()), the same way headerLinks.test.ts
// drives installHeadingLinks — the localhost + isAuthor gate that boot() applies
// is the narrator's well-tested path, and a fetch isn't worth standing up here.
//
// The happy-dom import MUST come before the module under test so `document` is
// registered globally before figureCopyId.ts evaluates.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { installFigureIdCopies } from "./figureCopyId.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

test("installFigureIdCopies attaches a monospace id label to every figure[id]", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <figure id="intent-figure"><svg></svg></figure>
      <figure id="merge-figure"><svg></svg></figure>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installFigureIdCopies(article);

  for (const id of ["intent-figure", "merge-figure"]) {
    const figure = article.querySelector<HTMLElement>(`figure#${id}`)!;
    // Figure becomes the positioning context for the absolutely-placed label.
    expect(figure.classList.contains("has-figure-id-copy")).toBe(true);
    const label = figure.querySelector<HTMLButtonElement>("button.figure-id-copy")!;
    expect(label).not.toBeNull();
    // The label shows the bare id and copies that exact string (title hint).
    expect(label.textContent).toBe(id);
    expect(label.getAttribute("aria-label")).toBe(`Copy figure id ${id}`);
    expect(label.title).toBe(`Copy figure id (${id})`);
  }
});

test("installFigureIdCopies skips figures without an id", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <figure><svg></svg></figure>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installFigureIdCopies(article);

  const figure = article.querySelector<HTMLElement>("figure")!;
  expect(figure.querySelector(".figure-id-copy")).toBeNull();
  expect(figure.classList.contains("has-figure-id-copy")).toBe(false);
});

test("installFigureIdCopies is idempotent on a second run", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <figure id="only-figure"><svg></svg></figure>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installFigureIdCopies(article);
  installFigureIdCopies(article);

  const figure = article.querySelector<HTMLElement>("figure")!;
  // No duplicate label on the second pass — the data-figure-id-copy guard holds.
  expect(figure.querySelectorAll(".figure-id-copy").length).toBe(1);
  expect(figure.dataset.figureIdCopy).toBe("installed");
});
