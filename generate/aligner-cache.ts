// Segment-level disk cache for forced-alignment output, layered on top of the
// TTS cache. The two caches share their key scheme by design (alignment is a
// pure function of audio + text, and audio is a pure function of the TTS
// inputs) — so the words.json for a segment lives RIGHT NEXT to the .wav for
// that segment, under the same `<text-hash>/<full-hash>` directory used by
// tts-cache.ts. A segment re-roll invalidates both atomically; a TTS cache
// hit with a missing words.json triggers a backfill alignment on the cached
// audio (no re-synthesis). See proposals/17 §7.2.
//
// What this module does NOT compute itself:
//   - Master-track absolute time. Words are stored relative to the segment's
//     own WAV start (0 = first sample). The manifest serializer in
//     generate.ts shifts them by the chapter's leading-silence trim, the
//     segment's position inside the chapter, and the chapter's offset in the
//     full track. Keeping the cache position-independent means the same
//     cached segment can be reused across posts (as the TTS cache already
//     allows) without re-aligning per build.
//
//   - The substitution map. We call applyLexiconWithMap here so the cached
//     `s`/`e` fields point at the ORIGINAL (displayed) text, but we don't
//     persist the map itself — it's a cheap recompute from (text, lexicon).

import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  applyLexiconWithMap,
  projectSubstitutedPosToOriginal,
  type LexEntry,
} from "./pronunciation.ts";
import { findTokenOffsetsInSubstituted, type ForcedAligner } from "./aligner.ts";
import { asMs, type Milliseconds } from "../shared/time.ts";

// One word in the segment's text, with timing relative to the segment's own
// WAV start. Matches the proposals/17 §6 manifest shape exactly so the
// serializer doesn't have to translate field names — it just shifts `t` into
// master-track time.
export interface CachedWord {
  s: number;        // start char offset in the ORIGINAL segment text
  e: number;        // end char offset (exclusive)
  t: Milliseconds;  // start time relative to segment WAV
  d: Milliseconds;  // duration
}

// Persisted shape. The version field is a forward-compatibility hatch — bump
// it if we ever change what the offsets mean (e.g. graphemes vs. clusters).
interface WordsFile {
  version: 1;
  words: CachedWord[];
}

const WORDS_FILE_VERSION: 1 = 1;
const WORDS_FILENAME_SUFFIX = ".words.json";

export interface AlignmentCacheConfig {
  // Same root the TTS cache uses. We co-locate words.json next to .wav under
  // `<cacheDir>/<textHash>/<fullHash>.words.json`.
  cacheDir: string;
  // The aligner instance. Stateful (a future worker-style backend will hold a
  // long-lived model); the cache forwards `close()` like the TTS cache does.
  aligner: ForcedAligner;
  // Language fed to the aligner. Defaults to English at the factory layer.
  language?: string;
  // PLS lexicon entries + capability flag. The TTS provider already has these
  // for synthesis; we receive a copy so we can re-derive the substituted text
  // and the substitution map here. Pass `null`/empty to skip PLS (in which
  // case originalText == substituted text).
  lexicon: { entries: LexEntry[]; ipaSupported: boolean };
  // Temp-file dir for the WAV we hand to the aligner subprocess. align.py
  // takes a path, not bytes, so we have to spill the buffer to disk.
  // Defaults to TMPDIR / /tmp.
  tmpDir?: string;
  // Per-text override that forces a fresh alignment even when the words.json
  // cache file exists. Mirrors TtsCacheConfig.forceResynthesize and is wired
  // to the SAME forcedTexts set in generate.ts so a `--force-mark` re-roll
  // invalidates the WAV AND the words.json together (otherwise the stale
  // words.json — keyed on the same fullHash as the overwritten WAV — would
  // describe audio the new take no longer matches).
  forceRealign?: (originalText: string) => boolean;
}

export interface AlignmentCacheStats {
  hits: number;
  misses: number;
  // Total tokens the aligner emitted across all misses this run. Paired with
  // `unlocatedTokens` to compute the "% couldn't be located" quality signal
  // the generator logs — knowing 50 unlocated out of 5000 is fine but 50 out
  // of 200 is alarming, and the raw counts alone don't disambiguate.
  totalTokens: number;
  // Tokens the matcher couldn't locate in the substituted text. Surfaced for
  // the generator to log — a non-zero count is a quality signal worth seeing
  // (could mean the aligner's tokenization differs from whitespace splitting,
  // or punctuation normalization is needed).
  unlocatedTokens: number;
}

export interface CachedAligner {
  // Align one segment. Caller supplies the cache hashes (already computed by
  // the TTS cache layer) so we don't recompute them. Returns the word list
  // ready for the manifest serializer to shift into master-track time.
  align(
    textHash: string,
    fullHash: string,
    originalText: string,
    audio: Uint8Array,
  ): Promise<CachedWord[]>;
  readonly stats: AlignmentCacheStats;
  close?(): Promise<void> | void;
}

// Round-trip the buffer through a temp WAV file so the aligner subprocess
// (which takes a path, not bytes) can read it. Returns the path and a
// cleanup function the caller must invoke in `finally`.
async function writeTempWav(audio: Uint8Array, tmpDir: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = join(
    tmpDir,
    `presidocs-align-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
  );
  await writeFile(path, audio);
  return {
    path,
    cleanup: () => rm(path, { force: true }),
  };
}

export function wrapWithAlignmentCache(config: AlignmentCacheConfig): CachedAligner {
  const stats: AlignmentCacheStats = { hits: 0, misses: 0, totalTokens: 0, unlocatedTokens: 0 };
  const tmpDir = config.tmpDir ?? process.env.TMPDIR ?? "/tmp";

  return {
    stats,
    close: config.aligner.close ? () => config.aligner.close!() : undefined,
    async align(textHash, fullHash, originalText, audio) {
      const bucket = join(config.cacheDir, textHash);
      const path = join(bucket, `${fullHash}${WORDS_FILENAME_SUFFIX}`);
      const wavPath = join(bucket, `${fullHash}.wav`);
      const forced = config.forceRealign?.(originalText) ?? false;
      if (!forced && existsSync(path)) {
        // Staleness check: if the sibling .wav is newer than this .words.json,
        // the audio was overwritten without a paired re-align (e.g., a
        // `--force-mark` re-roll done in a prior run that didn't have
        // `--align=...` enabled). The cached words describe audio that no
        // longer exists at this hash, so we treat it as a miss. One stat()
        // per cache lookup — negligible. We compare mtime *strictly* (wav >
        // words): a same-mtime tie is treated as fresh because both files
        // are written within the same generate run on a miss.
        let stale = false;
        try {
          const [wavStat, wordsStat] = await Promise.all([
            stat(wavPath).catch(() => null),
            stat(path),
          ]);
          if (wavStat && wavStat.mtimeMs > wordsStat.mtimeMs) stale = true;
        } catch {
          /* fall through to read path */
        }
        if (!stale) {
          try {
            const raw = await readFile(path, "utf8");
            const parsed = JSON.parse(raw) as WordsFile;
            if (parsed.version === WORDS_FILE_VERSION && Array.isArray(parsed.words)) {
              stats.hits++;
              return parsed.words;
            }
            // Wrong version → fall through to a fresh align (overwrites on success).
          } catch {
            // Corrupt file → fall through; the fresh align overwrites it.
          }
        }
      }
      stats.misses++;
      const { substituted, substitutions } = applyLexiconWithMap(
        originalText,
        config.lexicon.entries,
        { ipaSupported: config.lexicon.ipaSupported },
      );
      const wav = await writeTempWav(audio, tmpDir);
      try {
        const tokens = await config.aligner.align(
          wav.path,
          substituted,
          config.language ? { language: config.language } : undefined,
        );
        const located = findTokenOffsetsInSubstituted(substituted, tokens);
        stats.totalTokens += tokens.length;
        stats.unlocatedTokens += tokens.length - located.length;
        // Project each token's substituted offsets back to the original text,
        // applying the §8 collapse rule via projectSubstitutedPosToOriginal.
        // A token whose start AND end fall inside the same substitution
        // produces a single [originalStart, originalEnd] span (the whole
        // displayed grapheme). A token straddling a boundary takes the union
        // of the two endpoint projections.
        const words: CachedWord[] = [];
        for (const tok of located) {
          const startSpan = projectSubstitutedPosToOriginal(
            tok.substitutedStart,
            substitutions,
            originalText.length,
          );
          const endSpan = projectSubstitutedPosToOriginal(
            tok.substitutedEnd,
            substitutions,
            originalText.length,
          );
          const s = Math.min(startSpan.start, endSpan.start);
          const e = Math.max(startSpan.end, endSpan.end);
          // Tokens that project to a zero-width range (e.g. the aligner
          // emitted padding/silence the substitution map collapsed away)
          // would be invisible in the drawer — drop them rather than emit
          // dead entries.
          if (e <= s) continue;
          words.push({
            s,
            e,
            t: tok.startMs,
            d: asMs(Math.max(0, tok.endMs - tok.startMs)),
          });
        }
        // §8 collapse can produce consecutive duplicates (e.g. four spoken
        // words inside one substitution all project to the same [s, e]).
        // Merge them into one entry spanning the full duration.
        const merged: CachedWord[] = [];
        for (const w of words) {
          const prev = merged[merged.length - 1];
          if (prev && prev.s === w.s && prev.e === w.e) {
            prev.d = asMs(Math.max(0, w.t + w.d - prev.t));
            continue;
          }
          merged.push(w);
        }
        await mkdir(bucket, { recursive: true });
        const payload: WordsFile = { version: WORDS_FILE_VERSION, words: merged };
        await writeFile(path, JSON.stringify(payload));
        return merged;
      } finally {
        await wav.cleanup();
      }
    },
  };
}
