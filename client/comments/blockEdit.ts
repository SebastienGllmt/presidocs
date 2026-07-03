// methodology.md → Comments — the §3 "capture-against-original" diff for
// in-place suggestion mode (proposal 65, increment 2). Pure string math: given a
// block's ORIGINAL text and the reader's EDITED text, return the minimal
// replaced window `[start, end)` in the original plus the replacement slice — so
// the suggestion anchors against the published document, never the edited DOM.
// No DOM, no CommentSystem state — a unit-test surface.

export type EditWindow = {
  /** Char offset (UTF-16) into the ORIGINAL block text where the change starts. */
  start: number;
  /** Char offset into the ORIGINAL where the change ends (exclusive). */
  end: number;
  /** Replacement text for `[start, end)`; "" means delete the range. */
  replacement: string;
};

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

// Trim the common prefix and suffix of `original` vs `edited`, returning the
// minimal replaced window in `original` plus the replacement. Returns null for a
// no-op edit (identical text). A pure insertion (zero-length window) is widened
// to the adjacent word so the range is highlightable (wrapRangeInBlock bails on
// start >= end) and reads "word" → "word inserted-text".
export function diffWindow(original: string, edited: string): EditWindow | null {
  if (original === edited) return null;
  const oLen = original.length;
  const eLen = edited.length;

  let start = 0;
  const maxStart = Math.min(oLen, eLen);
  while (start < maxStart && original.charCodeAt(start) === edited.charCodeAt(start)) start++;
  // Don't split a surrogate pair at the prefix boundary: if we stopped just
  // after a high surrogate, step back so the whole astral char is in the window.
  if (start > 0 && isHighSurrogate(original.charCodeAt(start - 1))) start--;

  let oEnd = oLen;
  let eEnd = eLen;
  while (oEnd > start && eEnd > start && original.charCodeAt(oEnd - 1) === edited.charCodeAt(eEnd - 1)) {
    oEnd--;
    eEnd--;
  }
  // Don't split a surrogate pair at the suffix boundary either.
  if (oEnd < oLen && isLowSurrogate(original.charCodeAt(oEnd))) {
    oEnd++;
    eEnd++;
  }

  const win: EditWindow = { start, end: oEnd, replacement: edited.slice(start, eEnd) };
  if (win.start !== win.end) return win;

  // Pure insertion → widen to the nearest word so the anchored range isn't
  // zero-length. Skip any whitespace between the caret and that word (block
  // textContent often carries source indentation, so the caret can sit at a
  // whitespace boundary). Prefer the preceding word, else the following one.
  let ps = win.start;
  while (ps > 0 && /\s/.test(original[ps - 1]!)) ps--; // skip spaces to the left
  let ws = ps;
  while (ws > 0 && !/\s/.test(original[ws - 1]!)) ws--; // the preceding word
  if (ws < ps) {
    return { start: ws, end: win.end, replacement: original.slice(ws, win.start) + win.replacement };
  }
  let pe = win.end;
  while (pe < oLen && /\s/.test(original[pe]!)) pe++; // skip spaces to the right
  let we = pe;
  while (we < oLen && !/\s/.test(original[we]!)) we++; // the following word
  if (we > pe) {
    return { start: win.start, end: we, replacement: win.replacement + original.slice(win.end, we) };
  }
  // No adjacent word at all (insertion into empty/all-whitespace surroundings) —
  // leave the zero-length window; the caller still gets a valid suggestion, it
  // just won't paint a highlight.
  return win;
}
