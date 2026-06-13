// "Copy as Markdown" split control: a small progressive-enhancement module
// (like byline.ts / headerLinks.ts) that lets a reader take the whole article
// as clean Markdown — for pasting into an LLM — in one click, with a dropdown
// for the secondary "view it in the browser" action.
//
// Shape (mirrors the convention docs sites like Bun's have converged on):
//   [ Copy as Markdown ▼ ]
// The primary button copies; the caret opens a small menu with:
//   • Copy as Markdown — copy this page as Markdown for LLMs
//   • View as Markdown — open /posts/<slug>.md in a new tab (plain text)
//
// The heavy lifting (Readability extraction + figure-collapse + Turndown
// serialization) happens at BUILD time: generate/markdown-export.ts emits
// `dist/posts/<slug>.md` next to each post, and both actions just point at that
// static file (copy fetch-and-clipboards it; view navigates to it). No
// Readability/Turndown in the client bundle, and the copied bytes are identical
// to the golden-tested build artifact. See methodology.md → "Copy as Markdown".
//
// The menu is a plain JS-toggled dropdown (outside-click + Escape dismiss, roving
// arrow-key focus) rather than the Popover API the comments column uses: this is
// a small action menu that doesn't need the top layer, and avoiding it keeps the
// dropdown free of the CSS-anchor-positioning cross-engine caveats.

import faMarkdown from "@fortawesome/fontawesome-free/svgs/brands/markdown.svg" with { type: "text" };
import faCheck from "@fortawesome/fontawesome-free/svgs/solid/check.svg" with { type: "text" };
import faCopy from "@fortawesome/fontawesome-free/svgs/solid/copy.svg" with { type: "text" };
import faFile from "@fortawesome/fontawesome-free/svgs/solid/file-lines.svg" with { type: "text" };
import faChevron from "@fortawesome/fontawesome-free/svgs/solid/chevron-down.svg" with { type: "text" };
import faExternal from "@fortawesome/fontawesome-free/svgs/solid/up-right-from-square.svg" with { type: "text" };

import { copyToClipboard } from "./clipboard.ts";

// How long the "Copied!" state (icon swap + label) stays after a successful copy.
const FEEDBACK_MS = 1600;

// Resolve the current post's Markdown twin. `location.pathname` is the clean
// post path (`/posts/foo`) in both dev and prod; normalize a trailing slash or
// an explicit `.html` so the `.md` sibling resolves either way.
function markdownUrlForCurrentPage(): string {
  const path = location.pathname.replace(/\/+$/, "").replace(/\.html$/, "");
  return `${path}.md`;
}

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

// One menu row: an icon, a title (+ optional trailing glyph), and a sub-line.
// `el` is a <button> for the copy action, an <a> for the navigating view action.
function buildMenuItem(
  el: HTMLButtonElement | HTMLAnchorElement,
  icon: string,
  title: string,
  desc: string,
  trailing?: string,
): HTMLElement {
  el.className = "copy-md-item";
  el.setAttribute("role", "menuitem");
  el.tabIndex = -1; // roving tabindex — only the active item is tabbable
  el.appendChild(iconSpan("copy-md-item-icon", icon));

  const text = document.createElement("span");
  text.className = "copy-md-item-text";
  const t = document.createElement("span");
  t.className = "copy-md-item-title";
  t.textContent = title;
  if (trailing) t.appendChild(iconSpan("copy-md-item-trailing", trailing));
  const d = document.createElement("span");
  d.className = "copy-md-item-desc";
  d.textContent = desc;
  text.appendChild(t);
  text.appendChild(d);
  el.appendChild(text);
  return el;
}

let feedbackTimer: number | null = null;

// Toggle the copied state. The label/icon cross-fade is purely CSS off the
// `.copy-md-copied` class (both states are always in the DOM), so this just
// flips the class and schedules the reset — no text mutation, no resize.
function flashCopied(primary: HTMLButtonElement): void {
  primary.classList.add("copy-md-copied");
  if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    primary.classList.remove("copy-md-copied");
    feedbackTimer = null;
  }, FEEDBACK_MS);
}

export function installCopyMarkdown(article: HTMLElement): void {
  // Idempotent — never render two controls.
  if (article.querySelector(".copy-md")) return;

  const mdUrl = markdownUrlForCurrentPage();

  const group = document.createElement("div");
  group.className = "copy-md";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Copy this article as Markdown");

  // --- Primary "Copy as Markdown" button -------------------------------------
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "copy-md-primary";
  primary.title = "Copy this article as Markdown (for pasting into an LLM)";
  // Visible label is short ("Copy") to keep the byline row compact; the
  // accessible name keeps the full meaning (Label-in-Name-compliant — it
  // contains the visible word).
  primary.setAttribute("aria-label", "Copy as Markdown");
  const pIcon = document.createElement("span");
  pIcon.className = "copy-md-glyphs";
  pIcon.setAttribute("aria-hidden", "true");
  pIcon.innerHTML =
    `<span class="copy-md-glyph copy-md-glyph-default">${faMarkdown}</span>` +
    `<span class="copy-md-glyph copy-md-glyph-copied">${faCheck}</span>`;
  for (const svg of pIcon.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
  // Two stacked labels: the default sits in normal flow and reserves the
  // button's width; "Copied!" is absolutely positioned over it (out of flow),
  // so flipping to the shorter text doesn't resize the button. The copied span
  // is aria-hidden so the button's accessible name stays "Copy as Markdown".
  const pLabel = document.createElement("span");
  pLabel.className = "copy-md-label";
  const pLabelDefault = document.createElement("span");
  pLabelDefault.className = "copy-md-label-default";
  pLabelDefault.textContent = "Copy";
  const pLabelCopied = document.createElement("span");
  pLabelCopied.className = "copy-md-label-copied";
  pLabelCopied.setAttribute("aria-hidden", "true");
  pLabelCopied.textContent = "Copied!";
  pLabel.appendChild(pLabelDefault);
  pLabel.appendChild(pLabelCopied);
  primary.appendChild(pIcon);
  primary.appendChild(pLabel);

  // --- Caret "more actions" trigger ------------------------------------------
  const more = document.createElement("button");
  more.type = "button";
  more.className = "copy-md-more";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", "More Markdown actions");
  more.appendChild(iconSpan("copy-md-caret", faChevron));

  // --- Menu ------------------------------------------------------------------
  const menu = document.createElement("div");
  menu.className = "copy-md-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const menuId = "copy-md-menu";
  menu.id = menuId;
  more.setAttribute("aria-controls", menuId);

  const copyItem = buildMenuItem(
    document.createElement("button"),
    faCopy,
    "Copy as Markdown",
    "Copy this page as Markdown for LLMs",
  ) as HTMLButtonElement;
  copyItem.setAttribute("type", "button");

  const viewItem = buildMenuItem(
    document.createElement("a"),
    faFile,
    "View as Markdown",
    "Open this page as plain text",
    faExternal,
  ) as HTMLAnchorElement;
  viewItem.href = mdUrl;
  viewItem.target = "_blank";
  viewItem.rel = "noopener";

  menu.appendChild(copyItem);
  menu.appendChild(viewItem);

  const items: HTMLElement[] = [copyItem, viewItem];

  // --- Menu open/close + focus -----------------------------------------------
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
    group.classList.add("copy-md-open");
    document.addEventListener("pointerdown", onOutside, true);
    if (focusFirst) setActive(0);
  }

  function closeMenu(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    group.classList.remove("copy-md-open");
    document.removeEventListener("pointerdown", onOutside, true);
    for (const el of items) el.tabIndex = -1;
    if (returnFocus) more.focus();
  }

  function onOutside(e: PointerEvent): void {
    if (!group.contains(e.target as Node)) closeMenu(false);
  }

  // --- Actions ---------------------------------------------------------------
  let busy = false;
  async function doCopy(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(mdUrl, { credentials: "omit" });
      if (!res.ok) {
        // No Markdown twin for this page — remove the affordance rather than
        // leave a control that errors on use.
        group.remove();
        return;
      }
      const md = await res.text();
      if (await copyToClipboard(md)) flashCopied(primary);
    } catch {
      group.remove();
    } finally {
      busy = false;
    }
  }

  primary.addEventListener("click", () => void doCopy());
  copyItem.addEventListener("click", () => {
    closeMenu(false);
    void doCopy();
  });
  // viewItem is a real <a target="_blank"> — let the navigation happen; just
  // dismiss the menu.
  viewItem.addEventListener("click", () => closeMenu(false));

  more.addEventListener("click", () => {
    if (open) closeMenu(true);
    else openMenu(true);
  });

  // Keyboard: roving focus inside the menu, Escape to close, Tab to leave.
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
  // Open the menu with ArrowDown from the caret (standard menu-button pattern).
  more.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(true);
    }
  });

  group.appendChild(primary);
  group.appendChild(more);
  group.appendChild(menu);

  // The build serves a min-height `.subctl-zone` flex container
  // (shared/articleChromeReserve.ts, applied by the bunHtmlHeadPlugin in both
  // dev and prod) so the control row doesn't drop the body when it appears;
  // mount into it. subscribe.ts then does `copyMd.after(row)`, landing its row in
  // the same zone — so it needs no change. The byline-slot fallback below (under
  // the lede if present, else the title, else prepended) covers any context with
  // no zone, so the control always has a home.
  const zone = article.querySelector(".subctl-zone");
  const lede = article.querySelector("#lede");
  const title = article.querySelector("#title");
  if (zone) zone.appendChild(group);
  else if (lede) lede.after(group);
  else if (title) title.after(group);
  else article.prepend(group);
}

function boot(): void {
  // Same article-root selector byline/headerLinks/comments use; present on
  // every post (kept even on narration opt-out posts).
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  installCopyMarkdown(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
