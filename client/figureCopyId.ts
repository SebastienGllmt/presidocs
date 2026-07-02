// Block-id copy affordance — an author/dev-only debugging aid that mirrors the
// narration drawer's per-segment id label (narrator.ts → maybeEnableAuthorTools
// / addSegmentName). Every `<figure id>` and every `<p id>` in the article body
// gets a small monospace id label that floats in the left gutter. Clicking it
// copies the bare id to the clipboard and briefly flips to a green check — the
// same gesture and feedback the segment-id label uses, so reading a block's id
// off the page and pasting it into a prompt ("modify the figure …" / "rewrite
// the paragraph …"), a search, or a `<mark figure=…>` is one click instead of a
// dig through the post source.
//
// Figures and paragraphs differ in ONE way, for a reason: a figure is not a
// commentable block, so its label carries the id as a real text node (which
// also lets the author drag-select it for a plain Ctrl+C). A `<p>` IS a
// commentable block, and comments/blockIndex.ts hashes each block's textContent to anchor
// threads — a text node here would leak the id into that hash and silently
// break anchoring. So the paragraph label renders its id via a CSS
// `::before { content: attr(data-pid) }` (see base.css), which textContent
// never sees; the cost is only that the paragraph id can't be drag-selected
// (click still copies it).
//
// Gated identically to the narrator's author tools, and for the same reasons:
//   - localhost only — this is a local authoring aid, never shipped reader UI.
//     Non-localhost visitors short-circuit before any network call.
//   - the server-authoritative `isAuthor` flag from /post-version — never trust
//     the DOM for authorship (the `<meta name="author-email">` tag is stripped
//     in prod, so a client-side check would read false there anyway).
// Either gate failing makes this a complete no-op: no labels, no DOM changes.
//
// Idempotent: re-running install is a no-op (each block is tagged with
// `data-figure-id-copy` / `data-paragraph-id-copy="installed"`).

import { copyWithFeedback } from "./copyFeedback.ts";
import { fetchPostVersion } from "./postVersion.ts";

// How long the "Copied" feedback (green id + trailing check) stays visible
// after a successful copy. Matches the segment-id label's window in narrator.ts.
const FEEDBACK_MS = 1000;

const copyId = copyWithFeedback("is-copied", FEEDBACK_MS);

function buildLabel(id: string, kind: "figure" | "paragraph"): HTMLButtonElement {
  const label = document.createElement("button");
  label.type = "button";
  if (kind === "figure") {
    // Figures aren't comment blocks: carry the id as a real text node so it's
    // drag-selectable (CSS gives the value `user-select: all`) and Ctrl+F
    // finds it on the page. A leading "#" makes the label read like an anchor
    // and lets Ctrl+F match "#id" too; it's a SEPARATE, non-selectable span so
    // neither a drag-select Ctrl+C nor the click handler (which copies the
    // bare `id`) ever carries the "#".
    label.className = "figure-id-copy";
    const hash = document.createElement("span");
    hash.className = "id-copy-hash";
    hash.textContent = "#";
    const value = document.createElement("span");
    value.className = "id-copy-value";
    value.textContent = id;
    label.append(hash, value);
  } else {
    // Paragraphs are comment blocks (see header note): keep the id OUT of
    // textContent so comments/blockIndex.ts's per-block hash is undisturbed. The visible
    // id (with a leading "#") comes from a CSS `::before` reading this
    // `data-pid` — pseudo-content, so it stays invisible to the comment hash.
    label.className = "paragraph-id-copy";
    label.dataset.pid = id;
  }
  label.title = `Copy ${kind} id (${id})`;
  label.setAttribute("aria-label", `Copy ${kind} id ${id}`);
  label.addEventListener("click", () => {
    void copyId(id, label);
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
    figure.appendChild(buildLabel(id, "figure"));
    figure.dataset.figureIdCopy = "installed";
  }
}

// Attach the same gutter id label to every `<p id>` in the article. The label
// is an empty <button> whose id text lives in `data-pid` (rendered via CSS),
// so it never enters the paragraph's textContent — see the header note on
// comment-hash safety. <button> is phrasing content, so it's valid inside <p>,
// and `position: absolute` keeps it out of the text flow. Exported for the
// unit test; safe to call more than once.
export function installParagraphIdCopies(article: HTMLElement): void {
  for (const p of article.querySelectorAll<HTMLElement>("p[id]")) {
    if (p.dataset.paragraphIdCopy === "installed") continue;
    const id = p.id;
    if (!id) continue;
    // The paragraph becomes the positioning context for the gutter label.
    // Safe on a <p>: its content is normal-flow inline text with nothing
    // resolving offsets against it, and the class keeps the change opt-in.
    p.classList.add("has-paragraph-id-copy");
    p.appendChild(buildLabel(id, "paragraph"));
    p.dataset.paragraphIdCopy = "installed";
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
  installParagraphIdCopies(article);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
