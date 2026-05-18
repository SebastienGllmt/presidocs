// Segment-level disk cache for TTS synthesis. Editing one sentence in a
// post should invalidate one segment, not the whole chapter — and not the
// whole post. The cache key is a sha256 over every input that influences
// the synthesized bytes: provider name, voice, rate, output format, the
// post-LOCAL PLS lexicon, and the segment text itself. Anything not in
// the key is assumed not to affect output.
//
// Why local-only and not the merged lexicon: editing a shared file like
// `posts/common-terms.pls` would otherwise invalidate every cached
// segment across every post. That's correct in the strict sense (the
// merged lexicon did change) but pathologically expensive in practice —
// the common file changes often during authoring, and most segments
// don't reference the edited grapheme. The tradeoff: after editing
// `common-terms.pls`, existing cache entries keep their old pronunciation
// until manually wiped (`rm -rf generated/.tts-cache/`). Post-local
// inline `<script type="application/pls+xml">` blocks still invalidate
// the post's segments, because that's the scope the author is actively
// iterating on.
//
// ----- Two-layer layout -----
//
// On disk the cache is nested: `generated/.tts-cache/<text-hash>/<full-hash>.wav`.
//   - `<text-hash>` = sha256(segment text). One directory per distinct
//     sentence, regardless of how it's synthesized.
//   - `<full-hash>` = sha256 of the full identity (provider, voice, rate,
//     format, local lexicon, text). One file per distinct synthesized
//     variant of that sentence.
//
// The cache lookup uses the full hash — only an exact identity match is a
// hit. The text-hash layer exists for garbage collection: it lets
// `clean.ts` ask "is this sentence still in use by some post?" without
// having to enumerate every voice/rate/lexicon combination ever generated.
//
// Each post's `cache-keys.json` records only its CURRENT text-hashes
// (overwritten on every generate, NOT unioned). A sentence removed from a
// post drops its text-hash from the index, so the next clean reaps the
// whole bucket (every voice/rate variant of that sentence) in one shot.
// Re-running with a different voice writes the same set of text-hashes
// (the text didn't change), so the old voice's audio survives the next
// clean alongside the new voice's — both are "still in use" at the
// text level.
//
// `generate/clean.ts` deletes `generated/<slug>/` and then sweeps any
// text-hash bucket no longer referenced by any post's index.

import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TtsProvider } from "./tts-providers.ts";
import type { AudioFormat } from "./audio-pipeline.ts";

export interface TtsCacheStats {
  hits: number;
  misses: number;
}

export interface TtsCacheIdentity {
  providerName: string;
  voice: string;
  rate: number;
  format: AudioFormat;
  // The post-LOCAL lexicon XML (inline `<script type="application/pls+xml">`
  // blocks merged together), or null if the post has no inline PLS.
  // Goes into the key in full: changing a single `<lexeme>` in the
  // post-local lexicon must invalidate every segment in this post,
  // because we can't cheaply tell which segments used which grapheme.
  // Cross-post shared lexicons (e.g. `common-terms.pls`) are deliberately
  // excluded — see the file header for the rationale.
  localLexiconXml: string | null;
}

export interface TtsCacheConfig {
  cacheDir: string;
  identity: TtsCacheIdentity;
}

export interface CachedTtsProvider extends TtsProvider {
  readonly stats: TtsCacheStats;
  // Every text-hash this wrapper touched. Maps 1:1 to text-hash buckets
  // on disk. The generator persists this set per-post under
  // `generated/<slug>/cache-keys.json` (overwriting, not unioning) so
  // `clean.ts` can GC entire buckets of sentences no longer used by any
  // post. Within a bucket, every voice/rate/lexicon variant survives —
  // they're all "the same sentence" from a still-in-use perspective.
  readonly textHashes: ReadonlySet<string>;
}

// Bump when the key encoding changes in a backwards-incompatible way
// (e.g. adding a new identity field, or changing what an existing field
// represents). Old cache entries become unreachable but aren't deleted —
// they age out naturally on the next `clean` run (the new layout reads
// nested `<text-hash>/<full-hash>.wav`, so flat root-level files from
// older versions never resolve and get reaped as orphans).
//
// v2: lexicon field narrowed from "full merged lexicon" to "post-local
// lexicon only". v1 entries used a key that mixed in `common-terms.pls`
// and so are unreachable from v2 keys.
// v3: disk layout changed from flat `<hash>.wav` to nested
// `<text-hash>/<full-hash>.wav` to make sentence-level GC possible.
const KEY_VERSION = "v3";

export function computeTextHash(text: string): string {
  // Just the raw segment text — no provider/voice/rate/lexicon. Same
  // sentence under different voices shares this hash, which is the whole
  // point: the GC layer asks "is this sentence still used by any post?"
  // not "is this exact audio variant still used?".
  return createHash("sha256").update(text).digest("hex");
}

export function computeCacheKey(identity: TtsCacheIdentity, text: string): string {
  // Explicit field order keeps the hash stable across JS engines that
  // might re-order object keys. JSON.stringify handles escaping for the
  // free-form `voice`, `localLexiconXml`, and `text` strings.
  const canonical = {
    version: KEY_VERSION,
    providerName: identity.providerName,
    voice: identity.voice,
    rate: identity.rate,
    sampleRate: identity.format.sampleRate,
    channels: identity.format.channels,
    bitsPerSample: identity.format.bitsPerSample,
    localLexiconXml: identity.localLexiconXml,
    text,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function wrapWithCache(
  inner: TtsProvider,
  config: TtsCacheConfig,
): CachedTtsProvider {
  const stats: TtsCacheStats = { hits: 0, misses: 0 };
  const textHashes = new Set<string>();

  return {
    name: inner.name,
    outputFormat: inner.outputFormat,
    requiredBinaries: inner.requiredBinaries,
    stats,
    textHashes,
    async synthesize(text) {
      const textHash = computeTextHash(text);
      const fullHash = computeCacheKey(config.identity, text);
      textHashes.add(textHash);
      const bucket = join(config.cacheDir, textHash);
      const path = join(bucket, `${fullHash}.wav`);
      const file = Bun.file(path);
      if (await file.exists()) {
        stats.hits++;
        return new Uint8Array(await file.arrayBuffer());
      }
      stats.misses++;
      const buf = await inner.synthesize(text);
      // mkdir with recursive is idempotent and cheap — no need to track
      // which buckets we've already ensured this run.
      await mkdir(bucket, { recursive: true });
      await Bun.write(path, buf);
      return buf;
    },
  };
}
