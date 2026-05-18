// Segment-level disk cache for TTS synthesis. Editing one sentence in a
// post should invalidate one segment, not the whole chapter — and not the
// whole post. The cache key is a sha256 over every input that influences
// the synthesized bytes: provider name, voice, rate, output format, full
// merged PLS lexicon, and the segment text itself. Anything not in the
// key is assumed not to affect output.
//
// The cache lives at `generated/.tts-cache/<hash>.wav` and is shared
// across posts. That's intentional: `common-terms.pls` makes a lot of
// segments (e.g. boilerplate sentences using shared technical terms)
// reusable across posts, and segments are addressed purely by content.
// `generate/clean.ts` only touches `generated/<slug>/`, so it never
// wipes the cache.

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
  // The merged lexicon XML, or null if no lexicon is in effect. Goes into
  // the key in full: changing a single `<lexeme>` must invalidate every
  // segment, because we can't cheaply tell which segments used which
  // grapheme. Coarse but correct, and the lexicon is small (KBs).
  lexiconXml: string | null;
}

export interface TtsCacheConfig {
  cacheDir: string;
  identity: TtsCacheIdentity;
}

export interface CachedTtsProvider extends TtsProvider {
  readonly stats: TtsCacheStats;
}

// Bump when the key encoding changes in a backwards-incompatible way
// (e.g. adding a new identity field). Old cache entries become unreachable
// but aren't deleted — they age out naturally if the user prunes the dir.
const KEY_VERSION = "v1";

export function computeCacheKey(identity: TtsCacheIdentity, text: string): string {
  // Explicit field order keeps the hash stable across JS engines that
  // might re-order object keys. JSON.stringify handles escaping for the
  // free-form `voice`, `lexiconXml`, and `text` strings.
  const canonical = {
    version: KEY_VERSION,
    providerName: identity.providerName,
    voice: identity.voice,
    rate: identity.rate,
    sampleRate: identity.format.sampleRate,
    channels: identity.format.channels,
    bitsPerSample: identity.format.bitsPerSample,
    lexiconXml: identity.lexiconXml,
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
