// methodology.md → Comments — pure DOM/offset math for text-selection
// highlights: CSS anchor-name builders, block/offset resolution, and the
// range wrapping that paints (and un-paints) `.cmt-highlight` spans. All free
// functions with no CommentSystem instance state — a unit-test surface that
// doesn't need the whole system instantiated.

// Coerce an arbitrary id into a CSS `<dashed-ident>`-safe tail.
// Thread ids are already alphanumeric (see `uid`), but block / graphic
// ids embed `:` and `__` (e.g. `article:__b-3`), which aren't valid in
// a CSS identifier. The substitution is one-way; uniqueness within our
// id namespace holds because no two distinct ids differ only in `:`.
function cssIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function anchorNameForText(threadId: string): string {
  return `--cmt-${cssIdent(threadId)}`;
}

export function anchorNameForGraphic(graphicId: string): string {
  return `--cmt-graphic-${cssIdent(graphicId)}`;
}

export function offsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  if (node === block) {
    let total = 0;
    for (let i = 0; i < offset && i < block.childNodes.length; i++) {
      total += (block.childNodes[i]?.textContent ?? "").length;
    }
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n === node) return total + offset;
    total += (n.nodeValue ?? "").length;
  }
  return block.textContent?.length ?? 0;
}

export function nodeAtOffset(
  block: HTMLElement,
  charOffset: number,
): { node: Node; offset: number } | null {
  let remaining = charOffset;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.nodeValue?.length ?? 0;
    if (remaining <= len) return { node: n, offset: remaining };
    remaining -= len;
  }
  let last: Text | null = null;
  const w2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (w2.nextNode()) last = w2.currentNode as Text;
  if (last) return { node: last, offset: last.nodeValue?.length ?? 0 };
  return null;
}

export function findBlockFor(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  if (!el) return null;
  return (el as Element).closest<HTMLElement>("[data-comment-block-id]");
}

// ===== Highlight wrapping (DOM-mutating; reversed by `unwrap`) =====

export function wrapRangeInBlock(
  block: HTMLElement,
  start: number,
  end: number,
  threadId: string,
) {
  if (start >= end) return;
  const s = nodeAtOffset(block, start);
  const e = nodeAtOffset(block, end);
  if (!s || !e) return;
  const range = document.createRange();
  try {
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
  } catch {
    return;
  }
  wrapRange(range, threadId);
}

function wrapRange(range: Range, threadId: string) {
  const anchorEl =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!anchorEl) return;
  const walker = document.createTreeWalker(anchorEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (range.intersectsNode(n)) textNodes.push(n);
  }
  if (textNodes.length === 0) return;
  for (const node of textNodes) {
    let target: Text = node;
    const nodeLen = target.nodeValue?.length ?? 0;
    const isStart = node === range.startContainer;
    const isEnd = node === range.endContainer;
    const startInNode = isStart ? range.startOffset : 0;
    const endInNode = isEnd ? range.endOffset : nodeLen;
    if (startInNode >= endInNode) continue;
    if (endInNode < nodeLen) target.splitText(endInNode);
    if (startInNode > 0) target = target.splitText(startInNode);
    const span = document.createElement("span");
    span.className = "cmt-highlight";
    span.dataset.threadId = threadId;
    target.parentNode!.insertBefore(span, target);
    span.appendChild(target);
  }
}

export function unwrap(span: HTMLElement) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  parent.normalize();
}
