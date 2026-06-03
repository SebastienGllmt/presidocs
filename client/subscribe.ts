// Subscribe split-controls: two small byline-slot affordances that sit next to
// "Copy as Markdown" (client/copyMarkdown.ts) and share its split-button shape
// — a primary button that copies a feed URL plus a caret that opens a small
// menu of related actions.
//
//   • Podcast feed — rendered ONLY on posts that have narration audio. Primary
//     copies the channel feed (`/podcast.xml`); the menu adds "Open in podcast
//     app" (the `podcast://` handoff), "Copy podcast feed", "Copy episode audio"
//     (the per-episode MP3 — the one genuinely post-specific podcast artifact),
//     and "Learn more" (→ /help#subscribe-podcast).
//   • Article feed — rendered on EVERY post. Primary copies the Atom feed
//     (`/feed.xml`); the menu adds "Open in feed reader" (the `feed://` handoff),
//     "Copy article feed", and "Learn more" (→ /help#subscribe-articles).
//
// Why two separate controls rather than one combined "Subscribe": a podcast
// subscription and an article subscription are different acts with different
// destinations (a podcast app vs a feed reader), so each gets its own labelled
// affordance instead of one menu that mixes them.
//
// A podcast subscription is whole-SHOW by design — RSS has no "subscribe to one
// episode" URL — so the feed link is the same on every post; the only per-post
// podcast artifact is the episode's own audio file, which we read from the
// narration manifest the player already fetches (so it's cache-shared, and its
// presence is also our "this post has audio" gate). All copied links are built
// from the page's `<link rel="canonical">` origin, falling back to the current
// origin in dev, so what a reader copies is the canonical blog URL even when the
// page is viewed from a preview host. See methodology.md → "Subscribe controls".

import faPodcast from "@fortawesome/fontawesome-free/svgs/solid/podcast.svg" with { type: "text" };
import faRss from "@fortawesome/fontawesome-free/svgs/solid/rss.svg" with { type: "text" };
import faHeadphones from "@fortawesome/fontawesome-free/svgs/solid/headphones.svg" with { type: "text" };
import faPlay from "@fortawesome/fontawesome-free/svgs/solid/play.svg" with { type: "text" };
import faLink from "@fortawesome/fontawesome-free/svgs/solid/link.svg" with { type: "text" };
import faCheck from "@fortawesome/fontawesome-free/svgs/solid/check.svg" with { type: "text" };
import faInfo from "@fortawesome/fontawesome-free/svgs/solid/circle-info.svg" with { type: "text" };
import faComments from "@fortawesome/fontawesome-free/svgs/solid/comments.svg" with { type: "text" };
import faChevron from "@fortawesome/fontawesome-free/svgs/solid/chevron-down.svg" with { type: "text" };
import faExternal from "@fortawesome/fontawesome-free/svgs/solid/up-right-from-square.svg" with { type: "text" };

import { copyToClipboard } from "./clipboard.ts";

// How long the "Copied!" state stays after a successful copy (matches copy-md).
const FEEDBACK_MS = 1600;

// A menu row is either a copy action (writes text to the clipboard) or a link
// (navigates — used both for the `podcast://`/`feed://` app handoffs and the
// "Learn more" help anchor).
type MenuItem =
  | { kind: "copy"; icon: string; title: string; desc: string; text: string }
  | {
      kind: "link";
      icon: string;
      title: string;
      desc: string;
      href: string;
      newTab: boolean;
    };

export type ControlConfig = {
  /** aria-label for the whole group and the basis of the caret's label. */
  name: string;
  /** Primary-button icon + label; the primary copies `copyText`. */
  primaryIcon: string;
  primaryLabel: string;
  copyText: string;
  items: MenuItem[];
};

// ---- URL derivation ---------------------------------------------------------

// Canonical origin for the copied links: the post's `<link rel="canonical">`
// (emitted by the structured-data inject) when present, else the current
// origin. Keeps copied links on the canonical host even from a preview domain.
export function canonicalOrigin(doc: Document = document): string {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const href = link?.getAttribute("href");
  if (href) {
    try {
      return new URL(href, doc.location?.href ?? undefined).origin;
    } catch {
      // fall through to the live origin
    }
  }
  return location.origin;
}

// `podcast://`/`feed://` schemes carry the bare host + path (no scheme prefix),
// the convention podcast apps and feed readers register for one-tap subscribe.
function schemeUrl(scheme: string, origin: string, path: string): string {
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    host = origin.replace(/^https?:\/\//, "");
  }
  return `${scheme}://${host}${path}`;
}

// Build the two control configs for a page. `audioUrl` is the resolved episode
// MP3 (absolute) when the post has narration audio, else null → no podcast
// control. Pure (no DOM/fetch) so it's unit-testable.
export function buildConfigs(
  origin: string,
  audioUrl: string | null,
): ControlConfig[] {
  const podcastFeed = `${origin}/podcast.xml`;
  const articleFeed = `${origin}/feed.xml`;
  const configs: ControlConfig[] = [];

  if (audioUrl) {
    configs.push({
      name: "podcast",
      primaryIcon: faPodcast,
      primaryLabel: "Copy podcast feed",
      copyText: podcastFeed,
      items: [
        {
          kind: "link",
          icon: faPlay,
          title: "Open in podcast app",
          desc: "Hand the feed to your podcast app",
          href: schemeUrl("podcast", origin, "/podcast.xml"),
          newTab: false,
        },
        {
          kind: "copy",
          icon: faLink,
          title: "Copy podcast feed",
          desc: "The whole-show RSS feed URL",
          text: podcastFeed,
        },
        {
          kind: "copy",
          icon: faHeadphones,
          title: "Copy episode audio",
          desc: "Direct link to this episode's audio",
          text: audioUrl,
        },
        {
          kind: "link",
          icon: faInfo,
          title: "Learn more",
          desc: "How to subscribe in any podcast app",
          href: `${origin}/help#subscribe-podcast`,
          newTab: true,
        },
      ],
    });
  }

  configs.push({
    name: "article feed",
    primaryIcon: faRss,
    primaryLabel: "Copy article feed",
    copyText: articleFeed,
    items: [
      {
        kind: "link",
        icon: faPlay,
        title: "Open in feed reader",
        desc: "Hand the feed to your reader",
        href: schemeUrl("feed", origin, "/feed.xml"),
        newTab: false,
      },
      {
        kind: "copy",
        icon: faLink,
        title: "Copy article feed",
        desc: "The Atom feed URL (RSS-compatible)",
        text: articleFeed,
      },
      {
        kind: "link",
        icon: faComments,
        title: "Use in Slack or Discord",
        desc: "Pipe the feed into your own chat channel",
        href: `${origin}/help#subscribe-chat`,
        newTab: true,
      },
      {
        kind: "link",
        icon: faInfo,
        title: "Learn more",
        desc: "How to follow new posts in a reader",
        href: `${origin}/help#subscribe-articles`,
        newTab: true,
      },
    ],
  });

  return configs;
}

// ---- DOM building -----------------------------------------------------------

function iconSpan(cls: string, svg: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = svg;
  const el = s.querySelector("svg");
  if (el) {
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("focusable", "false");
  }
  return s;
}

// One menu row. A copy item is a <button>; a link item is an <a> (with a
// trailing external glyph + target when it opens a new tab).
function buildMenuItem(item: MenuItem, onCopy: () => void, onClose: () => void): HTMLElement {
  const el =
    item.kind === "copy"
      ? document.createElement("button")
      : document.createElement("a");
  el.className = "subctl-item";
  el.setAttribute("role", "menuitem");
  el.tabIndex = -1; // roving tabindex — only the active item is tabbable
  el.appendChild(iconSpan("subctl-item-icon", item.icon));

  const text = document.createElement("span");
  text.className = "subctl-item-text";
  const t = document.createElement("span");
  t.className = "subctl-item-title";
  t.textContent = item.title;
  const d = document.createElement("span");
  d.className = "subctl-item-desc";
  d.textContent = item.desc;
  text.appendChild(t);

  if (item.kind === "copy") {
    (el as HTMLButtonElement).type = "button";
    el.addEventListener("click", () => {
      onClose();
      onCopy();
    });
  } else {
    const a = el as HTMLAnchorElement;
    a.href = item.href;
    if (item.newTab) {
      a.target = "_blank";
      a.rel = "noopener";
      t.appendChild(iconSpan("subctl-item-trailing", faExternal));
    }
    // The app-handoff schemes (podcast://, feed://) navigate via the OS handler;
    // the help link navigates normally. Either way, just dismiss the menu.
    a.addEventListener("click", () => onClose());
  }

  text.appendChild(d);
  el.appendChild(text);
  return el;
}

export function buildControl(cfg: ControlConfig): HTMLElement {
  const group = document.createElement("div");
  group.className = "subctl";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `Subscribe — ${cfg.name}`);

  // --- Primary copy button ---------------------------------------------------
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "subctl-primary";
  primary.title = `${cfg.primaryLabel} (${cfg.copyText})`;
  const pIcon = document.createElement("span");
  pIcon.className = "subctl-glyphs";
  pIcon.setAttribute("aria-hidden", "true");
  pIcon.innerHTML =
    `<span class="subctl-glyph subctl-glyph-default">${cfg.primaryIcon}</span>` +
    `<span class="subctl-glyph subctl-glyph-copied">${faCheck}</span>`;
  for (const svg of pIcon.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  // Two stacked labels (default in flow reserves width; "Copied!" overlaid),
  // so the swap never resizes the button. Copied span is aria-hidden so the
  // accessible name stays the primary label.
  const pLabel = document.createElement("span");
  pLabel.className = "subctl-label";
  const pLabelDefault = document.createElement("span");
  pLabelDefault.className = "subctl-label-default";
  pLabelDefault.textContent = cfg.primaryLabel;
  const pLabelCopied = document.createElement("span");
  pLabelCopied.className = "subctl-label-copied";
  pLabelCopied.setAttribute("aria-hidden", "true");
  pLabelCopied.textContent = "Copied!";
  pLabel.appendChild(pLabelDefault);
  pLabel.appendChild(pLabelCopied);
  primary.appendChild(pIcon);
  primary.appendChild(pLabel);

  // --- Caret trigger ---------------------------------------------------------
  const more = document.createElement("button");
  more.type = "button";
  more.className = "subctl-more";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", `More ${cfg.name} actions`);
  more.appendChild(iconSpan("subctl-caret", faChevron));

  // --- Menu ------------------------------------------------------------------
  const menu = document.createElement("div");
  menu.className = "subctl-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  // ids must be unique across the two controls on a page.
  const menuId = `subctl-menu-${cfg.name.replace(/\s+/g, "-")}`;
  menu.id = menuId;
  more.setAttribute("aria-controls", menuId);

  let feedbackTimer: number | null = null;
  function flashCopied(): void {
    primary.classList.add("subctl-copied");
    if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      primary.classList.remove("subctl-copied");
      feedbackTimer = null;
    }, FEEDBACK_MS);
  }

  let busy = false;
  async function doCopy(text: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (await copyToClipboard(text)) flashCopied();
    } finally {
      busy = false;
    }
  }

  const items: HTMLElement[] = cfg.items.map((item) =>
    buildMenuItem(
      item,
      () => {
        if (item.kind === "copy") void doCopy(item.text);
      },
      () => closeMenu(false),
    ),
  );
  for (const el of items) menu.appendChild(el);

  // --- Open/close + focus ----------------------------------------------------
  let open = false;

  function setActive(idx: number): void {
    const i = (idx + items.length) % items.length;
    for (const el of items) el.tabIndex = -1;
    items[i]!.tabIndex = 0;
    items[i]!.focus();
  }

  function openMenu(focusFirst: boolean): void {
    if (open) return;
    open = true;
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    group.classList.add("subctl-open");
    document.addEventListener("pointerdown", onOutside, true);
    if (focusFirst) setActive(0);
  }

  function closeMenu(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    group.classList.remove("subctl-open");
    document.removeEventListener("pointerdown", onOutside, true);
    for (const el of items) el.tabIndex = -1;
    if (returnFocus) more.focus();
  }

  function onOutside(e: PointerEvent): void {
    if (!group.contains(e.target as Node)) closeMenu(false);
  }

  primary.addEventListener("click", () => void doCopy(cfg.copyText));
  more.addEventListener("click", () => {
    if (open) closeMenu(true);
    else openMenu(true);
  });

  menu.addEventListener("keydown", (e: KeyboardEvent) => {
    const idx = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive(idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(idx - 1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(items.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        break;
      case "Tab":
        closeMenu(false);
        break;
    }
  });
  more.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(true);
    }
  });

  group.appendChild(primary);
  group.appendChild(more);
  group.appendChild(menu);
  return group;
}

// Mount the controls into the byline slot. Placed in a row right after the
// "Copy as Markdown" control when present (else under the lede/title, the same
// slot family the byline uses), so the article's top affordances line up.
export function mountSubscribeControls(
  article: HTMLElement,
  origin: string,
  audioUrl: string | null,
): void {
  if (article.querySelector(".subctl-row")) return; // idempotent

  const row = document.createElement("div");
  row.className = "subctl-row";
  for (const cfg of buildConfigs(origin, audioUrl)) row.appendChild(buildControl(cfg));

  const copyMd = article.querySelector(".copy-md");
  const lede = article.querySelector("#lede");
  const title = article.querySelector("#title");
  if (copyMd) copyMd.after(row);
  else if (lede) lede.after(row);
  else if (title) title.after(row);
  else article.prepend(row);
}

// Resolve the episode MP3 from the narration manifest the player points at.
// `null` when there's no manifest, the fetch fails, or it carries no audio —
// i.e. the post has no podcast episode, so the podcast control is suppressed.
async function resolveAudioUrl(article: HTMLElement, origin: string): Promise<string | null> {
  const src = article.getAttribute("data-narration-src");
  if (!src) return null;
  try {
    const res = await fetch(src, { credentials: "omit" });
    if (!res.ok) return null;
    const m = (await res.json()) as { audio?: unknown };
    if (typeof m.audio !== "string" || !m.audio) return null;
    return new URL(m.audio, origin).href;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  // Same article root the byline/copy-md controls use (present on every post,
  // including narration opt-out posts — whose manifest fetch simply fails, so
  // they get the article control only).
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  const origin = canonicalOrigin();
  const audioUrl = await resolveAudioUrl(article, origin);
  mountSubscribeControls(article, origin, audioUrl);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
