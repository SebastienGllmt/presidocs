// Pure-DOM coverage for the figure-id copy affordance. We exercise
// installFigureIdCopies directly (not boot()), the same way headerLinks.test.ts
// drives installHeadingLinks — the localhost + isAuthor gate that boot() applies
// is the narrator's well-tested path, and a fetch isn't worth standing up here.
//
// The happy-dom import MUST come before the module under test so `document` is
// registered globally before figureCopyId.ts evaluates.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { installFigureIdCopies, installParagraphIdCopies } from "./figureCopyId.ts";

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
    // The label reads "#id" (anchor-style cue, Ctrl+F-findable as "#id"), split
    // into a non-selectable "#" and the id value — the value is the bare id, so
    // both a drag-select and the click handler copy `id` without the "#".
    expect(label.textContent).toBe(`#${id}`);
    expect(label.querySelector(".id-copy-hash")!.textContent).toBe("#");
    expect(label.querySelector(".id-copy-value")!.textContent).toBe(id);
    // The accessible name and tooltip stay clean (no "#").
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

test("installParagraphIdCopies attaches a label to every p[id]", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <p id="lede">Lede text.</p>
      <p id="problem-body">Body text.</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installParagraphIdCopies(article);

  for (const id of ["lede", "problem-body"]) {
    const p = article.querySelector<HTMLElement>(`p#${id}`)!;
    expect(p.classList.contains("has-paragraph-id-copy")).toBe(true);
    const label = p.querySelector<HTMLButtonElement>("button.paragraph-id-copy")!;
    expect(label).not.toBeNull();
    // The id rides on data-pid (rendered via CSS), copies that exact string,
    // and is announced for assistive tech.
    expect(label.dataset.pid).toBe(id);
    expect(label.getAttribute("aria-label")).toBe(`Copy paragraph id ${id}`);
    expect(label.title).toBe(`Copy paragraph id (${id})`);
  }
});

test("installParagraphIdCopies keeps the id out of the paragraph's text", () => {
  // The whole reason the paragraph label uses data-pid + CSS instead of a text
  // node: comments.ts hashes block.textContent to anchor threads, so the label
  // must contribute nothing to it. Lock that in.
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <p id="lede">Lede text.</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installParagraphIdCopies(article);

  const p = article.querySelector<HTMLElement>("p#lede")!;
  expect(p.textContent).toBe("Lede text.");
  expect(p.querySelector<HTMLElement>(".paragraph-id-copy")!.textContent).toBe("");
});

test("installParagraphIdCopies skips paragraphs without an id", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <p>No id here.</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installParagraphIdCopies(article);

  const p = article.querySelector<HTMLElement>("p")!;
  expect(p.querySelector(".paragraph-id-copy")).toBeNull();
  expect(p.classList.contains("has-paragraph-id-copy")).toBe(false);
});

test("installParagraphIdCopies is idempotent on a second run", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <p id="only">One.</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;

  installParagraphIdCopies(article);
  installParagraphIdCopies(article);

  const p = article.querySelector<HTMLElement>("p")!;
  expect(p.querySelectorAll(".paragraph-id-copy").length).toBe(1);
  expect(p.dataset.paragraphIdCopy).toBe("installed");
});
