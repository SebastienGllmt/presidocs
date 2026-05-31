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
//   3. `computePopoverPositionForRect` — the pure math half of the
//      mobile-popover anchor placement. The class-level wrapper resolves
//      the anchor element; this helper takes the resolved rect plus
//      viewport / dock dimensions and returns the inline style overrides
//      (top/bottom/max-height).
//   4. `loadHighlightsHidden` / `saveHighlightsHidden` — the hide-all FAB
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

// Minimal Rect shape the popover positioner reads. Matches the subset of
// `DOMRect` the production code touches.
export type AnchorRect = {
  readonly top: number;
  readonly bottom: number;
};

export type PopoverDimensions = {
  readonly viewportHeight: number;
  readonly dockHeight: number;
};

export type PopoverPosition = {
  top?: string;
  bottom?: string;
  maxHeight: string;
};

// Constants the production positioner uses; exported so a future caller
// (or test) can reason about the band where placement flips between
// "below" and "above."
export const POPOVER_GAP_PX = 8;
export const POPOVER_TOP_MARGIN_PX = 16;
export const POPOVER_MIN_HEIGHT_PX = 140;
// Extra clearance above the dock so the popover doesn't kiss its top edge.
export const POPOVER_DOCK_CLEARANCE_PX = 24;

/**
 * Compute the inline style for the mobile popover anchored to an
 * element. The implementation prefers placement BELOW the anchor — where
 * a contextual menu is conventionally expected — unless there's clearly
 * more usable space above.
 *
 *   - "Usable space below" is the band between the anchor's bottom edge
 *     (+ gap) and the reserved bottom margin for the player dock.
 *   - "Usable space above" is the band between the anchor's top edge
 *     (− gap) and the viewport's top margin.
 *   - Below wins ties; only when `spaceBelow < MIN_HEIGHT AND
 *     spaceBelow < spaceAbove` do we flip to "above."
 *
 * Always returns BOTH `top` OR `bottom` AND `max-height`; the caller
 * writes `auto` for whichever isn't set so a stale value from a previous
 * desktop layout pass can't bleed through (methodology calls this out
 * as the load-bearing inline-style rule).
 */
export function computePopoverPositionForRect(
  rect: AnchorRect,
  { viewportHeight, dockHeight }: PopoverDimensions,
): PopoverPosition {
  const BOTTOM_RESERVE = dockHeight + POPOVER_DOCK_CLEARANCE_PX;
  const spaceBelow =
    viewportHeight - BOTTOM_RESERVE - rect.bottom - POPOVER_GAP_PX;
  const spaceAbove = rect.top - POPOVER_TOP_MARGIN_PX - POPOVER_GAP_PX;
  const placeBelow =
    spaceBelow >= POPOVER_MIN_HEIGHT_PX || spaceBelow >= spaceAbove;

  if (placeBelow) {
    return {
      top: `${Math.round(Math.max(POPOVER_TOP_MARGIN_PX, rect.bottom + POPOVER_GAP_PX))}px`,
      maxHeight: `${Math.max(POPOVER_MIN_HEIGHT_PX, spaceBelow)}px`,
    };
  }
  return {
    bottom: `${Math.round(Math.max(BOTTOM_RESERVE, viewportHeight - rect.top + POPOVER_GAP_PX))}px`,
    maxHeight: `${Math.max(POPOVER_MIN_HEIGHT_PX, spaceAbove)}px`,
  };
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
