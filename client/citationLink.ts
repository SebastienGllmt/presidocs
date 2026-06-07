// Citation deep-links: a small progressive-enhancement module (a sibling of
// headerLinks.ts) that turns a reader's text selection into a shareable
// `#:~:text=` URL — a W3C Text Fragment that scrolls the recipient straight to
// the exact passage and highlights it. The content is CC-BY, explicitly meant
// to be cited and reused, so "cite this sentence" deserves a first-class
// gesture, not "the section heading, then Ctrl-F".
//
// Two affordances already exist and this fills the gap between them:
//   - headerLinks.ts copies a `#id` link — granularity is the *section*.
//   - comments.ts captures an exact passage (quote + prefix/suffix) — but it
//     is login-gated and produces a private CRDT annotation, not a URL.
// This works for everyone (logged-out included — the common case), produces a
// plain URL, and ships nothing to the reader who *opens* the link: text-fragment
// rendering is Baseline across modern engines, and non-supporting browsers land
// at the page top (graceful degradation).
//
// Generation is HOME-GROWN (no dependency): for a citation feature the worst
// failure is a silently-broken link, and the only hard part is collision
// avoidance — when the selected text occurs more than once on the page a bare
// quote scrolls nowhere. We mitigate by adding the nearest prefix/suffix word
// as disambiguating context when (and only when) the quote isn't unique in the
// article. This is "almost as good" as GoogleChromeLabs'
// `fragment-generation-utils`, which implements the full block-boundary +
// range-extension algorithm; that library is the drop-in robustness upgrade at
// this one call site if QA ever shows real links silently failing. See
// methodology.md → "Citation deep-links".

import faQuote from "@fortawesome/fontawesome-free/svgs/solid/quote-left.svg" with { type: "text" };
import faCheck from "@fortawesome/fontawesome-free/svgs/solid/check.svg" with { type: "text" };
import { copyToClipboard } from "./clipboard.ts";

// How long the "Copied!" feedback stays before the button auto-hides.
const FEEDBACK_MS = 1200;
// ~chars of surrounding context captured for disambiguation, mirroring the
// comment selection capture (comments.ts).
const CTX = 32;
// Selections up to this many words go in verbatim as `text=<quote>`; longer
// ones become a `text=<start>,<end>` range so the URL stays compact (the
// browser highlights everything between start and end).
const MAX_EXACT_WORDS = 8;
// How many edge words to keep on each side when a long selection is ranged.
const RANGE_EDGE_WORDS = 4;

// ---- pure emitter (exported for tests) --------------------------------------

// Collapse runs of whitespace to single spaces and trim — text fragments are
// matched against the page's *rendered* text with whitespace normalized, so the
// emitted terms must be normalized the same way.
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function words(s: string): string[] {
  return normalizeText(s).split(" ").filter(Boolean);
}

function firstWords(s: string, n: number): string {
  return words(s).slice(0, n).join(" ");
}

function lastWords(s: string, n: number): string {
  const w = words(s);
  return w.slice(Math.max(0, w.length - n)).join(" ");
}

// Percent-encode one text-fragment term. encodeURIComponent already encodes the
// structural characters that matter (`,` and `&`), but it leaves `-` alone — and
// a literal hyphen inside a term would be misread as the `prefix-,`/`,-suffix`
// delimiter, so we encode it explicitly.
export function encodeTextFragmentTerm(s: string): string {
  return encodeURIComponent(s).replace(/-/g, "%2D");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    count += 1;
    i = idx + needle.length;
  }
  return count;
}

// Build the `text=…` directive (the part after `#:~:`) for a selection.
// Returns null for an empty/whitespace-only quote.
//
//   - short selection, unique → `text=<quote>`
//   - long selection,  unique → `text=<startWords>,<endWords>` (range, shorter)
//   - not unique in the article → the nearest prefix/suffix word is added as
//     context: `text=<prefix>-,<start>[,<end>],-<suffix>`
//
// `haystack` is the article's normalized text; when omitted, the quote is
// assumed unique (the disambiguation is best-effort, not a guarantee — see the
// module header).
export function buildTextFragmentDirective(opts: {
  quote: string;
  prefix?: string;
  suffix?: string;
  haystack?: string;
}): string | null {
  const quote = normalizeText(opts.quote);
  if (!quote) return null;
  const haystack = opts.haystack ? normalizeText(opts.haystack) : "";

  const useRange = words(quote).length > MAX_EXACT_WORDS;
  const start = useRange ? firstWords(quote, RANGE_EDGE_WORDS) : quote;
  const end = useRange ? lastWords(quote, RANGE_EDGE_WORDS) : "";

  const unique = haystack ? countOccurrences(haystack, quote) === 1 : true;
  const prefixWord = unique ? "" : lastWords(opts.prefix ?? "", 1);
  const suffixWord = unique ? "" : firstWords(opts.suffix ?? "", 1);

  const parts: string[] = [];
  if (prefixWord) parts.push(`${encodeTextFragmentTerm(prefixWord)}-`);
  parts.push(encodeTextFragmentTerm(start));
  if (end) parts.push(encodeTextFragmentTerm(end));
  if (suffixWord) parts.push(`-${encodeTextFragmentTerm(suffixWord)}`);

  return `text=${parts.join(",")}`;
}

// Compose the citation URL: the clean canonical page URL (origin + path, no
// query) with the text directive in the fragment. Any existing fragment is
// dropped — a passage citation is anchored by its text, not a stale heading id.
export function buildCitationHref(baseHref: string, directive: string): string {
  const url = new URL(baseHref);
  return `${url.origin}${url.pathname}#:~:${directive}`;
}

// ---- DOM wiring -------------------------------------------------------------

// Read the quote + surrounding context out of a live Range. The quote is the
// selection's own text; prefix/suffix are up to CTX chars from the start/end
// text nodes, used only to disambiguate a repeated quote.
function selectionContext(range: Range): { quote: string; prefix: string; suffix: string } {
  const startC = range.startContainer;
  const endC = range.endContainer;
  const prefix = startC.nodeType === Node.TEXT_NODE
    ? (startC.textContent ?? "").slice(Math.max(0, range.startOffset - CTX), range.startOffset)
    : "";
  const suffix = endC.nodeType === Node.TEXT_NODE
    ? (endC.textContent ?? "").slice(range.endOffset, range.endOffset + CTX)
    : "";
  return { quote: range.toString(), prefix, suffix };
}

// A node is citable if it sits inside the article body and NOT inside a figure
// or inline SVG — `:~:text=` can't reliably anchor into graphics, and the
// audio drawer lives outside the article element entirely (so `contains` already
// excludes it, as it does the comment column/cards mounted on <body>).
function isCitableProse(node: Node, article: HTMLElement): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el || !article.contains(el)) return false;
  if (el.closest("figure, svg, .citation-link-btn")) return false;
  return true;
}

let button: HTMLButtonElement | null = null;
let pendingHref: string | null = null;
let feedbackTimer: number | null = null;

function buildButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "citation-link-btn";
  b.hidden = true;
  b.setAttribute("aria-label", "Copy a link to the selected text");
  b.title = "Copy link to selection";
  b.innerHTML =
    `<span class="citation-link-icon citation-link-icon-default">${faQuote}</span>` +
    `<span class="citation-link-icon citation-link-icon-copied">${faCheck}</span>` +
    `<span class="citation-link-label">Copy link</span>`;
  for (const svg of b.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("citation-link-svg");
  }
  return b;
}

function setLabel(text: string): void {
  const label = button?.querySelector(".citation-link-label");
  if (label) label.textContent = text;
}

function hideButton(): void {
  if (button) {
    button.hidden = true;
    button.classList.remove("citation-link-copied");
    setLabel("Copy link");
  }
  pendingHref = null;
}

function flashCopied(): void {
  if (!button) return;
  button.classList.add("citation-link-copied");
  setLabel("Copied!");
  if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    hideButton();
    feedbackTimer = null;
  }, FEEDBACK_MS);
}

// Place the button just BELOW the selection. The comment action bar (when a
// logged-in reader is present) sits ABOVE the selection, so the two never
// overlap. Absolute coords (scrollX/scrollY) keep it anchored as the page
// scrolls without a scroll listener.
function positionButton(rect: DOMRect): void {
  if (!button) return;
  button.hidden = false;
  const w = button.offsetWidth || 96;
  const top = window.scrollY + rect.bottom + 8;
  let left = window.scrollX + rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - w - 8));
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
}

function onSelectionChange(article: HTMLElement): void {
  // Don't fight our own copy feedback: while the check is showing, leave it.
  if (button && button.classList.contains("citation-link-copied")) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideButton();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!isCitableProse(range.startContainer, article) || !isCitableProse(range.endContainer, article)) {
    hideButton();
    return;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideButton();
    return;
  }
  const { quote, prefix, suffix } = selectionContext(range);
  const directive = buildTextFragmentDirective({
    quote,
    prefix,
    suffix,
    haystack: article.textContent ?? "",
  });
  if (!directive) {
    hideButton();
    return;
  }
  pendingHref = buildCitationHref(location.href, directive);
  positionButton(rect);
}

export function installCitationLink(article: HTMLElement): void {
  if (article.dataset.citationLink === "installed") return;
  article.dataset.citationLink = "installed";

  button = buildButton();
  // mousedown (not click) + preventDefault: reaching for the button must not
  // collapse the selection before we read it — same trick the comment bar uses.
  button.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    if (!pendingHref) return;
    const ok = await copyToClipboard(pendingHref);
    if (ok) flashCopied();
    else hideButton();
  });
  document.body.appendChild(button);

  document.addEventListener("selectionchange", () => onSelectionChange(article));
}

function boot(): void {
  // Same article-root selector the byline/headerLinks/comments layers use.
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  installCitationLink(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
