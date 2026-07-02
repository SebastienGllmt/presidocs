// Splits a chapter's inline narration into per-<mark> segments. Extracted
// from generate.ts so the parsing — especially the paragraph-derived
// continuation signal — is unit-testable in isolation (same rationale as
// audio-pipeline.ts).
//
// The in-chapter format is a sentinel DSL, NOT HTML: plain prose plus
// `<mark .../>` boundary markers — no `<speak>` wrapper, no nested tags, no
// namespace. It must NOT be handed to an HTML/XML tree-builder. `<mark/>` is
// authored self-closing, but HTML has no self-closing for non-void elements, so
// a real parser treats each `<mark>` as an *opening* tag and nests every later
// segment inside it, collapsing the flat boundary structure (verified against
// linkedom: a 3-marker chapter parses to 2 mutually-nested <mark>s that each
// swallow the rest of the prose). So the BOUNDARY scan below is a deliberate
// regex over the sentinels; everything between two boundaries is one segment's
// text, and the whitespace in that gap (notably a blank line) is load-bearing —
// see `blankLineBeforeMark`. This is the rare case where regex-over-angle-
// brackets is the CORRECT tool, because the input is not actually HTML.
//
// Entities in the prose are intentionally NOT decoded: HTMLRewriter hands the
// `<script type="text/narration">` body to extractNarration() byte-for-byte
// (RAWTEXT semantics), and the authoring format is plain prose — `&` means `&`,
// not `&amp;`. A literal `<` mid-prose is fine: the boundary regex only matches
// `<mark ...>`, not arbitrary tags.
//
// The ATTRIBUTES of an individual marker, by contrast, ARE just HTML attributes
// with no nesting to confuse a parser — so `readMarkAttrs` parses each isolated
// `<mark ...>` tag with linkedom (a real parser) instead of a hand-rolled
// attribute regex, getting attribute order, quote style, and the present-but-
// empty (`figure=""`, an explicit clear) vs absent (null) distinction right.
// linkedom is safe here: this module runs only under Bun (the build + dev
// server), never in the browser or the Worker.

import { parseHTML } from "linkedom";

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

// Locate each `<mark …>` boundary (self-closing or with an explicit close tag)
// in the sentinel DSL and capture its raw attribute blob. This is boundary
// DETECTION over a non-HTML format (see the module header for why a tree-
// builder is the wrong tool) — the blob is parsed properly by `readMarkAttrs`.
// `[^>]*?` is lazy and excludes `>`, so it stops at the tag's own close.
const markRegex = /<mark\s+([^>]*?)\s*\/?\s*>(?:\s*<\/mark\s*>)?/g;

// Parse the name/figure/step attributes off ONE `<mark>` marker. The blob is an
// isolated tag with no nesting, so a real HTML parser reads it soundly: any
// attribute order, single/double/unquoted values, and — critically —
// present-but-empty (`figure=""` → "", an explicit stage clear) distinct from
// absent (null, "leave the stage unchanged"). getAttribute returns exactly that
// "" vs null distinction; a `data-name` does not leak into `name`.
function readMarkAttrs(attrs: string): {
  name: string | null;
  figure: string | null;
  step: string | null;
} {
  const el = parseHTML(`<mark ${attrs}>`).document.querySelector("mark");
  return {
    name: el?.getAttribute("name") ?? null,
    figure: el?.getAttribute("figure") ?? null,
    step: el?.getAttribute("step") ?? null,
  };
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

// Inline PLS lexicon blocks, in document order. A separate HTMLRewriter
// pass from extractNarration — the handlers are independent and a build-
// time double parse of one post is free; sharing one pass would couple
// the narration filter (generate-all) to PLS plumbing it never needs.
export function extractPlsBlocks(html: string): string[] {
  const inlinePlsBlocks: string[] = [];
  let pendingPlsBuf: string[] | null = null;

  new HTMLRewriter()
    .on('script[type="application/pls+xml"]', {
      element(el) {
        pendingPlsBuf = [];
        el.onEndTag(() => {
          if (pendingPlsBuf) {
            inlinePlsBlocks.push(pendingPlsBuf.join(""));
            pendingPlsBuf = null;
          }
        });
      },
      text(t) {
        pendingPlsBuf?.push(t.text);
      },
    })
    .transform(html);

  return inlinePlsBlocks;
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
    const { name, figure, step } = readMarkAttrs(match[1] ?? "");
    currentMark = name;
    currentFigure = figure;
    currentStep = step;
    lastEnd = match.index + match[0].length;
  }
  push(content.slice(lastEnd));

  return out;
}
