// "View on GitHub" control: a small progressive-enhancement module (like
// copyMarkdown.ts / subscribe.ts) that gives a reader a one-click link to the
// post's own source on the blog's public repo. A standalone affordance in the
// byline-slot `.subctl-zone`, a sibling of "Copy as Markdown" and the subscribe
// controls — not a dropdown item, because viewing the source is a distinct act
// from taking the article as Markdown or subscribing to a feed.
//
// The per-post URL is computed at BUILD time (shared/sourceRepo.ts) and injected
// as `<link rel="vcs-github" href="…">` by the head plugin (dev AND prod); this
// module just reads that href. So there's nothing to configure client-side, and
// the gating lives in one place: no link is injected when SOURCE_REPO_URL is
// unset or the blog is private (a public-source link must never appear on a
// capability-gated post — see shared/sourceRepo.ts), so this control simply
// doesn't render in those cases. See methodology.md → "View on GitHub".

import faGithub from "@fortawesome/fontawesome-free/svgs/brands/github.svg" with { type: "text" };
import faExternal from "@fortawesome/fontawesome-free/svgs/solid/up-right-from-square.svg" with { type: "text" };
import { iconSpan } from "./iconSpan.ts";

export function installViewSource(article: HTMLElement): void {
  if (article.querySelector(".view-src")) return; // idempotent
  // The build injects this only for a public, non-private blog; absent → no control.
  const href = document.querySelector<HTMLLinkElement>('link[rel="vcs-github"]')?.getAttribute("href");
  if (!href) return;

  const a = document.createElement("a");
  a.className = "view-src";
  // The injected link is the blob (read) URL — a stable, machine-discoverable
  // source pointer. The human "Edit" affordance wants GitHub's editor, which is
  // the same path with /blob/ → /edit/ (GitHub auto-forks for a reader without
  // write access — the "fix a typo / contribute" flow). A non-GitHub host with no
  // /blob/ segment falls through to the original URL unchanged.
  a.href = href.replace("/blob/", "/edit/");
  a.target = "_blank";
  a.rel = "noopener";
  // Short visible label ("Edit") to keep the byline row compact; the full
  // accessible name keeps it clear for AT and stays Label-in-Name-compliant
  // (the accessible name contains the visible word).
  a.title = "Edit this post on GitHub";
  a.setAttribute("aria-label", "Edit this post on GitHub");
  a.appendChild(iconSpan("view-src-icon", faGithub));
  const label = document.createElement("span");
  label.className = "view-src-label";
  label.textContent = "Edit";
  a.appendChild(label);
  // Trailing glyph signals the new tab (accessible name stays "View on GitHub").
  a.appendChild(iconSpan("view-src-trailing", faExternal));

  // Same mount family as copyMarkdown.ts: the build reserves a min-height
  // `.subctl-zone` flex row (shared/articleChromeReserve.ts) so the controls
  // don't reflow the body on mount; the byline-slot fallbacks cover any context
  // with no zone.
  const zone = article.querySelector(".subctl-zone");
  const lede = article.querySelector("#lede");
  const title = article.querySelector("#title");
  if (zone) zone.appendChild(a);
  else if (lede) lede.after(a);
  else if (title) title.after(a);
  else article.prepend(a);
}

function boot(): void {
  // Same article-root selector byline/copy-md/subscribe use; present on every post.
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  installViewSource(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
