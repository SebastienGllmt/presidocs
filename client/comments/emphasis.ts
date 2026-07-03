// methodology.md → Comments — emphasis serialization for in-place suggestion
// mode (proposal 65, increment 2). The reader edits WYSIWYG (real bold/italic
// rendered in the contenteditable block); on commit we serialize that back to
// text carrying only `<em>`/`<strong>` tags — the wire form the authoring loop
// applies to HTML source. Any other wrapper (links, code, comment highlights,
// stray spans from execCommand) collapses to its inner text/emphasis.
//
// Pure DOM→string + string helpers, no CommentSystem state — a unit-test surface.

const EMPHASIS_TAGS = /<\/?(?:em|strong)>/g;

function isBoldWeight(weight: string): boolean {
  if (weight === "bold" || weight === "bolder") return true;
  const n = parseInt(weight, 10);
  return Number.isFinite(n) && n >= 600;
}

// Serialize a node's descendants to text with only `<em>`/`<strong>` markup.
// `<em>`/`<i>` (or inline `font-style: italic`) → `<em>`; `<strong>`/`<b>` (or
// bold `font-weight`) → `<strong>`; everything else emits its inner content.
export function serializeEmphasis(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? "";
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    let s = serializeEmphasis(el);
    const tag = el.tagName;
    if (tag === "EM" || tag === "I" || el.style.fontStyle === "italic") s = `<em>${s}</em>`;
    if (tag === "STRONG" || tag === "B" || isBoldWeight(el.style.fontWeight)) s = `<strong>${s}</strong>`;
    out += s;
  });
  return out;
}

export function stripEmphasisTags(s: string): string {
  return s.replace(EMPHASIS_TAGS, "");
}

// Inverse of serializeEmphasis: parse a proposed string into DOM nodes, treating
// ONLY `<em>`/`<strong>` as markup and everything else (including any other
// `<...>`) as literal text. Never uses innerHTML, so reader-supplied proposed
// text can't inject markup — safe to insert into the page for preview.
export function parseEmphasis(s: string): Node[] {
  const out: Node[] = [];
  const stack: HTMLElement[] = [];
  const push = (n: Node) => {
    if (stack.length) stack[stack.length - 1]!.appendChild(n);
    else out.push(n);
  };
  const re = /<(\/?)(em|strong)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) push(document.createTextNode(s.slice(last, m.index)));
    const tag = m[2]!;
    if (m[1] === "/") {
      if (stack.length && stack[stack.length - 1]!.tagName.toLowerCase() === tag) stack.pop();
    } else {
      const el = document.createElement(tag);
      push(el);
      stack.push(el);
    }
    last = re.lastIndex;
  }
  if (last < s.length) push(document.createTextNode(s.slice(last)));
  return out;
}

// Plain-text offset (tags removed) corresponding to a byte offset into a
// serialized string. Also drops a dangling partial tag at the cut, so a diff
// boundary that lands mid-tag still maps to a sane plain offset.
export function plainOffset(serialized: string, at: number): number {
  return stripEmphasisTags(serialized.slice(0, at)).replace(/<[^>]*$/, "").length;
}

// Widen a diffWindow computed over emphasis-serialized strings so neither
// boundary cuts through a tag. The char-level trim splits same-position tag
// swaps mid-token — `<em>a</em>` → `<strong>a</strong>` shares the prefix "<"
// and suffix ">", leaving `replacement: "strong>a</strong"` (unbalanced
// garbage in the proposed text). Both strings are identical before
// `win.start` and after the trimmed suffix, so shifting a boundary by the
// same delta in both keeps the window consistent; we snap to the ORIGINAL's
// tag spans and the shared prefix/suffix carries the fix to the edited side.
export function snapWindowToEmphasisTags(
  original: string,
  edited: string,
  win: { start: number; end: number; replacement: string },
): { start: number; end: number; replacement: string } {
  let { start, end } = win;
  // End of the replacement in `edited`: it always starts at the same `start`
  // (common prefix), so its length locates the suffix boundary.
  let eEnd = start + win.replacement.length;
  const re = /<\/?(?:em|strong)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(original)) !== null) {
    const ts = m.index;
    const te = ts + m[0].length;
    if (ts < start && start < te) start = ts; // boundary inside this tag → include it whole
    if (ts < end && end < te) {
      eEnd += te - end;
      end = te;
    }
    if (ts >= end) break;
  }
  if (start === win.start && end === win.end) return win;
  return { start, end, replacement: edited.slice(start, eEnd) };
}
