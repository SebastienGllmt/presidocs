// Sound-test: the dev-only "pronunciation audition" surface.
//
// The cross-post lexicon (`posts/common-terms.pls`) is where an author tunes a
// respelling until MOSS reads a technical term correctly (see methodology.md,
// "Representing word pronunciation"). MOSS is probabilistic and PLS is honored
// by *substitution*, so the only way to know a respelling works is to HEAR it.
// This module is the shared contract between the two pieces that make that
// possible without re-rendering a whole post:
//   - the offline CLI (`generate/sound-test.ts`) that synthesizes one WAV per
//     lexeme into `generated/.sound-test/`, and
//   - the dev endpoint (`server/dev/soundTest.dev.ts`) that lists the lexemes and
//     decides which already have audio.
// Both must agree on (a) what text gets synthesized for a lexeme and (b) the
// content-addressed filename that text+voice maps to — so they live here once.
//
// Why a SEPARATE store from the post TTS cache. The post cache deliberately
// EXCLUDES `common-terms.pls` from its key (editing one shared entry must not
// invalidate every post's audio — see methodology.md "Audio caching"). That is
// exactly the wrong behavior here: the whole point of the sound test is that
// editing a respelling DOES change its audio. So we don't reuse that cache; we
// synthesize the already-substituted text directly and address it by a hash
// that includes that text — so an edited alias maps to a new filename, the old
// file is "stale," and regeneration is automatic. Living under the `.`-prefixed
// `generated/.sound-test/` also keeps it clear of `clean.ts` (which skips hidden
// dirs) and of `copy-static`'s prod glob.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AudioFormat } from "../generate/audio-pipeline.ts";
import type { LexEntry } from "../generate/pronunciation.ts";

// Directory (under the content repo's `generated/`) holding the per-lexeme WAVs.
// `.`-prefixed so `clean.ts` never reaps it and it isn't shipped to prod.
export const SOUND_TEST_DIR = ".sound-test";

// Identity of the voice the audio was synthesized with — everything besides the
// spoken text that influences the bytes. Mirrors the post TTS cache key's
// non-text fields, so two voices (or formats) never collide on one filename.
export type SoundTestVoice = {
  providerName: string; // e.g. "moss"
  voiceId: string; // machine-independent voice id (MOSS: a clip content hash)
  format: AudioFormat;
};

// The exact text handed to the TTS engine for a lexeme. We feed the engine the
// ALREADY-SUBSTITUTED pronunciation (the alias, or IPA wrapped in `/.../`),
// rather than the grapheme + a lexicon, for two reasons: it's byte-identical to
// what the engine sees in production after `applyLexicon` substitutes a
// standalone term, and it makes the audio's identity track the respelling (edit
// the alias → different synth text → different file). Returns null for an entry
// with no usable pronunciation for this engine (e.g. IPA-only on a non-IPA
// engine), which the caller surfaces as "nothing to audition."
export function synthTextFor(entry: LexEntry, ipaSupported: boolean): string | null {
  if (ipaSupported && entry.ipa) return `/${entry.ipa}/`;
  if (entry.alias) return entry.alias;
  return null;
}

// Machine-independent id for a MOSS reference clip: a content hash of the clip,
// identical to the one `createMossProvider` puts in the post TTS cache key (so
// the same clip yields the same id wherever it lives on disk). Computed by
// reading the (small) clip file — no model load — so the dev server can derive
// the expected filename without spawning Python.
export function mossVoiceId(referencePath: string): string {
  return "moss-clip:" + createHash("sha256").update(readFileSync(referencePath)).digest("hex");
}

// Content-addressed filename (sans directory) for a lexeme's audio. Hashes the
// voice identity together with the synth text, so any change to either lands on
// a new name — the same cache-busting contract the post pipeline uses for
// `full.<hash>.mp3`. WAV (not MP3): browsers play it directly and we skip a
// lossy re-encode for a one-word clip.
export function audioFileName(voice: SoundTestVoice, synthText: string): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        voice.providerName,
        voice.voiceId,
        voice.format.sampleRate,
        voice.format.channels,
        voice.format.bitsPerSample,
        synthText,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hash}.wav`;
}
