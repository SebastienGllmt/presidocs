// Tier 1.3 — happy-dom coverage of the byline / post-meta / follow-CTA /
// engine attribution pipeline.
//
// Boot itself (the fetch round-trip + post-path matching) isn't tested
// directly — its behavior is "if the JSON arrives → call mountBylineInto;
// otherwise no-op." The unit tests cover both halves: the placement /
// rendering rules via mountBylineInto + buildByline + buildPostMeta, and
// the pure helpers (formatLastUpdated, normalizePath) on their own.

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import {
  buildByline,
  buildEngineAttribution,
  buildFollowCta,
  buildPostMeta,
  formatLastUpdated,
  mountBylineInto,
  normalizePath,
} from "./byline.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

const sampleProfile = (overrides: Partial<{
  name: string;
  avatar: string | null;
  links: Record<string, string>;
}> = {}) => ({
  name: "Alice Example",
  avatar: "/assets/authors/alice.png",
  links: { x: "https://x.com/alice", github: "https://github.com/alice" },
  ...overrides,
});

// ---- normalizePath (path-key matcher) --------------------------------

test("normalizePath strips a single trailing slash from non-root paths", () => {
  expect(normalizePath("/posts/foo/")).toBe("/posts/foo");
  expect(normalizePath("/posts/foo")).toBe("/posts/foo");
});

test("normalizePath leaves the root '/' alone", () => {
  // The root is keyed as `/` in the authors map (the landing page); we
  // must NOT strip it down to "".
  expect(normalizePath("/")).toBe("/");
});

test("normalizePath leaves nested empty intermediate segments alone (only trailing slash matters)", () => {
  expect(normalizePath("/a//b")).toBe("/a//b");
});

// ---- formatLastUpdated (human + machine-readable date) --------------

test("formatLastUpdated produces a long-form English-style date for a valid ISO", () => {
  const out = formatLastUpdated("2026-05-31T12:00:00Z");
  // Locale-dependent rendering, but the date components must appear.
  // Don't pin the exact format (en-US would say "May 31, 2026", others
  // differ) — just verify it contains the year and isn't the raw ISO.
  expect(out).toContain("2026");
  expect(out).not.toBe("2026-05-31T12:00:00Z");
});

test("formatLastUpdated falls back to the raw ISO for unparseable input", () => {
  // The fallback is "better an awkward date than no date" — methodology
  // calls out the postmeta strip as "Last updated <date>", and an empty
  // string would render as just "Last updated".
  expect(formatLastUpdated("not-a-date")).toBe("not-a-date");
});

// ---- buildByline (privacy + rendering) -------------------------------

test("buildByline emits avatar + name + link anchors", () => {
  const wrap = buildByline(sampleProfile());
  expect(wrap.classList.contains("byline")).toBe(true);
  expect(wrap.querySelector(".byline-name")?.textContent).toBe("Alice Example");
  const img = wrap.querySelector<HTMLImageElement>(".byline-avatar")!;
  expect(img).not.toBeNull();
  expect(img.src).toContain("/assets/authors/alice.png");
  const links = wrap.querySelectorAll<HTMLAnchorElement>(".byline-link");
  expect(links.length).toBe(2);
});

test("buildByline avatar uses author NAME as alt text (not email)", () => {
  // The privacy property methodology calls out — the email must not
  // leak through the served byline. The alt is on the avatar that
  // *would* otherwise carry an identifying string, so it's the obvious
  // place an accident would land.
  const wrap = buildByline(sampleProfile());
  const img = wrap.querySelector<HTMLImageElement>(".byline-avatar")!;
  expect(img.alt).toBe("Alice Example");
  expect(img.alt).not.toMatch(/@/);
});

test("buildByline avatar URL never carries the author email", () => {
  // Load-bearing privacy property — the avatar path embeds the public
  // handle (e.g. `/assets/authors/alice.png`), not `<email>.png`. Any
  // future regression that started encoding the email into the path
  // would break this and surface as a test failure rather than as a
  // privacy leak.
  const wrap = buildByline(sampleProfile());
  const img = wrap.querySelector<HTMLImageElement>(".byline-avatar")!;
  expect(img.src).not.toMatch(/@/);
});

test("buildByline renders no avatar element when the profile has none", () => {
  const wrap = buildByline(sampleProfile({ avatar: null }));
  expect(wrap.querySelector(".byline-avatar")).toBeNull();
  // Name still renders — the byline degrades gracefully.
  expect(wrap.querySelector(".byline-name")?.textContent).toBe("Alice Example");
});

test("buildByline renders no link block when the profile has no links", () => {
  const wrap = buildByline(sampleProfile({ links: {} }));
  expect(wrap.querySelector(".byline-links")).toBeNull();
});

test("buildByline known link keys render with their preset label + icon", () => {
  const wrap = buildByline(sampleProfile({ links: { x: "https://x.com/a" } }));
  const a = wrap.querySelector<HTMLAnchorElement>(".byline-link")!;
  expect(a.getAttribute("aria-label")).toBe("X");
  expect(a.title).toBe("X");
  // Inline SVG (FontAwesome) replaces the textContent.
  expect(a.querySelector("svg")).not.toBeNull();
});

test("buildByline unknown link keys fall back to plain-text labels", () => {
  // Methodology calls this out as the extension point — a new brand
  // doesn't break the byline; it just renders as text instead of an
  // icon. The accessible name still works.
  const wrap = buildByline(
    sampleProfile({ links: { customblog: "https://example.com" } }),
  );
  const a = wrap.querySelector<HTMLAnchorElement>(".byline-link")!;
  expect(a.textContent).toBe("customblog");
  expect(a.querySelector("svg")).toBeNull();
});

test("buildByline anchors carry rel='author me noopener'", () => {
  // `author`/`me` identify this as the author's own link; `noopener`
  // hardens the new-tab open against tabnabbing.
  const wrap = buildByline(sampleProfile());
  const a = wrap.querySelector<HTMLAnchorElement>(".byline-link")!;
  expect(a.rel).toContain("author");
  expect(a.rel).toContain("me");
  expect(a.rel).toContain("noopener");
});

// ---- buildPostMeta (date strip) --------------------------------------

test("buildPostMeta renders the human date and a machine-readable <time>", () => {
  const el = buildPostMeta({ lastUpdated: "2026-05-31T12:00:00Z" });
  expect(el).not.toBeNull();
  expect(el!.classList.contains("post-meta")).toBe(true);
  const time = el!.querySelector<HTMLTimeElement>("time")!;
  // dateTime carries the raw ISO so crawlers reading the strip get the
  // unambiguous timestamp, not a locale-rendered string.
  expect(time.dateTime).toBe("2026-05-31T12:00:00Z");
});

test("buildPostMeta returns null on null / missing lastUpdated (never 'Last updated undefined')", () => {
  expect(buildPostMeta(null)).toBeNull();
  expect(buildPostMeta({ lastUpdated: "" })).toBeNull();
});

// ---- buildFollowCta (follow-CTA card) ------------------------------

test("buildFollowCta renders headline + author name + every social link", () => {
  const el = buildFollowCta(sampleProfile())!;
  expect(el).not.toBeNull();
  expect(el.querySelector(".author-cta-headline")?.textContent).toBe(
    "Enjoyed this post?",
  );
  expect(el.querySelector(".author-cta-name")?.textContent).toBe(
    "Alice Example",
  );
  expect(el.querySelectorAll(".author-cta-link").length).toBe(2);
});

test("buildFollowCta returns null when the profile has no links", () => {
  // Methodology rule: "no point inviting a reader to follow when
  // there's nowhere to go."
  expect(buildFollowCta(sampleProfile({ links: {} }))).toBeNull();
});

// ---- buildEngineAttribution (always rendered) ----------------------

test("buildEngineAttribution always renders the 'Built with presidocs' line", () => {
  const el = buildEngineAttribution();
  expect(el.classList.contains("engine-attribution")).toBe(true);
  const a = el.querySelector<HTMLAnchorElement>(".engine-attribution-link")!;
  // The URL is intentionally hardcoded — a downstream blog overrides
  // via CSS `display: none` to hide the attribution, NOT via config.
  expect(a.href).toContain("presidocs");
  expect(a.rel).toContain("noopener");
});

// ---- mountBylineInto (placement rules) -----------------------------

test("mountBylineInto: byline goes under #lede when present", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">Title</h1>
      <p id="lede">lede</p>
      <p>body</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile(), null);

  const lede = article.querySelector("#lede")!;
  // immediate next sibling of the lede must be the byline
  expect((lede.nextElementSibling as HTMLElement).classList.contains("byline"))
    .toBe(true);
});

test("mountBylineInto: byline goes under #title when no lede is present", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">Title</h1>
      <p>body</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile(), null);

  const title = article.querySelector("#title")!;
  // With no lede AND no version, the byline is the immediate next
  // sibling. (With a version, post-meta wedges between.)
  expect((title.nextElementSibling as HTMLElement).classList.contains("byline"))
    .toBe(true);
});

test("mountBylineInto: byline prepends when neither lede nor title exist", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <p>body</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile(), null);

  // First child of the article must be the byline.
  expect((article.firstElementChild as HTMLElement).classList.contains("byline"))
    .toBe(true);
});

test("mountBylineInto: post-meta lands directly after #title when version is provided", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">Title</h1>
      <p>body</p>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile(), { lastUpdated: "2026-05-31" });

  const title = article.querySelector("#title")!;
  // title → post-meta → byline (each .after() inserts as the title's
  // *immediate* next sibling, pushing the prior insertion down — the
  // ordering rule methodology calls out).
  const next = title.nextElementSibling as HTMLElement;
  const nextNext = next.nextElementSibling as HTMLElement;
  expect(next.classList.contains("post-meta")).toBe(true);
  expect(nextNext.classList.contains("byline")).toBe(true);
});

test("mountBylineInto: engine attribution always appended (even when CTA is suppressed)", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">Title</h1>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile({ links: {} }), null);

  expect(article.querySelector(".engine-attribution")).not.toBeNull();
  // CTA is null when there are no links (verified above); attribution
  // still renders.
  expect(article.querySelector(".author-cta")).toBeNull();
});

test("mountBylineInto: CTA AND attribution both append when links are present", () => {
  document.body.innerHTML = `
    <article data-narration-src="/x">
      <h1 id="title">Title</h1>
    </article>
  `;
  const article = document.querySelector<HTMLElement>("[data-narration-src]")!;
  mountBylineInto(article, sampleProfile(), null);

  const cta = article.querySelector(".author-cta");
  const attr = article.querySelector(".engine-attribution");
  expect(cta).not.toBeNull();
  expect(attr).not.toBeNull();
  // Attribution appended after the CTA, so attribution is the last
  // child of the article.
  expect(article.lastElementChild).toBe(attr);
});
