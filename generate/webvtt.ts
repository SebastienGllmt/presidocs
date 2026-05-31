// WebVTT sidecar emitter — generates `captions.vtt` for a post from the same
// `marks[].words` table the manifest carries. One cue per `<mark>` segment;
// intra-cue timestamp tags (`<00:00:00.300>`) per word inside the cue. The
// runtime drawer does NOT consume this file — it reads the same data inline
// from manifest.json at runtime, sidestepping a second fetch and a parser.
// The sidecar exists for:
//   - The future social-media video subtitle pipeline (out of scope, see
//     proposals/17 §10): ffmpeg's `subtitles=` filter and most other caption-
//     burning tools speak WebVTT natively.
//   - General interop with caption tooling (editors, validators) that already
//     understand the format.
//
// The "one alignment table, two emitters" pattern matches how the existing
// chapter pipeline already works (the same chapter table feeds the in-MP3
// ID3 CHAP frames AND the `<podcast:chapters>` JSON sidecar) — see
// methodology.md "Subscription feeds".
//
// Emit-or-skip rule: we only write captions.vtt when at least one mark
// carries `words[]`. A post built without `--align=...` therefore continues
// to emit no extra files — strict additive compatibility with the prior
// pipeline output.

import type { Milliseconds } from "../shared/time.ts";

export interface VttWord {
  s: number;
  e: number;
  t: Milliseconds;
  d: Milliseconds;
}
export interface VttMark {
  name: string;
  time: Milliseconds;
  text?: string;
  words?: VttWord[];
}

// Format an integer-ms timestamp as `HH:MM:SS.mmm` (WebVTT's canonical
// timestamp form; the spec allows hours to be omitted for <1h cues but
// always including HH keeps the writer trivial and the format consistent).
export function msToVttTime(ms: Milliseconds): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const mmm = total % 1000;
  return (
    h.toString().padStart(2, "0") +
    ":" +
    m.toString().padStart(2, "0") +
    ":" +
    s.toString().padStart(2, "0") +
    "." +
    mmm.toString().padStart(3, "0")
  );
}

// WebVTT cue text uses HTML-style entities; `&`, `<`, `>` must be escaped
// because `<` opens an intra-cue tag (timestamp, voice span, etc.) and `>`
// closes one. Newlines inside a cue payload are also significant (each line
// is a separate cue line, which most renderers stack), so we collapse any
// whitespace runs we slice out of the source.
function escapeCueText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render one cue's payload (the text after the time line). When the mark
// carries words, we interleave `<HH:MM:SS.mmm>` tags before each word's
// text so karaoke renderers can advance through the cue at the right pace.
// When it doesn't, we emit the full text as a single line.
function renderCuePayload(mark: VttMark): string {
  const text = mark.text ?? "";
  if (!mark.words || mark.words.length === 0) {
    return escapeCueText(collapseWhitespace(text));
  }
  // Per spec, an intra-cue timestamp tag at the very start of a cue is
  // optional (the cue's start time is already the implicit first timestamp);
  // we emit it anyway so every word has its own tag, which is what existing
  // karaoke libraries (vtt.js variants, ffmpeg's WebVTT muxer) reliably read.
  const parts: string[] = [];
  let cursor = 0;
  for (const w of mark.words) {
    if (w.s > cursor) {
      // Inter-word gap text (spaces, punctuation outside [s,e)).
      parts.push(escapeCueText(text.slice(cursor, w.s)));
    }
    parts.push("<" + msToVttTime(w.t) + ">");
    parts.push(escapeCueText(text.slice(w.s, w.e)));
    cursor = w.e;
  }
  if (cursor < text.length) parts.push(escapeCueText(text.slice(cursor)));
  return collapseWhitespace(parts.join(""));
}

// Cue text in WebVTT can't contain a blank line (a blank line ends the cue),
// so we collapse any internal newlines to a single space. The narration text
// shouldn't contain newlines in practice (segments are one paragraph), but
// be defensive against authored multi-line strings.
function collapseWhitespace(s: string): string {
  return s.replace(/\r?\n+/g, " ").replace(/[ \t]+/g, " ").trim();
}

// Compute a cue's end time. With words: the last word's `t + d`. Without
// words: the next mark's `time` (or `fallbackEnd` if this is the last mark).
function cueEnd(mark: VttMark, fallbackEnd: Milliseconds): Milliseconds {
  if (mark.words && mark.words.length > 0) {
    const last = mark.words[mark.words.length - 1]!;
    return (last.t + last.d) as Milliseconds;
  }
  return fallbackEnd;
}

// Cue identifiers in WebVTT can't contain "-->" (which would be parsed as a
// timestamp line). Mark names are author-controlled CSS-id-like strings, so
// this is paranoia, but cheap.
function sanitizeCueId(id: string): string {
  return id.replace(/-->/g, "--&gt;");
}

export interface BuildVttInput {
  marks: VttMark[];
  // Duration of the whole track — used as the fallback `endTime` for the
  // last mark when it carries no words (so the cue actually has a duration).
  duration: Milliseconds;
}

export function buildVtt(input: BuildVttInput): string {
  const { marks, duration } = input;
  const out: string[] = ["WEBVTT", ""];
  out.push("NOTE Generated by presidocs from manifest.json (one cue per <mark>");
  out.push("NOTE segment; intra-cue timestamp tags carry per-word timing for");
  out.push("NOTE karaoke-style subtitle rendering). See proposals/17.");
  out.push("");
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const nextStart =
      i + 1 < marks.length ? (marks[i + 1]!.time as Milliseconds) : duration;
    const end = cueEnd(m, nextStart);
    // Skip degenerate zero-duration cues (could arise if a mark coincides
    // with the very last sample). Most renderers accept them but it's noise.
    if (end <= m.time) continue;
    out.push(sanitizeCueId(m.name));
    out.push(`${msToVttTime(m.time)} --> ${msToVttTime(end)}`);
    out.push(renderCuePayload(m));
    out.push("");
  }
  return out.join("\n");
}

// True iff the manifest has any alignment data worth writing out. Used by
// the generator to decide whether to emit captions.vtt at all — keeps the
// pre-alignment build output byte-for-byte unchanged.
export function hasAlignment(marks: readonly VttMark[]): boolean {
  return marks.some((m) => m.words && m.words.length > 0);
}
