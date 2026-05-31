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
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  type AudioFormat,
  trailingArtifactTrimMs,
  truncateToMs,
} from "./audio-pipeline.ts";
import { parseLexicon, applyLexicon, type LexEntry } from "./pronunciation.ts";

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

// Cross-segment prosody context, passed alongside each segment's text so an
// expressive engine can avoid restarting every sentence with "top-of-
// paragraph" energy (see methodology.md, "Cross-segment continuity"). It's a
// provider-AGNOSTIC concept:
// each provider uses whatever subset it supports and ignores the rest, the
// same way `say` ignores a PLS lexicon. Engines vary —
//   - `continuesPrevious`: the universal signal (false at a paragraph/topic
//     boundary). MOSS turns it into a delivery `instruction`; a flat synth
//     like `say` ignores it (no seam to smooth).
//   - `previousText` / `previousAudio`: richer context for engines that
//     condition on the prior turn's text or acoustics (e.g. MOSS multi-turn
//     generation). Carried here so adopting that is a provider-only change.
//
// CRUCIALLY this never enters the TTS cache key (see tts-cache.ts): it's
// best-effort conditioning, not identity. A segment is conditioned on its
// neighbor as it exists at synth time, but is NOT re-synthesized when that
// neighbor later drifts — production edits are line-level, so a slightly
// stale neighbor is "close enough" (same tradeoff the cache already makes by
// excluding `common-terms.pls`). `rm -rf generated/.tts-cache` re-conditions
// everything cleanly when wanted.
export interface SegmentContext {
  continuesPrevious: boolean;
  previousText?: string;
  previousAudio?: Uint8Array;
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
  // A MACHINE-INDEPENDENT identifier for the voice, used in the TTS cache key
  // in place of the raw `voice` config. The default (`voice` itself) is right
  // when the voice is a stable name (`say`'s "Samantha"). It's WRONG when the
  // voice is a per-machine filesystem path (MOSS's reference clip), because
  // the absolute path would bust the cache on every other machine — so MOSS
  // overrides this with a content hash of the clip (same clip → same audio →
  // same key, wherever it lives). Omit to fall back to `voice`.
  readonly cacheVoiceId?: string;
  // Synthesize one segment into a WAV buffer matching `outputFormat`. The
  // caller does not filter empty/whitespace input — providers must still
  // return a valid (possibly minimal-silent) WAV in that case. `context` is
  // optional cross-segment prosody info; providers ignore what they can't use.
  synthesize(text: string, context?: SegmentContext): Promise<Uint8Array>;
  // Release any long-lived resources once the run is done. Providers that hold
  // a persistent child process (e.g. MOSS's worker) MUST implement this — an
  // open worker keeps Bun's event loop alive, so `generate` would otherwise
  // hang after its final log line. Stateless providers (`say`) omit it.
  close?(): Promise<void> | void;
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
        `presidocs-say-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
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

// espeak-ng adapter (Linux / cross-platform). The cheap, fast iteration engine
// on machines without macOS `say` — it fills the exact role `say` plays on a
// Mac. Like `say` it's a stateless CLI synth with no pronunciation-dictionary
// support, so it warns-and-ignores any PLS lexicon (the cache keys on the
// provider name, so an espeak-ng draft and a MOSS render never collide). Unlike
// `say`, espeak-ng is NOT preinstalled, so the preflight points at the install
// command when the binary is missing (see generate.ts `installHint`).
//
// espeak-ng's native output is mono 16-bit PCM at a fixed 22050 Hz (the rate of
// its voices), which already equals the default working format — so the common
// path is a lossless pass-through with no ffmpeg in the loop. Only a non-22050
// working rate triggers a resample (the same "sample-rate matching is the
// provider's problem" rule MOSS follows); ffmpeg is guaranteed on PATH there
// because the MP3 pipeline already requires it. `--rate` maps straight onto
// espeak-ng's `-s` words/min knob, so unlike MOSS there's nothing to warn about.
const ESPEAK_NG_NATIVE_RATE = 22050;

export function createEspeakNgProvider(config: TtsProviderConfig): TtsProvider {
  const { format, voice, rate, lexicon } = config;
  if (lexicon) {
    console.warn(
      `  · espeak-ng: ignoring PLS lexicon from ${lexicon.sources.join(", ")} (\`espeak-ng\` has no PLS support)`,
    );
  }
  if (format.bitsPerSample !== 16 || format.channels !== 1) {
    throw new Error(
      `createEspeakNgProvider: only mono 16-bit PCM is supported (got ${format.channels}ch ${format.bitsPerSample}-bit)`,
    );
  }

  const tmpWav = () =>
    join(
      process.env.TMPDIR ?? "/tmp",
      `presidocs-espeak-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
    );

  // Bring espeak-ng's fixed 22050 Hz output to the working rate. Only invoked on
  // a mismatch (matching rates pass through untouched); temp-file round-trip so
  // the WAV header carries correct RIFF / data-chunk sizes for the byte-splice
  // concat downstream (the same reason MOSS's resample avoids a pipe).
  async function resampleToWorkingFormat(srcPath: string): Promise<Uint8Array> {
    const outPath = tmpWav();
    try {
      await $`ffmpeg -hide_banner -loglevel error -i ${srcPath} -ac ${format.channels} -ar ${format.sampleRate} -c:a pcm_s16le -y ${outPath}`.quiet();
      return new Uint8Array(await Bun.file(outPath).arrayBuffer());
    } finally {
      await rm(outPath, { force: true });
    }
  }

  return {
    name: "espeak-ng",
    outputFormat: format,
    requiredBinaries: ["espeak-ng"],
    async synthesize(text) {
      // espeak-ng can't synthesize empty input; mirror `say`'s minimal-utterance
      // fallback so blank segments still yield a valid (tiny) WAV.
      const spoken = text.trim().length === 0 ? "..." : text;
      const rawPath = tmpWav();
      try {
        // `-w` writes a seekable WAV (correct RIFF/data sizes, unlike `--stdout`);
        // `--` ends flag parsing so narration text beginning with `-` is read as
        // text, not mistaken for an option.
        await $`espeak-ng -v ${voice} -s ${rate} -w ${rawPath} -- ${spoken}`.quiet();
        return format.sampleRate === ESPEAK_NG_NATIVE_RATE
          ? new Uint8Array(await Bun.file(rawPath).arrayBuffer())
          : await resampleToWorkingFormat(rawPath);
      } finally {
        await rm(rawPath, { force: true });
      }
    },
  };
}

// --- MOSS-TTS adapter --------------------------------------------------------
//
// Production voice via the OpenMOSS MOSS-TTS model (voice cloning from a
// reference clip). Two facts shape this adapter:
//
//   1. Model load is expensive (~seconds for a 1.7B transformer). A fresh
//      `python` per segment would reload it every sentence, so we run a
//      LONG-LIVED worker (generate/moss_worker.py): spawn once, load once,
//      serve one segment per request over a stdin/stdout JSON-line protocol.
//      The worker boots lazily on the first `synthesize` — because the cache
//      wrapper only calls us on a miss, a fully-cached rebuild never even
//      starts Python.
//
//   2. MOSS emits mono 16-bit PCM at a fixed native rate (24000 Hz), while the
//      pipeline's working rate is configurable (22050 Hz today). A PCM/WAV
//      stream carries ONE sample rate in its header, so concat (a byte-splice
//      under a single header) can't mix rates — every segment must already be
//      at the working rate. When MOSS's native rate matches the working rate
//      we therefore pass its WAV through untouched (lossless); only a mismatch
//      triggers an ffmpeg resample (the provider-contract "decode upstream"
//      step). That resample round-trips through a temp file rather than piping
//      ffmpeg's stdout, because the WAV muxer can't fix up RIFF / data-chunk
//      sizes on a non-seekable pipe and `concatWavs` reads those. Set the
//      working rate to 24000 to make the production path resample-free.
//
// The MOSS repo lives outside this project (its own venv), so it's located
// via the MOSS_TTS_DIR env var — there's no portable default path. The
// `voice` config is repurposed as the path to the voice-clone reference clip
// (it already feeds the cache key, so two reference clips cache separately).
//
// PLS: MOSS has no native PLS API, but it reads whatever text we hand it, so
// we honor the lexicon by SUBSTITUTION — rewriting each matched grapheme to
// its pronunciation before synthesis (see generate/pronunciation.ts). MOSS is
// IPA-capable (it accepts phoneme sequences wrapped in `/.../`), so an entry's
// <phoneme> wins over its <alias> here; engines that aren't (`say`) still warn-
// and-ignore. The rate knob has no MOSS equivalent and is still warned-ignored.

const MOSS_MODEL_ID = "OpenMOSS-Team/MOSS-TTS-Local-Transformer";

// Delivery hint handed to MOSS for a segment that continues the previous one
// (the default `instruction` continuation mode; see methodology.md). MOSS's
// `instruction` field is free-text natural language, and a listening lesson
// is baked in here: a blunt, natural phrasing far outperformed elaborate
// directions — an earlier wordy "even, conversational tone" was rendered as a
// too-soft, trailing-in first word. Keep it simple.
const MOSS_CONTINUATION_INSTRUCTION =
  "Talk like you're continuing from an existing paragraph";

type MossRequest = {
  text: string;
  out: string;
  instruction?: string; // `instruction` mode: delivery hint
  prev_text?: string; // `acoustic` mode: prior segment's text
  prev_audio?: string; // `acoustic` mode: path to prior segment's WAV (acoustic context)
};
type MossResponse = {
  ready?: boolean;
  samplingRate?: number; // worker's native output rate, sent with `ready`
  ok?: boolean;
  error?: string;
};

// Reads a child's stdout as a stream of newline-delimited JSON objects,
// handing them out one-per-call in FIFO order. Used to pair each request we
// write to the worker with its single response line. If the stream closes
// (worker died), pending and future reads reject with a clear error.
function jsonLineReader(stream: ReadableStream<Uint8Array>) {
  const queued: MossResponse[] = [];
  const waiters: { resolve: (v: MossResponse) => void; reject: (e: Error) => void }[] = [];
  let closed: Error | null = null;
  (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const obj = JSON.parse(line) as MossResponse;
          const w = waiters.shift();
          if (w) w.resolve(obj);
          else queued.push(obj);
        }
      }
      closed = new Error("MOSS worker stdout closed (process exited)");
    } catch (err) {
      closed = err instanceof Error ? err : new Error(String(err));
    }
    while (waiters.length) waiters.shift()!.reject(closed!);
  })();
  return () =>
    new Promise<MossResponse>((resolve, reject) => {
      const q = queued.shift();
      if (q) resolve(q);
      else if (closed) reject(closed);
      else waiters.push({ resolve, reject });
    });
}

// MOSS's processor decodes the reference clip (and torchaudio in general)
// through torchcodec, which dlopen's the system FFmpeg shared libraries at
// runtime. Those libs aren't on a venv python's default loader path, so
// torchcodec fails to load even when a compatible FFmpeg is installed. We
// fix that for the worker subprocess by adding FFmpeg's lib dir to the
// platform's dynamic-loader search path. The dir is derived from the
// `ffmpeg` CLI location (`<prefix>/bin/ffmpeg` → `<prefix>/lib`, which is the
// Homebrew/most-unix layout) and overridable via MOSS_TTS_FFMPEG_LIB for
// nonstandard installs.
function mossWorkerEnv(): Record<string, string | undefined> {
  const explicit = process.env.MOSS_TTS_FFMPEG_LIB;
  const ffmpegBin = Bun.which("ffmpeg");
  const libDir = explicit ?? (ffmpegBin ? join(dirname(dirname(ffmpegBin)), "lib") : null);
  if (!libDir) return process.env;
  const loaderVar =
    process.platform === "darwin" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const existing = process.env[loaderVar];
  return {
    ...process.env,
    [loaderVar]: existing ? `${libDir}:${existing}` : libDir,
  };
}

export function createMossProvider(config: TtsProviderConfig): TtsProvider {
  const { format, voice, rate, lexicon } = config;
  // Parse the lexicon once at construction. Unlike `say`, MOSS consumes it: we
  // rewrite matched graphemes to their pronunciation in each segment's text
  // (and in the prior-segment text fed back in `acoustic` mode, so the two
  // stay consistent). MOSS is IPA-capable, so prefer <phoneme> over <alias>.
  const lexEntries: LexEntry[] = lexicon ? parseLexicon(lexicon.xml) : [];
  // ipaSupported is FALSE for the local MOSS model: empirically it does NOT
  // interpret `/.../` IPA — it reads the slashes literally ("slash"). IPA
  // appears to be a flagship/larger-MOSS feature (same story as acoustic
  // continuity). So MOSS uses the `<alias>` respelling and ignores `<phoneme>`.
  // Flip to true (or make env-configurable) only if wired to a MOSS model that
  // genuinely renders IPA.
  const pronounce = (text: string): string =>
    applyLexicon(text, lexEntries, { ipaSupported: false });
  if (lexEntries.length > 0) {
    console.log(
      `  · moss: applying ${lexEntries.length} pronunciation entr${lexEntries.length === 1 ? "y" : "ies"} from ${lexicon!.sources.join(", ")} via text substitution`,
    );
  }
  // MOSS clones tone/cadence from the reference clip; words/min isn't a knob.
  // We surface this so a leftover `--rate` from a `say` run isn't mistaken
  // for a no-op that's silently changing nothing (it does change the cache
  // key, though, so we don't drop it from identity).
  if (rate !== 180) {
    console.warn(`  · moss: ignoring --rate=${rate} (MOSS has no words/min control)`);
  }
  if (format.bitsPerSample !== 16 || format.channels !== 1) {
    throw new Error(
      `createMossProvider: only mono 16-bit PCM is supported (got ${format.channels}ch ${format.bitsPerSample}-bit)`,
    );
  }

  // Locate the external MOSS repo + its venv python. No portable default —
  // fail fast in the factory (not 30 segments into a run) with a fixable
  // message rather than spawning a missing interpreter later.
  const mossDir = process.env.MOSS_TTS_DIR;
  if (!mossDir) {
    throw new Error(
      "createMossProvider: set MOSS_TTS_DIR to your MOSS-TTS checkout " +
        "(e.g. MOSS_TTS_DIR=/path/to/MOSS-TTS bun run generate ... --tts=moss).",
    );
  }
  const python = process.env.MOSS_TTS_PYTHON ?? join(mossDir, ".venv", "bin", "python");
  if (!existsSync(python)) {
    throw new Error(
      `createMossProvider: MOSS python interpreter not found at ${python}. ` +
        `Set MOSS_TTS_PYTHON to override, or create the venv in MOSS_TTS_DIR.`,
    );
  }
  // The reference clip is carried in `voice`. The default ("Samantha") is a
  // `say` voice name and meaningless here, so a missing/placeholder value
  // gets a pointed message.
  const reference = voice;
  if (!reference.toLowerCase().endsWith(".wav") || !existsSync(reference)) {
    throw new Error(
      `createMossProvider: --voice must be a path to a voice-clone reference .wav ` +
        `(got ${JSON.stringify(reference)}). Pass e.g. --voice=/path/to/my_voice.wav.`,
    );
  }
  // Content-hash the reference clip for the cache identity (see `cacheVoiceId`
  // on TtsProvider). The synthesized audio depends on the clip's CONTENTS, not
  // its filesystem path — and the path is per-machine (it lives outside the
  // repo, under MOSS_TTS_DIR), so keying the cache on it would miss on every
  // other machine and cache the same clip twice if it ever moved. Read once at
  // construction; reference clips are small.
  const cacheVoiceId =
    "moss-clip:" + createHash("sha256").update(readFileSync(reference)).digest("hex");
  const workerScript = join(import.meta.dir, "moss_worker.py");
  const device = process.env.MOSS_TTS_DEVICE; // optional; worker auto-detects

  // How to use cross-segment continuity (see methodology.md). Default
  // `instruction`: a continuation gets a delivery hint — a single-shot
  // generation, the best-sounding option on the local 1.7B model.
  //   - `acoustic`: feed the prior segment's actual audio as multi-turn
  //     context. Strongest in theory, but on the 1.7B model it badly degrades
  //     quality (it conditions on its own resampled, trimmed output, so
  //     artifacts compound across a chapter, plus repeated words and tone
  //     drift). Kept opt-in for experimentation on a larger model.
  //   - `off`: ignore continuity entirely — every segment a fresh utterance
  //     (the pre-continuity baseline).
  const continuationMode = process.env.MOSS_TTS_CONTINUATION ?? "instruction";
  if (!["instruction", "acoustic", "off"].includes(continuationMode)) {
    throw new Error(
      `createMossProvider: MOSS_TTS_CONTINUATION must be instruction|acoustic|off (got ${JSON.stringify(continuationMode)}).`,
    );
  }

  // Lazily-spawned worker. `null` until the first synth; started at most once.
  type Worker = {
    proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
    stdin: Bun.FileSink;
    readResponse: () => Promise<MossResponse>;
    // MOSS's native output rate (from the ready handshake). When it already
    // equals the working rate we hand the worker's WAV straight to concat —
    // no resample, no quality loss. The ffmpeg resample only runs when the
    // rates genuinely differ.
    nativeSampleRate: number;
  };
  let worker: Worker | null = null;
  let starting: Promise<Worker> | null = null;

  async function startWorker(): Promise<Worker> {
    const cmd = [
      python,
      workerScript,
      "--model",
      MOSS_MODEL_ID,
      "--reference",
      reference,
      ...(device ? ["--device", device] : []),
    ];
    const proc = Bun.spawn({
      cmd,
      cwd: mossDir, // run from the MOSS repo so its trust_remote_code modules resolve
      env: mossWorkerEnv(), // put FFmpeg's libs on the loader path for torchcodec
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // model-load progress + errors stream to the terminal
    });
    // Don't let the live worker keep the build process alive past its work,
    // and make sure it dies with us rather than leaking a loaded model.
    proc.unref();
    process.once("exit", () => proc.kill());
    const readResponse = jsonLineReader(proc.stdout);
    console.log(`  · moss: loading model ${MOSS_MODEL_ID} (first segment only)…`);
    const ready = await readResponse();
    if (!ready.ready || typeof ready.samplingRate !== "number") {
      throw new Error(`moss worker: expected ready handshake, got ${JSON.stringify(ready)}`);
    }
    return {
      proc,
      stdin: proc.stdin,
      readResponse,
      nativeSampleRate: ready.samplingRate,
    };
  }

  async function ensureWorker(): Promise<Worker> {
    if (worker) return worker;
    if (!starting) starting = startWorker().then((w) => (worker = w));
    return starting;
  }

  const tmpWav = (label: string) =>
    join(
      process.env.TMPDIR ?? "/tmp",
      `presidocs-${label}-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
    );

  // Resample MOSS's native-rate output to the pipeline's working rate. Only
  // called when the rates differ (see doSynthesize) — matching rates skip
  // this entirely and pass the worker's WAV through untouched. Temp-file
  // round-trip (not a pipe) so the WAV header carries correct RIFF/data sizes
  // for the downstream byte-splice concat.
  async function resampleToWorkingFormat(srcPath: string): Promise<Uint8Array> {
    const outPath = tmpWav("moss-rs");
    try {
      await $`ffmpeg -hide_banner -loglevel error -i ${srcPath} -ac ${format.channels} -ar ${format.sampleRate} -c:a pcm_s16le -y ${outPath}`.quiet();
      return new Uint8Array(await Bun.file(outPath).arrayBuffer());
    } finally {
      await rm(outPath, { force: true });
    }
  }

  // Serialize requests: one model, one stdin/stdout channel, one in-flight
  // generation at a time. Chaining onto a tail promise turns concurrent
  // `synthesize` calls into a FIFO queue (today's caller is already serial,
  // but this keeps us correct if that changes).
  let tail: Promise<unknown> = Promise.resolve();
  function synthesize(text: string, context?: SegmentContext): Promise<Uint8Array> {
    const result = tail.then(() => doSynthesize(text, context));
    tail = result.catch(() => {});
    return result;
  }

  async function doSynthesize(text: string, context?: SegmentContext): Promise<Uint8Array> {
    const w = await ensureWorker();
    // Apply the pronunciation lexicon (no-op when none) before anything else,
    // so the empty-input check and the worker both see the substituted text.
    const pronounced = pronounce(text);
    // MOSS can't synthesize empty input; mirror `say`'s minimal-utterance
    // fallback so blank segments still yield a valid (tiny) WAV.
    const spoken = pronounced.trim().length === 0 ? "..." : pronounced;
    const rawPath = tmpWav("moss");
    // How a continuation is rendered depends on `continuationMode` (see the
    // factory). `off` ignores context; `instruction` adds a delivery hint
    // (single-shot, the default); `acoustic` feeds the prior audio as
    // multi-turn context (opt-in, larger-model territory).
    const continues = !!context?.continuesPrevious && continuationMode !== "off";
    const useAcoustic = continues && continuationMode === "acoustic" && !!context!.previousAudio;
    const prevAudioPath = useAcoustic ? tmpWav("moss-prev") : null;
    try {
      if (prevAudioPath) await Bun.write(prevAudioPath, context!.previousAudio!);
      const req: MossRequest = {
        text: spoken,
        out: rawPath,
        // Instruction for `instruction` mode (and as the fallback if
        // `acoustic` is selected but no prior audio is available).
        instruction: continues && !useAcoustic ? MOSS_CONTINUATION_INSTRUCTION : undefined,
        // Substitute the prior text too: in `acoustic` mode the prev audio was
        // synthesized from the substituted form, so the paired text must match.
        prev_text: useAcoustic ? pronounce(context!.previousText ?? "") : undefined,
        prev_audio: prevAudioPath ?? undefined,
      };
      w.stdin.write(JSON.stringify(req) + "\n");
      await w.stdin.flush();
      const res = await w.readResponse();
      if (!res.ok) {
        throw new Error(`moss synthesis failed: ${res.error ?? "unknown error"}`);
      }
      // Bring the worker's WAV to the working format. Lossless fast path: when
      // MOSS already emits the working rate (and it's mono 16-bit, which the
      // worker always writes), concat can byte-splice it directly — only a
      // rate mismatch forces the ffmpeg resample.
      const working =
        w.nativeSampleRate === format.sampleRate
          ? new Uint8Array(await Bun.file(rawPath).arrayBuffer())
          : await resampleToWorkingFormat(rawPath);
      // Drop MOSS's trailing garbage-audio blip (see trailingArtifactTrimMs).
      // Done per segment so the click doesn't land at every concat seam, not
      // just the end of the post.
      const keepMs = await trailingArtifactTrimMs(working, format);
      return keepMs === null ? working : await truncateToMs(working, keepMs);
    } finally {
      await rm(rawPath, { force: true });
      if (prevAudioPath) await rm(prevAudioPath, { force: true });
    }
  }

  // Shut the worker down so the build process can exit. The worker is a
  // long-lived Python child whose stdout we read in a never-ending loop
  // (jsonLineReader); that pending read keeps Bun's event loop alive, so
  // without this `generate` hangs forever after writing its output (the
  // benign "leaked semaphore" warning is torch's own shutdown noise). Closing
  // stdin signals EOF to the worker's read loop; the kill is a backstop in
  // case torch's teardown is slow. Idempotent and safe if the worker never
  // started (a fully-cached or `--mock` run never spawns it).
  async function close() {
    const w = worker;
    worker = null;
    starting = null;
    if (!w) return;
    try {
      w.stdin.end();
    } catch {}
    try {
      w.proc.kill();
    } catch {}
    try {
      await w.proc.exited;
    } catch {}
  }

  return {
    name: "moss",
    outputFormat: format,
    // python is an absolute interpreter path (not a PATH command), so it's
    // validated in the factory above rather than via the preflight's
    // Bun.which on `requiredBinaries`. We only declare the PATH binary we
    // shell out to here (ffmpeg, for the resample).
    requiredBinaries: ["ffmpeg"],
    cacheVoiceId,
    synthesize,
    close,
  };
}

// Registry keyed by --tts flag value. New providers register here; the
// bootstrap looks up the factory by name and constructs with the shared
// `TtsProviderConfig`.
export const ttsProviders: Record<string, TtsProviderFactory> = {
  say: createSayProvider,
  "espeak-ng": createEspeakNgProvider,
  moss: createMossProvider,
};
