// methodology.md → Comments — the word-granular diff preview a suggestion card
// shows (struck original, inserted proposed). Display-only: the anchor window is
// the hand-rolled trim in draftManager, never this. jsdiff (`diff` v9) is
// imported ONLY here so its ~3 KB stays in the lazy comments chunk — proposal 65.

import { diffWordsWithSpace } from "diff";

// Word-diff is Myers under the hood — ~O(n·d), which degrades toward O(n²) when
// the two texts diverge a lot. This runs synchronously on every keystroke in a
// suggestion's edit box AND once per suggestion card on every renderAll, so an
// unbounded call on a large, heavily-rewritten selection can lock the main
// thread. Above this combined length we drop to the zero-dep whole-string
// fallback (the proposal's documented degrade) instead of freezing the tab.
// A generous ceiling: normal sentence/paragraph suggestions are far below it.
const WORD_DIFF_MAX = 4000;

// Build a diff element for `original → proposed`: removed words struck,
// added words green, unchanged words plain. Empty `proposed` renders the
// whole original struck (a "delete this" suggestion).
export function buildDiffPreview(original: string, proposed: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cmt-diff";
  if (original.length + proposed.length > WORD_DIFF_MAX) {
    // Coarse fallback: strike the whole original, insert the whole proposed.
    // No word granularity, but bounded and never blocks.
    if (original) wrap.appendChild(diffSpan("cmt-diff-del", original));
    if (proposed) wrap.appendChild(diffSpan("cmt-diff-ins", proposed));
    return wrap;
  }
  for (const part of diffWordsWithSpace(original, proposed)) {
    wrap.appendChild(
      diffSpan(part.added ? "cmt-diff-ins" : part.removed ? "cmt-diff-del" : "cmt-diff-eq", part.value),
    );
  }
  return wrap;
}

function diffSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
