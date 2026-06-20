// Heading deep-links: a small progressive-enhancement module (like narrator.ts
// / comments.ts / byline.ts) that makes every <h2>/<h3>/<h4> in the article
// individually addressable and copyable.
//
// Two surfaces:
//   1. The heading itself becomes a stable URL target — already addressable
//      via `#id` for headings the author wrote ids on; we backfill the rest
//      with slug-of-text ids so every heading is linkable, not just the ones
//      a `<mark>` happens to reference.
//   2. A small link icon appears on hover (or keyboard focus) to the right of
//      the heading. Clicking it copies the absolute `https://…#id` URL to the
//      clipboard, briefly flips the icon to a checkmark as feedback, and lets
//      the native anchor behavior update the URL + smooth-scroll to the
//      heading. Right-click → "Copy link address" continues to work because
//      it's a real <a href="#id">, not a button.
//
// Idempotent: re-running boot() is a no-op (we mark each heading with
// `data-heading-link="installed"`). Author-supplied ids are preserved
// untouched — the slug-fallback only fires when no id is present, so existing
// `<mark name>` ↔ heading id wiring (and any narration/comments anchoring) is
// never disturbed.

import faLink from "@fortawesome/fontawesome-free/svgs/solid/link.svg" with { type: "text" };
import faCheck from "@fortawesome/fontawesome-free/svgs/solid/check.svg" with { type: "text" };
import { copyToClipboard } from "./clipboard.ts";

// We deep-link <h2>/<h3>/<h4>. <h1> is the post title — the page URL itself
// already points at it, so a self-link there is noise. <h5>/<h6> are rare
// enough in long-form prose that we skip them until a real need shows up.
const HEADING_TAGS = ["h2", "h3", "h4"] as const;

// How long the "Copied!" feedback (icon swap + label) stays visible after a
// successful copy.
const FEEDBACK_MS = 1200;

// Turn a heading's text into a URL-safe slug. Lowercased ASCII, hyphen-
// separated, with leading/trailing punctuation trimmed. Matches the GitHub /
// Docusaurus convention authors already expect when they hand-write ids.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // Strip accents (NFKD then drop combining marks) so "café" → "cafe".
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Collapse anything non-alphanumeric into a single hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Dedupe a slug against already-used ids in the document. Mirrors the
// `-2`, `-3` suffix pattern markdown renderers use.
function uniqueSlug(base: string, used: Set<string>): string {
  if (base && !used.has(base)) return base;
  const prefix = base || "section";
  let n = 2;
  let candidate = `${prefix}-${n}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${prefix}-${n}`;
  }
  return candidate;
}

// Build the hover-link anchor. It's a real <a href="#id"> so:
//   - Right-click → "Copy link address" works (no JS needed).
//   - Cmd/Ctrl+click → opens the post-with-hash in a new tab.
//   - Plain click → browser updates location + smooth-scrolls (via the
//     `scroll-behavior: smooth` rule in base.css); our click handler runs
//     alongside to copy the absolute URL and show feedback.
function buildHeadingLink(id: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "heading-link";
  a.href = `#${id}`;
  a.setAttribute("aria-label", "Copy link to this section");
  a.title = "Copy link to this section";

  const iconWrap = document.createElement("span");
  iconWrap.className = "heading-link-icon-wrap";
  iconWrap.setAttribute("aria-hidden", "true");
  // Render both icons up front and toggle visibility via a class on the
  // anchor — no innerHTML thrash on click, no layout shift between states.
  iconWrap.innerHTML =
    `<span class="heading-link-icon heading-link-icon-default">${faLink}</span>` +
    `<span class="heading-link-icon heading-link-icon-copied">${faCheck}</span>`;
  for (const svg of iconWrap.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("heading-link-svg");
  }
  a.appendChild(iconWrap);
  return a;
}

let activeFeedbackTimer: number | null = null;

function flashCopiedFeedback(anchor: HTMLAnchorElement): void {
  anchor.classList.add("heading-link-copied");
  if (activeFeedbackTimer !== null) {
    window.clearTimeout(activeFeedbackTimer);
  }
  activeFeedbackTimer = window.setTimeout(() => {
    anchor.classList.remove("heading-link-copied");
    activeFeedbackTimer = null;
  }, FEEDBACK_MS);
}

// Walk the article, give every <h2>/<h3>/<h4> an id (preserving authored ones),
// and attach the hover-link anchor to each.
export function installHeadingLinks(article: HTMLElement): void {
  // Seed used-id set with every existing id in the document so our slugs
  // never collide with author-written ids on neighboring elements
  // (e.g. a `<p id="problem-body">` next to an `<h2 id="problem-heading">`).
  const used = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>("[id]")) {
    if (el.id) used.add(el.id);
  }

  const headings = article.querySelectorAll<HTMLHeadingElement>(
    HEADING_TAGS.join(","),
  );
  for (const heading of headings) {
    if (heading.dataset.headingLink === "installed") continue;
    if (!heading.id) {
      // textContent strips child element markup (e.g. <code> inside the
      // heading) cleanly — exactly what we want for slugging.
      const slug = uniqueSlug(slugify(heading.textContent ?? ""), used);
      if (slug) {
        heading.id = slug;
        used.add(slug);
      }
    }
    if (!heading.id) continue;

    const anchor = buildHeadingLink(heading.id);
    anchor.addEventListener("click", async (e) => {
      // Non-primary click, modifier-keys, etc. → let the browser handle it
      // natively (new tab, "open in window", system handler).
      if (
        e.button !== 0
        || e.metaKey
        || e.ctrlKey
        || e.shiftKey
        || e.altKey
      ) return;
      // Plain click is "copy this section's URL", NOT "navigate to it".
      // The user is already looking at the heading — scrolling it to the
      // top of the viewport is jarring. Suppress the native hash-scroll,
      // but still reflect the section in the URL (so a copy from the
      // address bar also works) via replaceState — replace rather than
      // push so repeated clicks don't pile up history entries.
      e.preventDefault();
      const target = e.currentTarget as HTMLAnchorElement;
      // Resolve the anchor's href against the current page to get an
      // absolute URL (e.g. `https://blog/posts/foo#bar`). `new URL(href)`
      // works because the anchor's `.href` getter already returns absolute.
      const url = new URL(target.href).toString();
      history.replaceState(null, "", `#${heading.id}`);
      const ok = await copyToClipboard(url);
      if (ok) flashCopiedFeedback(target);
    });

    heading.appendChild(anchor);
    heading.dataset.headingLink = "installed";
  }
}

// If the page loaded with `#id` in the URL and that id only exists *after*
// we backfilled it (or after byline.ts shifted layout above), the browser's
// initial scroll landed at the wrong place. Re-anchor to the targeted
// heading once the DOM has settled. Guarded so we never fight the user's
// own scrolling.
function reanchorToHashIfNeeded(): void {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const target = document.getElementById(hash);
  if (!target) return;
  // `auto` here so we don't fight the browser if it already scrolled close
  // enough; the corrective jump should feel instant, not animated.
  target.scrollIntoView({ block: "start", behavior: "auto" });
}

function boot(): void {
  // Same article-root selector the byline/comments layers use; present on
  // every post (kept even on narration opt-out posts).
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  installHeadingLinks(article);
  reanchorToHashIfNeeded();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
