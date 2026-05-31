// Tests for the segment-level alignment cache. Uses a MOCK aligner that
// returns canned token output, so the suite runs without Qwen3 / Python.
// The cache's contract is what matters here:
//   - hit/miss bookkeeping
//   - co-location with the TTS cache on disk
//   - backfill (WAV cached but words.json missing)
//   - force-realign (overwrites stale words.json after a TTS re-roll)
//   - PLS-substitution back-projection (proposals/17 §8)

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapWithAlignmentCache } from "./aligner-cache.ts";
import { computeTextHash, computeCacheKey } from "./tts-cache.ts";
import { asMs, type Milliseconds } from "../shared/time.ts";
import { parseLexicon } from "./pronunciation.ts";
import type { AlignedToken, ForcedAligner, AlignOptions } from "./aligner.ts";

const monoFmt = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };
const ttsIdentity = {
  providerName: "mock-tts",
  voice: "test",
  rate: 180,
  format: monoFmt,
  localLexiconXml: null,
};

// Mock aligner: returns whatever tokens the test pre-registered, counts how
// many times it was invoked, and records the (audioPath, text) it received.
function makeMockAligner(tokens: AlignedToken[]): ForcedAligner & {
  calls: { audioPath: string; text: string; language: string | undefined }[];
} {
  const calls: { audioPath: string; text: string; language: string | undefined }[] = [];
  return {
    name: "mock-aligner",
    requiredBinaries: [],
    calls,
    async align(audioPath: string, text: string, opts?: AlignOptions) {
      calls.push({ audioPath, text, language: opts?.language });
      return tokens;
    },
  };
}

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "align-cache-"));
}

function fakeAudio(): Uint8Array {
  // A tiny non-empty buffer — the mock aligner doesn't actually read the WAV,
  // we just want SOMETHING for the cache to spill to disk.
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);
}

test("alignment cache: miss writes words.json; hit reads it without invoking the aligner", async () => {
  const cacheDir = freshCacheDir();
  const aligner = makeMockAligner([
    { text: "Hash", startMs: asMs(0), endMs: asMs(300) },
    { text: "functions", startMs: asMs(300), endMs: asMs(700) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  const text = "Hash functions.";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);

  const first = await cached.align(textHash, fullHash, text, fakeAudio());
  expect(cached.stats).toMatchObject({ hits: 0, misses: 1, totalTokens: 2, unlocatedTokens: 0 });
  expect(aligner.calls).toHaveLength(1);
  expect(first).toEqual([
    { s: 0, e: 4, t: asMs(0), d: asMs(300) },
    { s: 5, e: 14, t: asMs(300), d: asMs(400) },
  ]);
  // Words file exists at the expected co-located path.
  const wordsPath = join(cacheDir, textHash, `${fullHash}.words.json`);
  expect(existsSync(wordsPath)).toBe(true);

  const second = await cached.align(textHash, fullHash, text, fakeAudio());
  expect(cached.stats).toMatchObject({ hits: 1, misses: 1 });
  expect(aligner.calls).toHaveLength(1); // unchanged — hit didn't invoke
  expect(second).toEqual(first);
});

test("alignment cache: sibling .wav newer than .words.json triggers a fresh align (stale guard)", async () => {
  // Simulates the bug we want to prevent: a previous run produced both
  // <hash>.wav and <hash>.words.json; then a later run with
  // --force-mark=X but WITHOUT --align=qwen3 overwrote <hash>.wav. The
  // .words.json now describes audio that no longer exists at this hash.
  // Without the mtime guard, the next --align run would serve stale words.
  const cacheDir = freshCacheDir();
  const text = "stale guard";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  const bucket = join(cacheDir, textHash);
  mkdirSync(bucket, { recursive: true });
  // Prime: write a words.json with an mtime in the past.
  const wordsPath = join(bucket, `${fullHash}.words.json`);
  writeFileSync(wordsPath, JSON.stringify({ version: 1, words: [{ s: 0, e: 5, t: 0, d: 100 }] }));
  const pastSec = Math.floor(Date.now() / 1000) - 3600;
  utimesSync(wordsPath, pastSec, pastSec);
  // Now write the sibling .wav with a NEWER mtime (simulating an overwrite).
  const wavPath = join(bucket, `${fullHash}.wav`);
  writeFileSync(wavPath, "fresh wav bytes");
  // (writeFileSync uses now() for mtime, which is > pastSec.)

  const aligner = makeMockAligner([
    { text: "stale", startMs: asMs(0), endMs: asMs(200) },
    { text: "guard", startMs: asMs(200), endMs: asMs(400) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  const out = await cached.align(textHash, fullHash, text, fakeAudio());
  expect(aligner.calls).toHaveLength(1); // re-aligned despite words.json present
  expect(cached.stats).toMatchObject({ hits: 0, misses: 1 });
  expect(out).toHaveLength(2);
});

test("alignment cache: sibling .wav older than .words.json is a hit (normal case)", async () => {
  // Same setup as above but with the timestamps inverted — the words.json
  // is newer than the .wav, which is the normal post-build state (both
  // were written within the same run, and the words.json is written
  // strictly after the .wav). Must be a hit.
  const cacheDir = freshCacheDir();
  const text = "fresh words";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  const bucket = join(cacheDir, textHash);
  mkdirSync(bucket, { recursive: true });
  const wavPath = join(bucket, `${fullHash}.wav`);
  writeFileSync(wavPath, "wav bytes");
  const pastSec = Math.floor(Date.now() / 1000) - 3600;
  utimesSync(wavPath, pastSec, pastSec);
  // Words.json written "now" — newer than the WAV.
  const wordsPath = join(bucket, `${fullHash}.words.json`);
  writeFileSync(wordsPath, JSON.stringify({ version: 1, words: [{ s: 0, e: 5, t: 0, d: 100 }] }));

  const aligner = makeMockAligner([{ text: "x", startMs: asMs(0), endMs: asMs(10) }]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  await cached.align(textHash, fullHash, text, fakeAudio());
  expect(aligner.calls).toHaveLength(0); // hit — aligner never invoked
  expect(cached.stats).toMatchObject({ hits: 1, misses: 0 });
});

test("alignment cache: backfill — WAV bucket exists, words.json missing → fresh align", async () => {
  const cacheDir = freshCacheDir();
  const text = "backfill scenario";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  // Simulate a TTS-only bucket: the .wav exists but no words.json.
  mkdirSync(join(cacheDir, textHash), { recursive: true });
  // (We don't actually write a .wav — the cache only consults the .words.json.)
  const aligner = makeMockAligner([{ text: "backfill", startMs: asMs(0), endMs: asMs(500) }]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  const out = await cached.align(textHash, fullHash, text, fakeAudio());
  expect(cached.stats).toMatchObject({ hits: 0, misses: 1 });
  expect(out).toHaveLength(1);
});

test("alignment cache: forceRealign overwrites a stale words.json even on hit", async () => {
  const cacheDir = freshCacheDir();
  const text = "force me";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  const aligner = makeMockAligner([{ text: "force", startMs: asMs(0), endMs: asMs(100) }]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
    forceRealign: (t) => t === text,
  });
  // Prime the cache.
  await cached.align(textHash, fullHash, text, fakeAudio());
  expect(aligner.calls).toHaveLength(1);
  // Second call with forceRealign matching → must invoke aligner again.
  await cached.align(textHash, fullHash, text, fakeAudio());
  expect(aligner.calls).toHaveLength(2);
  expect(cached.stats).toMatchObject({ hits: 0, misses: 2 });
});

test("alignment cache: corrupt words.json falls through to fresh align", async () => {
  const cacheDir = freshCacheDir();
  const text = "corrupt me";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  mkdirSync(join(cacheDir, textHash), { recursive: true });
  // Write garbage where the cache expects valid JSON.
  await Bun.write(join(cacheDir, textHash, `${fullHash}.words.json`), "}{ not json");
  const aligner = makeMockAligner([{ text: "corrupt", startMs: asMs(0), endMs: asMs(100) }]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  const out = await cached.align(textHash, fullHash, text, fakeAudio());
  expect(out).toHaveLength(1);
  expect(cached.stats).toMatchObject({ hits: 0, misses: 1 });
});

test("alignment cache: PLS substitution projects timing back to ORIGINAL-text offsets", async () => {
  // "SHA-256" → "sha two fifty six" via PLS. The aligner sees the substituted
  // text and returns one token per spoken word; the cache must project them
  // back to the original-text offset [0, 7) (the "SHA-256" span) and collapse
  // the four duplicates into one entry spanning the full duration.
  const cacheDir = freshCacheDir();
  const lexiconXml =
    "<lexicon><lexeme><grapheme>SHA-256</grapheme><alias>sha two fifty six</alias></lexeme></lexicon>";
  const entries = parseLexicon(lexiconXml);
  const aligner = makeMockAligner([
    { text: "sha", startMs: asMs(0), endMs: asMs(200) },
    { text: "two", startMs: asMs(200), endMs: asMs(400) },
    { text: "fifty", startMs: asMs(400), endMs: asMs(700) },
    { text: "six", startMs: asMs(700), endMs: asMs(1000) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries, ipaSupported: false },
  });
  const original = "SHA-256";
  const out = await cached.align(
    computeTextHash(original),
    computeCacheKey(ttsIdentity, original),
    original,
    fakeAudio(),
  );
  // §8 collapse: four spoken words → one displayed entry covering [0, 7).
  expect(out).toEqual([{ s: 0, e: 7, t: asMs(0), d: asMs(1000) }]);
  // And the aligner saw the SUBSTITUTED text, not the original.
  expect(aligner.calls[0]!.text).toBe("sha two fifty six");
});

test("alignment cache: mixed identity+substitution preserves identity-word offsets", async () => {
  // "Use SHA-256 here" → "Use sha two fifty six here" — "Use" and "here" map
  // identity; "SHA-256" collapses; offsets in the original are [0,3), [4,11),
  // [12,16).
  const cacheDir = freshCacheDir();
  const lexiconXml =
    "<lexicon><lexeme><grapheme>SHA-256</grapheme><alias>sha two fifty six</alias></lexeme></lexicon>";
  const entries = parseLexicon(lexiconXml);
  const aligner = makeMockAligner([
    { text: "Use", startMs: asMs(0), endMs: asMs(200) },
    { text: "sha", startMs: asMs(200), endMs: asMs(400) },
    { text: "two", startMs: asMs(400), endMs: asMs(600) },
    { text: "fifty", startMs: asMs(600), endMs: asMs(900) },
    { text: "six", startMs: asMs(900), endMs: asMs(1200) },
    { text: "here", startMs: asMs(1200), endMs: asMs(1500) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries, ipaSupported: false },
  });
  const original = "Use SHA-256 here";
  const out = await cached.align(
    computeTextHash(original),
    computeCacheKey(ttsIdentity, original),
    original,
    fakeAudio(),
  );
  expect(out).toEqual([
    { s: 0, e: 3, t: asMs(0), d: asMs(200) },
    { s: 4, e: 11, t: asMs(200), d: asMs(1000) }, // SHA-256 collapsed, 200→1200
    { s: 12, e: 16, t: asMs(1200), d: asMs(300) },
  ]);
});

test("alignment cache: persisted file shape carries version + words", async () => {
  const cacheDir = freshCacheDir();
  const text = "hello world";
  const textHash = computeTextHash(text);
  const fullHash = computeCacheKey(ttsIdentity, text);
  const aligner = makeMockAligner([
    { text: "hello", startMs: asMs(0), endMs: asMs(300) },
    { text: "world", startMs: asMs(300), endMs: asMs(700) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  await cached.align(textHash, fullHash, text, fakeAudio());
  const raw = readFileSync(join(cacheDir, textHash, `${fullHash}.words.json`), "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.version).toBe(1);
  expect(parsed.words).toHaveLength(2);
  expect(parsed.words[0]).toMatchObject({ s: 0, e: 5, t: 0 });
});

test("alignment cache: language option is forwarded to the aligner", async () => {
  const cacheDir = freshCacheDir();
  const aligner = makeMockAligner([{ text: "x", startMs: asMs(0), endMs: asMs(10) }]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    language: "Spanish",
    lexicon: { entries: [], ipaSupported: false },
  });
  await cached.align(computeTextHash("x"), computeCacheKey(ttsIdentity, "x"), "x", fakeAudio());
  expect(aligner.calls[0]!.language).toBe("Spanish");
});

test("alignment cache: unlocated tokens are counted but not emitted", async () => {
  // The aligner returns a token whose text doesn't appear in the substituted
  // text at all. findTokenOffsetsInSubstituted drops it; the cache should
  // report the drop via stats.unlocatedTokens.
  const cacheDir = freshCacheDir();
  const aligner = makeMockAligner([
    { text: "hello", startMs: asMs(0), endMs: asMs(300) },
    { text: "🚀nope🚀", startMs: asMs(300), endMs: asMs(400) }, // not in source text
    { text: "world", startMs: asMs(400), endMs: asMs(800) },
  ]);
  const cached = wrapWithAlignmentCache({
    cacheDir,
    aligner,
    lexicon: { entries: [], ipaSupported: false },
  });
  const text = "hello world";
  const out = await cached.align(
    computeTextHash(text),
    computeCacheKey(ttsIdentity, text),
    text,
    fakeAudio(),
  );
  expect(out).toHaveLength(2); // the rocket-token was dropped
  expect(cached.stats.unlocatedTokens).toBe(1);
  expect(cached.stats.totalTokens).toBe(3); // all three counted, even the dropped one
});
