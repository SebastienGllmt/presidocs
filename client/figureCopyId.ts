// Figure-id copy affordance — an author/dev-only debugging aid that mirrors the
// narration drawer's per-segment id label (narrator.ts → maybeEnableAuthorTools
// / addSegmentName). Every `<figure id>` in the article body gets a small
// monospace id label that floats in the left gutter, hidden until the author
// hovers (or keyboard-focuses) the figure. Clicking it copies the bare figure
// id to the clipboard and briefly flips to a green check — the same gesture and
// feedback the segment-id label uses, so reading a figure's id off the page and
// pasting it into a search / a `<mark figure=…>` is one click instead of a dig
// through the post source.
//
// Gated identically to the narrator's author tools, and for the same reasons:
//   - localhost only — this is a local authoring aid, never shipped reader UI.
//     Non-localhost visitors short-circuit before any network call.
//   - the server-authoritative `isAuthor` flag from /post-version — never trust
//     the DOM for authorship (the `<meta name="author-email">` tag is stripped
//     in prod, so a client-side check would read false there anyway).
// Either gate failing makes this a complete no-op: no labels, no DOM changes.
//
// Idempotent: re-running install is a no-op (each figure is tagged with
// `data-figure-id-copy="installed"`).

import { copyToClipboard } from "./clipboard.ts";
import { fetchPostVersion } from "./postVersion.ts";

// How long the "Copied" feedback (green id + trailing check) stays visible
// after a successful copy. Matches the segment-id label's window in narrator.ts.
const FEEDBACK_MS = 1000;

let activeFeedbackTimer: number | null = null;

function flashCopied(label: HTMLButtonElement): void {
  label.classList.add("is-copied");
  if (activeFeedbackTimer !== null) window.clearTimeout(activeFeedbackTimer);
  activeFeedbackTimer = window.setTimeout(() => {
    label.classList.remove("is-copied");
    activeFeedbackTimer = null;
  }, FEEDBACK_MS);
}

function buildLabel(id: string): HTMLButtonElement {
  const label = document.createElement("button");
  label.type = "button";
  label.className = "figure-id-copy";
  label.textContent = id;
  label.title = `Copy figure id (${id})`;
  label.setAttribute("aria-label", `Copy figure id ${id}`);
  label.addEventListener("click", () => {
    void copyToClipboard(id).then((ok) => {
      if (ok) flashCopied(label);
    });
  });
  return label;
}

// Attach the hover-revealed id label to every `<figure id>` in the article.
// Exported for the unit test; safe to call more than once.
export function installFigureIdCopies(article: HTMLElement): void {
  for (const figure of article.querySelectorAll<HTMLElement>("figure[id]")) {
    if (figure.dataset.figureIdCopy === "installed") continue;
    const id = figure.id;
    if (!id) continue;
    // The label is absolutely positioned in the left gutter (see base.css),
    // so the figure must be its positioning context. Safe to flip to
    // `position: relative`: every figure's animated content lives inside its
    // own `position: relative` inner wrapper (`.bat-fig`, `.vol-chart`, …), so
    // nothing resolves its offsets against the bare `<figure>`. The class —
    // not a blanket `figure { position: relative }` — keeps the change opt-in
    // per figure and absent entirely for non-author readers.
    figure.classList.add("has-figure-id-copy");
    figure.appendChild(buildLabel(id));
    figure.dataset.figureIdCopy = "installed";
  }
}

// Mirror the narrator's gate exactly: localhost AND server-authoritative
// isAuthor. Returns false (no fetch) for ordinary readers on any other host.
async function authorToolsEnabled(): Promise<boolean> {
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!isLocal) return false;
  const version = await fetchPostVersion(window.location.pathname);
  return version?.isAuthor === true;
}

async function boot(): Promise<void> {
  // Same article-root selector the byline / comments / heading-link layers use;
  // present on every post, including narration opt-outs.
  const article = document.querySelector<HTMLElement>("[data-narration-src]");
  if (!article) return;
  if (!(await authorToolsEnabled())) return;
  installFigureIdCopies(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
