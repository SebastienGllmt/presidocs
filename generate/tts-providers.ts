// TtsProvider: turns text into speech audio. The only piece of the generator
// that changes when swapping engines — `say` on macOS today, likely
// Piper/espeak-ng on Linux dev machines, a cloud engine (ElevenLabs, Google
// Cloud TTS, …) in production. Everything downstream (concat, trim, MP3
// encode) operates on the provider's output bytes via `AudioPipeline`, so
// providers compose with pipelines orthogonally.
//
// Providers MUST emit WAV bytes in their declared `outputFormat`; the
// bootstrap asserts this matches `pipeline.workingFormat` before any
// synthesis runs. A provider whose engine natively returns MP3/AAC must
// decode upstream (e.g. spawn ffmpeg in `synthesize`) — the rest of the
// pipeline is PCM-aware and won't do that work for it.
//
// Adding a new provider is "implement `TtsProvider`, add one map entry in
// `ttsProviders`" — no other call sites change.

import { $ } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type AudioFormat } from "./audio-pipeline.ts";

export interface PlsLexicon {
  // Where the lexemes came from, in merge order. Used for log messages and
  // any provider-side caching. Entries are file paths
  // (e.g. "posts/common-terms.pls") or virtual labels like
  // "inline:<htmlPath>#<n>" for inline blocks.
  sources: string[];
  // Merged PLS XML — one `<lexicon>` root holding every `<lexeme>` from
  // every source. We do not parse further here: providers that consume the
  // lexicon parse on demand (or hand the bytes to their engine's
  // pronunciation-dictionary API), and providers that ignore it pay no
  // parsing cost.
  xml: string;
}

export interface TtsProviderConfig {
  // Voice and rate are provider-specific strings/numbers — the registry
  // doesn't validate them. `say` reads voice names from `say -v ?`; cloud
  // engines have their own ids.
  voice: string;
  rate: number;
  // The audio format the caller wants on `synthesize`'s output. Providers
  // that can't honor the request should fail in their factory, not at
  // synth-time partway through a long post.
  format: AudioFormat;
  // Pronunciation lexicon, if any. Loaded uniformly upstream; providers
  // that don't honor PLS receive it and either ignore (with a warning) or
  // refuse construction.
  lexicon?: PlsLexicon;
}

export interface TtsProvider {
  // Logged at preflight and used in error messages. Identifies the engine,
  // not the voice (those are config).
  readonly name: string;
  // Provider's actual output format. The bootstrap asserts this matches
  // the audio pipeline's working format before any synthesis runs.
  readonly outputFormat: AudioFormat;
  // Binaries this provider needs on PATH (e.g. ["say"] for the macOS
  // adapter, [] for a pure-HTTP cloud adapter). Unioned with the pipeline's
  // binaries at preflight.
  readonly requiredBinaries: readonly string[];
  // Synthesize one segment into a WAV buffer matching `outputFormat`. The
  // caller does not filter empty/whitespace input — providers must still
  // return a valid (possibly minimal-silent) WAV in that case.
  synthesize(text: string): Promise<Uint8Array>;
}

export type TtsProviderFactory = (config: TtsProviderConfig) => TtsProvider;

// macOS `say` adapter. Plumbs PLS via config because the loader is uniform
// across providers, but ignores the lexicon at synth time — `say` has no
// PLS support, and we'd rather warn loudly than silently mispronounce.
export function createSayProvider(config: TtsProviderConfig): TtsProvider {
  const { format, voice, rate, lexicon } = config;
  if (lexicon) {
    console.warn(
      `  · say: ignoring PLS lexicon from ${lexicon.sources.join(", ")} (\`say\` has no PLS support)`,
    );
  }
  // `say` accepts `LEI16@<rate>` to force little-endian int16 PCM at the
  // given sample rate. We pin the format from config so the pipeline's
  // format assertion catches any mismatch up-front rather than after 30
  // segments of synthesis at the wrong rate.
  if (format.bitsPerSample !== 16 || format.channels !== 1) {
    throw new Error(
      `createSayProvider: only mono 16-bit PCM is supported (got ${format.channels}ch ${format.bitsPerSample}-bit)`,
    );
  }
  const dataFormat = `LEI16@${format.sampleRate}`;
  return {
    name: "say",
    outputFormat: format,
    requiredBinaries: ["say"],
    async synthesize(text) {
      // `say` can't write to stdout, so we round-trip through a tmp file.
      const spoken = text.trim().length === 0 ? "..." : text;
      const tmpPath = join(
        process.env.TMPDIR ?? "/tmp",
        `read-demo-say-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
      );
      try {
        await $`say --voice=${voice} --rate=${rate} --output-file=${tmpPath} --file-format=WAVE --data-format=${dataFormat} ${spoken}`.quiet();
        return new Uint8Array(await Bun.file(tmpPath).arrayBuffer());
      } finally {
        await rm(tmpPath, { force: true });
      }
    },
  };
}

// Registry keyed by --tts flag value. New providers register here; the
// bootstrap looks up the factory by name and constructs with the shared
// `TtsProviderConfig`.
export const ttsProviders: Record<string, TtsProviderFactory> = {
  say: createSayProvider,
};
