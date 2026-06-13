// happy-dom coverage of the "View on GitHub" control (client/viewSource.ts).
// The per-post URL is injected as <link rel="vcs-github"> at build time; this
// exercises the render/placement/gating off that link.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";
import { installViewSource } from "./viewSource.ts";

function article(headLink: string | null): HTMLElement {
  document.head.innerHTML = headLink ?? "";
  document.body.innerHTML = `<article data-narration-src="/generated/x/manifest.json">
    <h1 id="title">T</h1>
    <div class="subctl-zone"></div>
  </article>`;
  return document.querySelector("article")!;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

test("renders an 'Edit' anchor into .subctl-zone, linking the GitHub edit URL (blob → edit)", () => {
  const blob = "https://github.com/you/blog/blob/main/posts/offer-files.html";
  const art = article(`<link rel="vcs-github" href="${blob}">`);
  installViewSource(art);

  const a = art.querySelector<HTMLAnchorElement>(".subctl-zone a.view-src");
  expect(a).not.toBeNull();
  // The visible link points at GitHub's editor; the rel-vcs link stays the blob.
  expect(a!.getAttribute("href")).toBe("https://github.com/you/blog/edit/main/posts/offer-files.html");
  expect(a!.target).toBe("_blank");
  expect(a!.rel).toContain("noopener");
  expect(a!.textContent).toContain("Edit");
  // Short visible label, full accessible name (Label-in-Name-compliant).
  expect(a!.getAttribute("aria-label")).toBe("Edit this post on GitHub");
});

test("no vcs-github link (unset repo / private blog) → no control", () => {
  const art = article(null);
  installViewSource(art);
  expect(art.querySelector(".view-src")).toBeNull();
});

test("idempotent — a second install adds no second control", () => {
  const art = article(`<link rel="vcs-github" href="https://github.com/you/blog/blob/main/posts/p.html">`);
  installViewSource(art);
  installViewSource(art);
  expect(art.querySelectorAll(".view-src").length).toBe(1);
});
