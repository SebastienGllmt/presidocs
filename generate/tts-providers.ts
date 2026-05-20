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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
// MOSS supports neither PLS nor a words/min rate, so both are warned-and-
// ignored like the `say` adapter does for PLS.

const MOSS_MODEL_ID = "OpenMOSS-Team/MOSS-TTS-Local-Transformer";

type MossRequest = { text: string; out: string };
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
  if (lexicon) {
    console.warn(
      `  · moss: ignoring PLS lexicon from ${lexicon.sources.join(", ")} (MOSS has no PLS support)`,
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
  const workerScript = join(import.meta.dir, "moss_worker.py");
  const device = process.env.MOSS_TTS_DEVICE; // optional; worker auto-detects

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

  // Resample MOSS's native-rate output to the pipeline's working rate. Only
  // called when the rates differ (see doSynthesize) — matching rates skip
  // this entirely and pass the worker's WAV through untouched. Temp-file
  // round-trip (not a pipe) so the WAV header carries correct RIFF/data sizes
  // for the downstream byte-splice concat.
  async function resampleToWorkingFormat(srcPath: string): Promise<Uint8Array> {
    const outPath = join(
      process.env.TMPDIR ?? "/tmp",
      `presidocs-moss-rs-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
    );
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
  function synthesize(text: string): Promise<Uint8Array> {
    const result = tail.then(() => doSynthesize(text));
    tail = result.catch(() => {});
    return result;
  }

  async function doSynthesize(text: string): Promise<Uint8Array> {
    const w = await ensureWorker();
    // MOSS can't synthesize empty input; mirror `say`'s minimal-utterance
    // fallback so blank segments still yield a valid (tiny) WAV.
    const spoken = text.trim().length === 0 ? "..." : text;
    const rawPath = join(
      process.env.TMPDIR ?? "/tmp",
      `presidocs-moss-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
    );
    try {
      const req: MossRequest = { text: spoken, out: rawPath };
      w.stdin.write(JSON.stringify(req) + "\n");
      await w.stdin.flush();
      const res = await w.readResponse();
      if (!res.ok) {
        throw new Error(`moss synthesis failed: ${res.error ?? "unknown error"}`);
      }
      // Lossless fast path: when MOSS already emits the working rate (and it's
      // mono 16-bit, which the worker always writes), its WAV needs no
      // conversion — concat byte-splices it directly. Only a rate mismatch
      // forces the ffmpeg resample.
      if (w.nativeSampleRate === format.sampleRate) {
        return new Uint8Array(await Bun.file(rawPath).arrayBuffer());
      }
      return await resampleToWorkingFormat(rawPath);
    } finally {
      await rm(rawPath, { force: true });
    }
  }

  return {
    name: "moss",
    outputFormat: format,
    // python is an absolute interpreter path (not a PATH command), so it's
    // validated in the factory above rather than via the preflight's
    // Bun.which on `requiredBinaries`. We only declare the PATH binary we
    // shell out to here (ffmpeg, for the resample).
    requiredBinaries: ["ffmpeg"],
    synthesize,
  };
}

// Registry keyed by --tts flag value. New providers register here; the
// bootstrap looks up the factory by name and constructs with the shared
// `TtsProviderConfig`.
export const ttsProviders: Record<string, TtsProviderFactory> = {
  say: createSayProvider,
  moss: createMossProvider,
};
