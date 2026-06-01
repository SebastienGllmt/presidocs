// Comments helpers extracted from comments.ts so they can be unit-tested
// without instantiating the full CommentSystem (which boots Automerge,
// fetches identity, polls the server, and mounts the entire column).
//
// What lives here:
//
//   1. `normalizeText` — the whitespace-collapse rule that feeds the
//      content hash. Load-bearing for stale-anchor detection
//      (commentsStale.ts).
//   2. `walkBlocks` — the depth-first commentable-block iterator. Used
//      both at index time and at insert-id-suffixing time.
//   3. `loadHighlightsHidden` / `saveHighlightsHidden` — the hide-all FAB
//      pref's localStorage round-trip.
//
// Nothing here imports the CommentStore / Automerge / fetch — that's
// what keeps the test layer fast and free of network stubs.

// Tag set the index walker treats as "commentable block roots." Mirrors
// methodology.md's text-anchoring scope.
export const BLOCK_TAGS = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "FIGCAPTION",
]);

/**
 * Collapse runs of whitespace to a single space and trim ends.
 *
 * Feeds the per-block content hash that drives [stale anchor detection](
 * ./commentsStale.ts). The rule is deliberate:
 *
 *   - Single-space collapse: whitespace differences inside the same prose
 *     (e.g. wrapping a long line) must NOT count as a content change, or
 *     re-formatting the source would silently invalidate every comment.
 *   - Edge trim: leading/trailing whitespace in the rendered block (often
 *     introduced by `<p>\n  …\n</p>` indentation in source) must NOT
 *     count either.
 *
 * Any other normalization (lowercasing, NFC, etc.) is deliberately out
 * of scope — the *visible* text is what readers comment on, so case and
 * unicode form are part of the content's identity.
 */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Depth-first walk of `root`'s descendants in document order, yielding
 * elements whose tag is in `tagSet`. Doesn't recurse INTO a matched
 * element — block tags are treated as leaves in our authoring style
 * (we never have a `<p>` inside a `<p>` we'd want to count separately).
 *
 * `<script>` and `<style>` subtrees are skipped entirely — they hold no
 * commentable content and would otherwise pollute the index with
 * synthesized ids that point at non-rendered bytes.
 */
export function* walkBlocks(
  root: Element,
  tagSet: ReadonlySet<string>,
): Generator<HTMLElement> {
  const stack: Element[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node !== root) {
      if (node.tagName === "SCRIPT" || node.tagName === "STYLE") continue;
      if (tagSet.has(node.tagName)) {
        yield node as HTMLElement;
        continue;
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]!);
    }
  }
}

const HIGHLIGHTS_HIDDEN_KEY = "blog-comments-highlights-hidden";

export type HighlightsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * Read the persisted hide-all-highlights pref, defaulting to NOT hidden
 * when absent or unreadable. The storage contract is `"1" ⇒ hidden,
 * anything else ⇒ visible` — deliberately asymmetric so a future feature
 * writing a third value (e.g. "auto") doesn't silently hide highlights.
 */
export function loadHighlightsHidden(
  storage?: HighlightsStorage | null,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(HIGHLIGHTS_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the hide-all-highlights pref. Explicit "0" / "1" sentinels —
 * unlike the capture-controls pref, we don't optimize for the default
 * because the FAB is the only way to flip this and a returning user
 * with a value of "0" is a common case (they hit the FAB on, then off).
 */
export function saveHighlightsHidden(
  storage: HighlightsStorage,
  hidden: boolean,
): void {
  try {
    storage.setItem(HIGHLIGHTS_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Storage refused — pref is best-effort.
  }
}
