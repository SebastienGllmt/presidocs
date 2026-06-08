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
// Generation uses GoogleChromeLabs' `fragment-generation-utils` (Apache-2.0,
// zero-dep, generator-only), NOT a home-grown emitter. A naive emitter silently
// breaks in exactly the two ways that matter most for a *citation* feature, and
// both are fundamentally the consumer's (the browser's) matching rules, which
// only the spec algorithm models correctly:
//   1. Word boundaries — the spec only matches a fragment that begins AND ends
//      on a Unicode (UAX #29) word boundary, so a selection that starts or ends
//      mid-word produces a link that scrolls nowhere. The library expands the
//      range to word boundaries; a string emitter can't without reimplementing
//      segmentation.
//   2. Uniqueness — a `#:~:text=` directive carries NO metadata slot (no content
//      hash, no block id, and the element-id part does not scope the search), so
//      the ONLY way to disambiguate a repeated phrase is to iteratively extend
//      prefix/suffix/range until the match is provably unique. The library does
//      that and reports AMBIGUOUS when it can't; a one-shot one-word emitter
//      cannot. (This is why the comment layer's content-hash anchoring does not
//      port here — that hash is resolved by our own JS; the browser ignores it.)
// The generator is lazy-imported behind the copy gesture (its own chunk via Bun
// `splitting: true`), so it costs zero at first paint. When it can't produce a
// unique passage link we degrade to the nearest section's `#id` link rather than
// emit a silently-broken one. See methodology.md → "Citation deep-links" and the
// mirrored spec ./specs/ScrollToTextFragment-spec.html.

import faQuote from "@fortawesome/fontawesome-free/svgs/solid/quote-left.svg" with { type: "text" };
import faCheck from "@fortawesome/fontawesome-free/svgs/solid/check.svg" with { type: "text" };
import type { TextFragment } from "text-fragments-polyfill/dist/fragment-generation-utils.js";
import { copyToClipboard } from "./clipboard.ts";

// How long the "Copied!" feedback stays before the button auto-hides.
const FEEDBACK_MS = 1200;
// A selection fires `selectionchange` continuously while the pointer drags;
// wait this long for it to settle before running (the non-trivial) generation,
// so we generate once per settled selection, not once per mouse-move.
const GEN_DEBOUNCE_MS = 120;

// Button labels — exported so the test can assert which path produced the link.
export const PASSAGE_LABEL = "Copy link";
export const SECTION_LABEL = "Copy section link";

// ---- pure emitter (exported for tests) --------------------------------------

// Percent-encode one text-fragment term. encodeURIComponent already encodes the
// structural characters that matter (`,` and `&`), but it leaves `-` alone — and
// a literal hyphen inside a term would be misread as the `prefix-,`/`,-suffix`
// delimiter, so we encode it explicitly.
export function encodeTextFragmentTerm(s: string): string {
  return encodeURIComponent(s).replace(/-/g, "%2D");
}

// Assemble the `text=…` directive (the part after `#:~:`) from a generated
// TextFragment. The library returns RAW terms; we percent-encode each and join
// in grammar order: `[prefix-,]textStart[,textEnd][,-suffix]`.
export function directiveFromFragment(f: TextFragment): string {
  const parts: string[] = [];
  if (f.prefix) parts.push(`${encodeTextFragmentTerm(f.prefix)}-`);
  parts.push(encodeTextFragmentTerm(f.textStart));
  if (f.textEnd) parts.push(encodeTextFragmentTerm(f.textEnd));
  if (f.suffix) parts.push(`-${encodeTextFragmentTerm(f.suffix)}`);
  return `text=${parts.join(",")}`;
}

// Compose a citation URL: the clean canonical page URL (origin + path, no query)
// with the given fragment. Any existing fragment is dropped — a passage citation
// is anchored by its text, not a stale heading id. `fragment` is the full hash
// body, e.g. `:~:text=foo` (passage) or `intro-heading` (section fallback).
export function buildCitationHref(baseHref: string, fragment: string): string {
  const url = new URL(baseHref);
  return `${url.origin}${url.pathname}#${fragment}`;
}

// Decide what the button should copy, given the generation outcome. Pure +
// DOM-free so it's unit-testable: a successful fragment becomes a precise
// passage link; otherwise we fall back to the section link if one exists; if
// neither, there's nothing worth copying (caller hides the button). This is the
// "degrade, never emit a silently-broken link" rule.
export function chooseCitation(opts: {
  fragment: TextFragment | null;
  baseHref: string;
  sectionId: string | null;
}): { href: string; label: string } | null {
  if (opts.fragment) {
    return {
      href: buildCitationHref(opts.baseHref, `:~:${directiveFromFragment(opts.fragment)}`),
      label: PASSAGE_LABEL,
    };
  }
  if (opts.sectionId) {
    return { href: buildCitationHref(opts.baseHref, opts.sectionId), label: SECTION_LABEL };
  }
  return null;
}

// ---- DOM wiring -------------------------------------------------------------

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

// The id of the nearest section heading at or before the selection start, for
// the fallback link when a unique passage fragment can't be generated. Headings
// are backfilled with ids by headerLinks.ts; we read whatever ids exist now and
// pick the last <h2>/<h3>/<h4> that precedes the selection in document order.
function nearestSectionId(range: Range, article: HTMLElement): string | null {
  const start = range.startContainer;
  let best: string | null = null;
  for (const h of article.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id], h4[id]")) {
    const pos = start.compareDocumentPosition(h);
    // Stop once the heading follows the selection start — the rest are later.
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) break;
    best = h.id;
  }
  return best;
}

let button: HTMLButtonElement | null = null;
let pendingHref: string | null = null;
let feedbackTimer: number | null = null;
let debounceTimer: number | null = null;
// Monotonic token: each new selection bumps it so a slow async generation that
// resolves after the selection moved on can detect it's stale and bail.
let genSeq = 0;
// When the comments layer shows its own action bar (logged-in desktop, on a
// commentable selection) it hosts the "Copy link" action inside that bar — see
// setCommentBarActive — so the standalone button stays out of the way and we
// skip generation here entirely (comments calls citationForRange itself).
let commentBarActive = false;

// Cache the dynamic import so the generator chunk is fetched at most once.
type GeneratorModule = typeof import("text-fragments-polyfill/dist/fragment-generation-utils.js");
let generatorPromise: Promise<GeneratorModule> | null = null;
function loadGenerator(): Promise<GeneratorModule> {
  generatorPromise ??= import("text-fragments-polyfill/dist/fragment-generation-utils.js");
  return generatorPromise;
}

// Generate the best citation for a Range: a precise passage link when the
// generator finds a unique, word-bounded fragment, else the nearest-section
// fallback, else null. Shared by the standalone button (below) and the comments
// action bar's own "Copy link" button, so both paths emit identical links.
// Async — the generator chunk is lazy-imported on first use.
export async function citationForRange(
  range: Range,
  article: HTMLElement,
): Promise<{ href: string; label: string } | null> {
  let mod: GeneratorModule;
  try {
    mod = await loadGenerator();
  } catch {
    return null; // generator chunk failed to load
  }
  let fragment: TextFragment | null = null;
  try {
    const result = mod.generateFragmentFromRange(range);
    if (result.status === mod.GenerateFragmentStatus.SUCCESS && result.fragment) {
      fragment = result.fragment;
    }
  } catch {
    // AMBIGUOUS/TIMEOUT arrive as a status; a thrown error is treated the same
    // way — fall through to the section fallback.
  }
  return chooseCitation({
    fragment,
    baseHref: location.href,
    sectionId: nearestSectionId(range, article),
  });
}

// Called by the comments layer when its action bar appears/disappears. While
// active, the standalone button hides and we skip generation — the comments bar
// owns the "Copy link" action (one bar, not two competing dark pills).
export function setCommentBarActive(active: boolean): void {
  commentBarActive = active;
  if (active) hideButton();
}

// Start fetching the generator chunk so a later citationForRange() resolves
// without a network/parse wait. The comments bar calls this when it appears
// (it generates on click), keeping the on-click copy instant. Idempotent — the
// import promise is cached.
export function prewarmCitationGenerator(): void {
  void loadGenerator();
}

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
    `<span class="citation-link-label">${PASSAGE_LABEL}</span>`;
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
    setLabel(PASSAGE_LABEL);
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

// A non-collapsed, fully-in-prose selection with a real rect; null otherwise.
function citableSelection(article: HTMLElement): { sel: Selection; range: Range } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!isCitableProse(range.startContainer, article) || !isCitableProse(range.endContainer, article)) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { sel, range };
}

// Run generation for one settled selection. Async because the generator is
// lazy-imported; the seq guard discards the result if the selection changed
// while we were waiting. We only ever SHOW the button once a ready href exists,
// so a visible button always copies a valid link (no click-time race).
async function runGeneration(seq: number, article: HTMLElement): Promise<void> {
  if (commentBarActive) return; // comments' bar hosts the action; nothing to do
  const live = citableSelection(article);
  if (!live) return;
  // Clone now: the live range can mutate while the generator chunk loads.
  const range = live.range.cloneRange();

  const choice = await citationForRange(range, article);
  // Bail if the selection moved on or the comment bar took over while we waited.
  if (seq !== genSeq || commentBarActive) return;
  if (!choice) {
    hideButton();
    return;
  }
  pendingHref = choice.href;
  setLabel(choice.label);
  positionButton(range.getBoundingClientRect());
}

function onSelectionChange(article: HTMLElement): void {
  // Don't fight our own copy feedback: while the check is showing, leave it.
  if (button?.classList.contains("citation-link-copied")) return;

  // Comments' action bar is up for this selection — it owns the copy-link
  // action there, so stay hidden and don't generate.
  if (commentBarActive) {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    hideButton();
    return;
  }

  if (!citableSelection(article)) {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    hideButton();
    return;
  }
  // A new/adjusted selection: the previous link is stale. Hide it and schedule
  // a fresh generation; the button re-appears (debounced) only once ready.
  hideButton();
  const seq = ++genSeq;
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void runGeneration(seq, article);
  }, GEN_DEBOUNCE_MS);
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
