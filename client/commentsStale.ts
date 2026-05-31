// Pure stale-detection for comment threads. The article-walker in
// comments.ts re-hashes each block on every render and caches the result
// keyed by stable block id; this helper just asks "does any block this
// thread referenced still hash the same?" The DOM-side caller passes a
// `blocksById` Map (or any read-by-id getter) — this file never touches
// the DOM itself, so the rule is unit-testable without happy-dom.
//
// Extracted as Tier-0 so the "orphan + flag" logic is pinned independently
// of every UI rendering decision that wraps around it (highlight visible?
// Hide button suppressed? card slot routing?). See the "Stale anchors:
// orphan + flag" section in methodology.md for the visible behaviour.

export type ReferencedSegment = {
  readonly id: string;
  readonly hash: string;
};

export type CurrentBlock = {
  readonly hash: string;
};

/**
 * `true` if any segment the thread originally anchored to is now missing
 * from the rendered article OR has drifted hash. Mirrors the "the thread
 * is marked outdated" rule.
 *
 * `false` when every referenced segment is present AND its current hash
 * matches the stored one — i.e. the anchor is still safe to draw.
 *
 * A zero-segment input is `false` (nothing to drift); a graphic target
 * has no segments and should be checked via `isTextTarget` upstream.
 */
export function compareSegmentHashes(
  segments: readonly ReferencedSegment[],
  currentBlocks: ReadonlyMap<string, CurrentBlock>,
): boolean {
  for (const seg of segments) {
    const block = currentBlocks.get(seg.id);
    if (!block) return true;
    if (block.hash !== seg.hash) return true;
  }
  return false;
}
