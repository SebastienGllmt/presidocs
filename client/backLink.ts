// "Back to all posts" link: a small progressive-enhancement module (like
// byline.ts / copyMarkdown.ts) that renders a top-of-article link back to the
// blog index, so a reader who landed on a single post (from search, a shared
// link, a feed) has a one-click path to the rest of the blog.
//
// Shape — the dominant blog convention: a muted "← All posts" link sitting
// above the <h1>, as the article's first affordance:
//   ← All posts
//   <h1>Post title</h1>
//
// Points at "/", the blog index — the same target injectFooter's "Home" link
// uses (the root is the post listing; see personal-blog/index.html). Kept
// client-side rather than baked into the served HTML for the same reason every
// other in-article affordance here is: it then renders identically in dev
// (Bun's un-rewritable HTMLBundle) and prod. The footer's "Home" link is the
// build-time, bottom-of-page counterpart; this is the top-of-page one a reader
// actually reaches for, so the two are complementary, not redundant.

import faArrowLeft from "@fortawesome/fontawesome-free/svgs/solid/arrow-left.svg" with { type: "text" };

// The blog index. Matches injectFooter's "Home" href — the root path lists every
// post (personal-blog/index.html), so "all posts" and "home" are the same place.
const INDEX_HREF = "/";

export function buildBackLink(): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "back-link";
  a.href = INDEX_HREF;
  // Accessible name carries the full intent; the inline label echoes it for
  // sighted readers and the arrow is decoration.
  a.setAttribute("aria-label", "Back to all posts");

  const icon = document.createElement("span");
  icon.className = "back-link-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = faArrowLeft;
  const svg = icon.querySelector("svg");
  if (svg) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }

  const label = document.createElement("span");
  label.className = "back-link-label";
  label.textContent = "All posts";

  a.appendChild(icon);
  a.appendChild(label);
  return a;
}

// Mount the link as the article's first child, above the <h1#title>. Sits
// before the title (not after the lede like the byline/copy controls) so it
// reads as page navigation rather than article chrome.
export function installBackLink(article: HTMLElement): void {
  // Idempotent — never render two links.
  if (article.querySelector(".back-link")) return;
  // The build serves a fixed-height `.back-link-reserve` first child
  // (generate/articleChromeReserve.ts, applied by the bunHtmlHeadPlugin in both
  // dev and prod) so the link doesn't drop the title/body when it appears; swap
  // it in place. The prepend below is the fallback when no reserve is present.
  const reserve = article.querySelector(".back-link-reserve");
  if (reserve) reserve.replaceWith(buildBackLink());
  else article.prepend(buildBackLink());
}

function boot(): void {
  // Same article-root selector byline/copyMarkdown/comments use; present on
  // every post (kept even on narration opt-out posts).
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  installBackLink(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
