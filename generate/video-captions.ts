// ASS karaoke caption emitter for the video export (pure; unit-tested via the
// re-exports in render-video.ts). See methodology.md → "Video export".
//
// The manifest timeline shape is the shared one (single source of truth with
// the producer + the live narrator). Aliased to this file's existing local
// names. Time fields carry the `Milliseconds` brand; this file reads them as
// plain numbers (a brand widens to `number`), so its arithmetic is unchanged.
import type {
  ManifestMark as Mark,
  ManifestWord as Word,
} from "../shared/manifestSchema.ts";

// =============================================================================
// ASS karaoke caption emitter (pure; unit-tested in CP4)
// =============================================================================

/** ms → ASS time `H:MM:SS.cc` (centiseconds). Floors cs so it never rolls to 100. */
export function msToAssTime(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const cc = Math.floor((clamped % 1000) / 10);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cc)}`;
}

/** ASS dialogue text is `{...}`-delimited override blocks; strip braces/newlines
 *  from author text so a stray `{` can't open a bogus override. */
function escapeAssText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[{}]/g, "").replace(/\s+/g, " ");
}

/**
 * Split a mark's words into small caption groups so only ~1–2 lines show at
 * once (the social-caption convention), instead of a whole multi-sentence mark.
 * Flushes on a character budget or word cap; pure + exported for tests.
 */
export function chunkWords(
  words: readonly Word[],
  text: string,
  maxChars = 40,
  maxWords = 9,
): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (const w of words) {
    const len = text.slice(w.s, w.e).length + 1;
    if (cur.length > 0 && (chars + len > maxChars || cur.length >= maxWords)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += len;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

export type KaraokeStyle = {
  playResX: number;
  playResY: number;
  fontName: string;
  fontSize: number;
  primary: string; // already-spoken / "sung" colour (ASS &HAABBGGRR)
  secondary: string; // upcoming / not-yet-spoken colour
  outline: string;
  marginV: number;
  marginLR: number;
};

export const DEFAULT_KARAOKE_STYLE: KaraokeStyle = {
  playResX: 1080,
  playResY: 1920,
  fontName: "DejaVu Sans",
  fontSize: 60,
  primary: "&H00FFFFFF", // white once spoken
  secondary: "&H0081766E", // muted slate before spoken
  outline: "&H00000000", // black outline for legibility on any background
  marginV: 380,
  marginLR: 90,
};

/**
 * Build an ASS subtitle with word-level karaoke (`\k`) timing from the manifest
 * marks, chunked to ~1–2 lines. Times are rebased into the trimmed [t0,t1)
 * timeline (subtract t0) so they line up with audio fed through `-ss t0`.
 */
export function buildKaraokeAss(
  marks: readonly Mark[],
  t0: number,
  t1: number,
  style: KaraokeStyle = DEFAULT_KARAOKE_STYLE,
  // audio-rel ms → video-rel ms (identity unless holds were inserted). Caption
  // groups never span a hold (holds sit on mark boundaries), so mapping start
  // and end is sufficient.
  mapMs: (audioRelMs: number) => number = (a) => a,
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 2 = bottom-centre; Outline 4 + Shadow 1 keep it readable.
    `Style: Karaoke,${style.fontName},${style.fontSize},${style.primary},${style.secondary},${style.outline},&H64000000,-1,0,0,0,100,100,0,0,1,4,1,2,${style.marginLR},${style.marginLR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  for (const mark of marks) {
    const inSpan = (mark.words ?? []).filter((w) => w.t < t1 && w.t + w.d > t0);
    if (inSpan.length === 0) continue;

    for (const group of chunkWords(inSpan, mark.text)) {
      const start = mapMs(group[0]!.t - t0);
      const last = group[group.length - 1]!;
      const end = mapMs(last.t + last.d - t0);

      let text = "";
      for (let i = 0; i < group.length; i++) {
        const w = group[i]!;
        const next = group[i + 1];
        // Hold the current word's highlight through any gap before the next
        // word *in this group*; the group's last word resets at its own end so
        // the highlight never bleeds into the following caption.
        const chunkMs = next ? next.t - w.t : w.d;
        const cs = Math.max(0, Math.round(chunkMs / 10));
        const token = mark.text.slice(w.s, w.e);
        const sep = next ? mark.text.slice(w.e, next.s) : "";
        text += `{\\k${cs}}${escapeAssText(token + sep)}`;
      }
      events.push(`Dialogue: 0,${msToAssTime(start)},${msToAssTime(end)},Karaoke,,0,0,0,,${text}`);
    }
  }

  return [...header, ...events].join("\n") + "\n";
}
