// Tier 1.3 — happy-dom coverage of the subscribe split-controls
// (client/subscribe.ts). Boot itself (the manifest fetch + audio gate) isn't
// driven here — its behavior is "resolve an episode MP3 → mount with it, else
// mount article-only." The unit tests cover the pure config builder
// (buildConfigs), the canonical-origin reader, and the rendering/placement
// rules (buildControl + mountSubscribeControls). The real click/clipboard path
// is the same machinery the Copy-as-Markdown e2e already exercises.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import {
  buildConfigs,
  buildControl,
  canonicalOrigin,
  mountSubscribeControls,
} from "./subscribe.ts";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const ORIGIN = "https://blog.example.com";
const AUDIO = "https://blog.example.com/audio/hello/full.mp3";

// ---- buildConfigs (pure) ---------------------------------------------------

test("buildConfigs — audio post yields podcast + article controls", () => {
  const cfgs = buildConfigs(ORIGIN, AUDIO);
  expect(cfgs.map((c) => c.name)).toEqual(["podcast", "article feed"]);

  const podcast = cfgs[0]!;
  expect(podcast.copyText).toBe("https://blog.example.com/podcast.xml");
  const titles = podcast.items.map((i) => i.title);
  expect(titles).toEqual([
    "Open in podcast app",
    "Copy podcast feed",
    "Copy episode audio",
    "Learn more",
  ]);

  // The app handoff uses the podcast:// scheme with the bare host + path.
  const open = podcast.items[0]!;
  expect(open.kind).toBe("link");
  if (open.kind === "link") {
    expect(open.href).toBe("podcast://blog.example.com/podcast.xml");
    expect(open.newTab).toBe(false);
  }
  // The episode-audio item is the genuinely post-specific link.
  const ep = podcast.items[2]!;
  expect(ep.kind === "copy" && ep.text).toBe(AUDIO);
  // Learn more lands on the podcast-specific help anchor in a new tab.
  const learn = podcast.items[3]!;
  expect(learn.kind).toBe("link");
  if (learn.kind === "link") {
    expect(learn.href).toBe("https://blog.example.com/help#subscribe-podcast");
    expect(learn.newTab).toBe(true);
  }
});

test("buildConfigs — text-only post yields the article control alone", () => {
  const cfgs = buildConfigs(ORIGIN, null);
  expect(cfgs.map((c) => c.name)).toEqual(["article feed"]);

  const article = cfgs[0]!;
  expect(article.copyText).toBe("https://blog.example.com/feed.xml");
  expect(article.items.map((i) => i.title)).toEqual([
    "Open in feed reader",
    "Copy article feed",
    "Learn more",
  ]);
  const open = article.items[0]!;
  if (open.kind === "link") expect(open.href).toBe("feed://blog.example.com/feed.xml");
  const learn = article.items[2]!;
  if (learn.kind === "link") {
    expect(learn.href).toBe("https://blog.example.com/help#subscribe-articles");
  }
});

// ---- canonicalOrigin -------------------------------------------------------

test("canonicalOrigin — prefers <link rel=canonical>, falls back to location", () => {
  expect(canonicalOrigin()).toBe(location.origin); // no canonical link yet

  const link = document.createElement("link");
  link.rel = "canonical";
  link.setAttribute("href", "https://blog.sebastiengllmt.com/posts/hello");
  document.head.appendChild(link);
  expect(canonicalOrigin()).toBe("https://blog.sebastiengllmt.com");
});

// ---- buildControl (DOM) ----------------------------------------------------

test("buildControl — renders a primary copy button + a closed menu", () => {
  const cfg = buildConfigs(ORIGIN, AUDIO)[0]!;
  const group = buildControl(cfg);

  const primary = group.querySelector(".subctl-primary")!;
  expect(primary.textContent).toContain("Copy podcast feed");
  const more = group.querySelector(".subctl-more")!;
  expect(more.getAttribute("aria-expanded")).toBe("false");

  const menu = group.querySelector(".subctl-menu")!;
  expect((menu as HTMLElement).hidden).toBe(true);
  expect(menu.querySelectorAll(".subctl-item").length).toBe(4);

  // Copy items are <button>; link items are <a>.
  const items = Array.from(menu.querySelectorAll(".subctl-item"));
  expect(items[1]!.tagName).toBe("BUTTON"); // "Copy podcast feed"
  expect(items[0]!.tagName).toBe("A"); // "Open in podcast app"
  // The new-tab learn-more anchor carries target + a trailing external glyph.
  const learn = items[3]! as HTMLAnchorElement;
  expect(learn.getAttribute("target")).toBe("_blank");
  expect(learn.querySelector(".subctl-item-trailing")).toBeTruthy();
});

// ---- mountSubscribeControls (placement + gating) ---------------------------

function articleWithCopyMd(): HTMLElement {
  const article = document.createElement("article");
  article.setAttribute("data-narration-src", "/generated/hello/manifest.json");
  article.innerHTML = `<h1 id="title">Hello</h1><p id="lede">Lede</p><div class="copy-md"></div>`;
  document.body.appendChild(article);
  return article;
}

test("mountSubscribeControls — audio post mounts both controls after copy-md", () => {
  const article = articleWithCopyMd();
  mountSubscribeControls(article, ORIGIN, AUDIO);

  const row = article.querySelector(".subctl-row")!;
  expect(row).toBeTruthy();
  // Placed immediately after the copy-md control.
  expect(article.querySelector(".copy-md")!.nextElementSibling).toBe(row);
  // Podcast first, then article feed.
  const labels = Array.from(row.querySelectorAll(".subctl-primary")).map(
    (b) => b.textContent,
  );
  expect(labels[0]).toContain("Copy podcast feed");
  expect(labels[1]).toContain("Copy article feed");
});

test("mountSubscribeControls — text-only post mounts the article control only; idempotent", () => {
  const article = articleWithCopyMd();
  mountSubscribeControls(article, ORIGIN, null);
  mountSubscribeControls(article, ORIGIN, null); // second call is a no-op

  const rows = article.querySelectorAll(".subctl-row");
  expect(rows.length).toBe(1);
  const controls = rows[0]!.querySelectorAll(".subctl");
  expect(controls.length).toBe(1);
  expect(controls[0]!.querySelector(".subctl-primary")!.textContent).toContain(
    "Copy article feed",
  );
});
