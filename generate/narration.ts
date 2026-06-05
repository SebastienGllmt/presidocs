// Splits a chapter's inline narration into per-<mark> segments. Extracted
// from generate.ts so the parsing — especially the paragraph-derived
// continuation signal — is unit-testable in isolation (same rationale as
// audio-pipeline.ts).
//
// The in-chapter format is plain text plus `<mark name="..."/>` boundaries —
// no `<speak>` wrapper, no nested tags, no namespace. So we do not need an
// XML parser; a single regex over `<mark name=...>` (self-closing or with an
// explicit close tag, single or double quotes) gives the boundary positions,
// and everything between two boundaries is the segment's text.
//
// Entities are intentionally NOT decoded: HTMLRewriter hands us script
// content byte-for-byte (RAWTEXT semantics), and the authoring format is
// plain prose — `&` means `&`, not `&amp;`. A literal `<` mid-prose is fine
// because the regex only matches `<mark ...>`, not arbitrary tags.

// `continuesPrevious` carries cross-segment prosody intent (see methodology.md,
// "Cross-segment continuity"): it
// drives whether a TTS engine opens this segment as a continuation or a fresh
// "top-of-paragraph" utterance. It's derived from the authored narration's
// PARAGRAPH structure — a blank line (a paragraph break) in the source right
// before a <mark> resets to a fresh start; soft single-newline line wrapping
// does NOT. The first segment of every chapter is always a fresh start.
//
// `figure` / `step` are the orthogonal stage/control pointers (methodology.md → "Staging a figure from narration"):
// `figure` is which figure is on the stage during this segment (decoupled from
// `markName`, the read-along highlight); `step` drives the per-step slideshow
// (methodology.md → "Live figure driving" page side / "Video export" video renderer). Both are `null` when the `<mark>` omits the
// attribute (= "leave the stage unchanged"); an explicit `figure="none"`/`""`
// records a clear and is carried through as that literal string.
export type Segment = {
  markName: string | null;
  figure: string | null;
  step: string | null;
  text: string;
  continuesPrevious: boolean;
};

// Match a whole `<mark …>` boundary (self-closing or with an explicit close
// tag), capturing its attribute blob — the individual attributes are then read
// out of the blob by `readMarkAttr`, so they may appear in ANY order
// (`<mark figure="x" name="y"/>` parses the same as `name`-first). `[^>]*?` is
// lazy and the class excludes `>`, so it stops at the tag's own close.
const markRegex = /<mark\s+([^>]*?)\s*\/?\s*>(?:\s*<\/mark\s*>)?/g;

// Read one quoted attribute (single or double quotes) out of a `<mark>`'s
// attribute blob, or null when the attribute is absent. The `(?:^|\s)` anchor
// keeps `name` from matching the tail of an unrelated attribute (e.g. a
// hypothetical `data-name`). An explicitly-empty value (`figure=""`) returns
// "" (an explicit clear), distinct from null (absent).
function readMarkAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// True if the trailing whitespace of `before` (the gap right before the next
// <mark>) contains a blank line — i.e. two newlines separated only by spaces/
// tabs. That's the paragraph-break signal for "the next segment is fresh."
function blankLineBeforeMark(before: string): boolean {
  const trailing = /\s*$/.exec(before)?.[0] ?? "";
  return /\n[^\S\n]*\n/.test(trailing);
}

// Pull every `<script type="text/narration">` block out of a post's HTML,
// preserving its in-chapter content byte-for-byte (RAWTEXT, so entities aren't
// decoded — same contract as generate.ts's extractor). Also reports whether the
// post opts out of narration (`<article data-narration="none">`), which the
// caller treats as "no segments here, skip the post."
//
// Factored out of generate.ts so callers that need to LOCATE segments in a post
// — most notably the sound-test page, which finds segments containing a given
// lexeme — can do so without re-implementing the parse. Uses HTMLRewriter (Bun
// built-in) for the same reason generate.ts does: regex on HTML is unsound, and
// `<script>` content is RAWTEXT so its inner `<` doesn't confuse the walker.
// `parentId` is the OPTIONAL second level of chapter hierarchy:
// a block carrying `data-chapter-parent="<id>"` is a sub-chapter of the chapter
// with that id. Absent → a flat, top-level chapter (no hierarchy annotation at
// all). The pointer is read raw here; validation + the two-level cap live
// in generate.ts's `normalizeChapterParents` (a build-time warn, never a hard
// fail), so a typo degrades to flat rather than erroring a batch generate.
export type NarrationChapter = { id: string; title: string; content: string; parentId?: string };
export type NarrationExtract = { disabled: boolean; chapters: NarrationChapter[] };

export function extractNarration(html: string): NarrationExtract {
  let disabled = false;
  let anonCount = 0;
  const chapters: NarrationChapter[] = [];
  let pending: { id: string; title: string; parentId?: string; buf: string[] } | null = null;

  new HTMLRewriter()
    .on('script[type="text/narration"]', {
      element(el) {
        const id =
          el.getAttribute("data-chapter-id") ??
          el.getAttribute("id") ??
          `chapter-${anonCount++}`;
        const title = el.getAttribute("data-chapter-title") ?? id;
        const parentId = el.getAttribute("data-chapter-parent") ?? undefined;
        pending = { id, title, parentId, buf: [] };
        el.onEndTag(() => {
          if (pending) {
            chapters.push({
              id: pending.id,
              title: pending.title,
              content: pending.buf.join(""),
              parentId: pending.parentId,
            });
            pending = null;
          }
        });
      },
      text(t) {
        pending?.buf.push(t.text);
      },
    })
    .on("article[data-narration]", {
      element(el) {
        if ((el.getAttribute("data-narration") ?? "").toLowerCase() === "none") {
          disabled = true;
        }
      },
    })
    .transform(html);

  return { disabled, chapters };
}

export function splitChapter(content: string): Segment[] {
  const out: Segment[] = [];
  let currentMark: string | null = null;
  // The figure/step pointers carried by the mark that opened the current
  // segment. Reset (to null) by every mark unless it re-states the attribute,
  // mirroring the per-mark, annotate-the-change authoring (a segment with no
  // `figure=` carries `null`; the sub-chapter-bounded stickiness is resolved
  // downstream by the renderer/narrator, not here — see render-video.ts).
  let currentFigure: string | null = null;
  let currentStep: string | null = null;
  let lastEnd = 0;
  // First emitted segment of a chapter is always a fresh start; thereafter a
  // blank line before the mark flips the upcoming segment back to fresh.
  let firstEmitted = true;
  let breakBeforeNext = false;

  const push = (rawText: string) => {
    const text = normalizeWhitespace(rawText);
    if (currentMark !== null || text) {
      out.push({
        markName: currentMark,
        figure: currentFigure,
        step: currentStep,
        text,
        continuesPrevious: !firstEmitted && !breakBeforeNext,
      });
      firstEmitted = false;
    }
  };

  for (const match of content.matchAll(markRegex)) {
    const before = content.slice(lastEnd, match.index);
    push(before);
    // The whitespace at the end of `before` is the gap immediately preceding
    // THIS mark, so it decides whether the mark's segment is a fresh start.
    breakBeforeNext = blankLineBeforeMark(before);
    const attrs = match[1] ?? "";
    currentMark = readMarkAttr(attrs, "name");
    currentFigure = readMarkAttr(attrs, "figure");
    currentStep = readMarkAttr(attrs, "step");
    lastEnd = match.index + match[0].length;
  }
  push(content.slice(lastEnd));

  return out;
}
