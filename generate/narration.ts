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
export type Segment = { markName: string | null; text: string; continuesPrevious: boolean };

const markRegex = /<mark\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\/?\s*>(?:\s*<\/mark\s*>)?/g;

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

export function splitChapter(content: string): Segment[] {
  const out: Segment[] = [];
  let currentMark: string | null = null;
  let lastEnd = 0;
  // First emitted segment of a chapter is always a fresh start; thereafter a
  // blank line before the mark flips the upcoming segment back to fresh.
  let firstEmitted = true;
  let breakBeforeNext = false;

  const push = (rawText: string) => {
    const text = normalizeWhitespace(rawText);
    if (currentMark !== null || text) {
      out.push({ markName: currentMark, text, continuesPrevious: !firstEmitted && !breakBeforeNext });
      firstEmitted = false;
    }
  };

  for (const match of content.matchAll(markRegex)) {
    const before = content.slice(lastEnd, match.index);
    push(before);
    // The whitespace at the end of `before` is the gap immediately preceding
    // THIS mark, so it decides whether the mark's segment is a fresh start.
    breakBeforeNext = blankLineBeforeMark(before);
    currentMark = match[1] ?? match[2] ?? null;
    lastEnd = match.index + match[0].length;
  }
  push(content.slice(lastEnd));

  return out;
}
