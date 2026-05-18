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
// The cache lives at `generated/.tts-cache/<hash>.wav` and is shared
// across posts. Segments are addressed purely by content, so two posts
// that share a sentence share the cache entry. `generate/clean.ts` only
// touches `generated/<slug>/`, so it never wipes the cache.

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
}

// Bump when the key encoding changes in a backwards-incompatible way
// (e.g. adding a new identity field, or changing what an existing field
// represents). Old cache entries become unreachable but aren't deleted —
// they age out naturally if the user prunes the dir.
//
// v2: lexicon field narrowed from "full merged lexicon" to "post-local
// lexicon only". v1 entries used a key that mixed in `common-terms.pls`
// and so are unreachable from v2 keys.
const KEY_VERSION = "v2";

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
  let dirEnsured = false;

  return {
    name: inner.name,
    outputFormat: inner.outputFormat,
    requiredBinaries: inner.requiredBinaries,
    stats,
    async synthesize(text) {
      const key = computeCacheKey(config.identity, text);
      const path = join(config.cacheDir, `${key}.wav`);
      const file = Bun.file(path);
      if (await file.exists()) {
        stats.hits++;
        return new Uint8Array(await file.arrayBuffer());
      }
      stats.misses++;
      const buf = await inner.synthesize(text);
      // Lazily create the cache dir on first miss so a fully-cached run
      // doesn't touch the filesystem unnecessarily.
      if (!dirEnsured) {
        await mkdir(config.cacheDir, { recursive: true });
        dirEnsured = true;
      }
      await Bun.write(path, buf);
      return buf;
    },
  };
}
