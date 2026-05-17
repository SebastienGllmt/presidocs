// Extracts the inline narration script from a blog post HTML file, splits
// each chunk at <mark name="..."/> boundaries, synthesizes one WAV per
// segment via a pluggable TTS provider, concatenates segments into one
// master track, and emits a manifest with absolute mark timings.
//
// Usage:
//   bun run scripts/generate.ts posts/hash-functions.html
//   bun run scripts/generate.ts posts/hash-functions.html --voice="Samantha"
//   bun run scripts/generate.ts posts/hash-functions.html --bitrate=96k
//   bun run scripts/generate.ts posts/hash-functions.html --tts=say
//   bun run scripts/generate.ts posts/hash-functions.html --mock     # silent audio
//
// Delivers MP3 @ 64 kbps mono. Requires `ffmpeg` on PATH plus whichever
// binaries the selected TTS provider needs (the preflight fails fast with
// a clear message if any are missing).
//
// TTS provider is selected by `--tts=NAME` (default: `say`, macOS-only).
// Register new providers in the `ttsProviders` map (see "TTS abstraction").
//
// PLS pronunciation lexicons (PronunciationLexicon-spec.html) come from
// two optional sources, both merged into one lexicon at build time:
//   - `posts/common-terms.pls` (shared cross-post terms)
//   - inline `<script type="application/pls+xml">` blocks in the post
//     (post-specific terms; preserves the "one file per post" constraint)
// The merged result is passed to every provider; providers that don't
// honor PLS warn and ignore (the `say` adapter does this).
//
// The `--mock` flag is for environments without a TTS — it generates silent
// audio of estimated duration so the player can still be demoed end-to-end.

import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const argv = Bun.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (const arg of argv) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else flags.set(arg.slice(2), "true");
  } else {
    positional.push(arg);
  }
}

const htmlPath = positional[0];
if (!htmlPath) {
  console.error("usage: bun run scripts/generate.ts <post.html> [--tts=say] [--voice=Samantha] [--mock]");
  process.exit(1);
}

const mock = flags.has("mock");
const voice = flags.get("voice") ?? "Samantha";
const rate = Number(flags.get("rate") ?? "180"); // words/min for `say`
const sampleRate = 22050;
const channels = 1;
const bitsPerSample = 16;

const mp3Bitrate = flags.get("bitrate") ?? "64k";

const html = await Bun.file(htmlPath).text();
const slug = basename(htmlPath).replace(/\.html?$/i, "");
const projectRoot = resolve(dirname(htmlPath), "..");
const outDir = join(projectRoot, "generated", slug);
await mkdir(outDir, { recursive: true });

// --- 1. Extract inline blocks (narration + PLS) ------------------------------
//
// HTMLRewriter (Bun built-in, lol-html under the hood) is a proper streaming
// HTML parser. Regex on HTML is unsound — comments that wrap a `<script>`,
// `>` inside attribute values, mismatched quoting, etc. all defeat naive
// patterns. With HTMLRewriter we walk the parse tree by CSS selector and
// collect the raw text content per matching element.
//
// `<script>` content is treated as RAWTEXT by the HTML parser: tags inside
// are NOT parsed and entities are NOT decoded. That's what we want — the
// narration and PLS payloads come out byte-identical to what the author
// wrote (modulo streaming chunk boundaries, which we re-join).
//
// Two block types share this single pass:
//   - `text/narration` — the spoken-script chunks, one per chapter
//   - `application/pls+xml` — inline pronunciation lexicon (optional, zero
//     or more blocks; concatenated and merged with `common-terms.pls` at
//     bootstrap)

type NarrationChunk = { id: string; title: string; content: string };

const chunks: NarrationChunk[] = [];
const inlinePlsBlocks: string[] = [];
let anonCount = 0;
let pendingChunk: { id: string; title: string; buf: string[] } | null = null;
let pendingPlsBuf: string[] | null = null;

new HTMLRewriter()
  .on('script[type="text/narration"]', {
    element(el) {
      const id =
        el.getAttribute("data-chunk-id") ??
        el.getAttribute("id") ??
        `chunk-${anonCount++}`;
      const title = el.getAttribute("data-chunk-title") ?? id;
      // HTMLRewriter walks the tree in document order and serializes script
      // elements one at a time, so a single shared `pending` is safe.
      pendingChunk = { id, title, buf: [] };
      el.onEndTag(() => {
        if (pendingChunk) {
          chunks.push({
            id: pendingChunk.id,
            title: pendingChunk.title,
            content: pendingChunk.buf.join(""),
          });
          pendingChunk = null;
        }
      });
    },
    text(t) {
      pendingChunk?.buf.push(t.text);
    },
  })
  .on('script[type="application/pls+xml"]', {
    element(el) {
      pendingPlsBuf = [];
      el.onEndTag(() => {
        if (pendingPlsBuf) {
          inlinePlsBlocks.push(pendingPlsBuf.join(""));
          pendingPlsBuf = null;
        }
      });
    },
    text(t) {
      pendingPlsBuf?.push(t.text);
    },
  })
  .transform(html);

if (chunks.length === 0) {
  console.error(`No <script type="text/narration"> blocks found in ${htmlPath}`);
  process.exit(1);
}

console.log(`Found ${chunks.length} narration chunk(s) in ${htmlPath}`);
if (inlinePlsBlocks.length > 0) {
  console.log(`Found ${inlinePlsBlocks.length} inline PLS block(s) in ${htmlPath}`);
}

// --- 2. Split each chunk at <mark> -------------------------------------------
//
// The in-chunk format is plain text plus `<mark name="..."/>` boundaries —
// no `<speak>` wrapper, no nested tags, no namespace. So we do not need an
// XML parser; a single regex over `<mark name=...>` (self-closing or with
// an explicit close tag, single or double quotes) gives the boundary
// positions, and everything between two boundaries is the segment's text.
//
// Entities are intentionally NOT decoded: HTMLRewriter hands us script
// content byte-for-byte (RAWTEXT semantics), and the authoring format is
// plain prose — `&` means `&`, not `&amp;`. A literal `<` mid-prose is
// fine because the regex only matches `<mark ...>`, not arbitrary tags.

type Segment = { markName: string | null; text: string };

const markRegex = /<mark\s+name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\/?\s*>(?:\s*<\/mark\s*>)?/g;

function splitChunk(content: string): Segment[] {
  const out: Segment[] = [];
  let currentMark: string | null = null;
  let lastEnd = 0;

  const push = (rawText: string) => {
    const text = normalizeWhitespace(rawText);
    if (currentMark !== null || text) {
      out.push({ markName: currentMark, text });
    }
  };

  for (const match of content.matchAll(markRegex)) {
    push(content.slice(lastEnd, match.index));
    currentMark = match[1] ?? match[2] ?? null;
    lastEnd = match.index + match[0].length;
  }
  push(content.slice(lastEnd));

  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// --- 3. TTS abstraction ------------------------------------------------------
//
// A `TtsProvider` turns text into speech audio. It is the only piece of the
// generator that should change when swapping engines — `say` on macOS today,
// likely Piper/espeak-ng on Linux dev machines, a cloud engine (ElevenLabs,
// Google Cloud TTS, …) in production. Everything downstream (concat, trim,
// MP3 encode) operates on the provider's output bytes via `AudioPipeline`,
// so providers compose with pipelines orthogonally.
//
// Providers MUST emit WAV bytes in their declared `outputFormat`; the
// pipeline asserts that this matches `pipeline.workingFormat` before any
// synthesis runs. A provider whose engine natively returns MP3/AAC must
// decode upstream (e.g. spawn ffmpeg in `synthesize`) — the rest of the
// pipeline is PCM-aware and won't do that work for it.

interface AudioFormat {
  // Signed linear PCM is assumed throughout.
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

interface PlsLexicon {
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

interface TtsProviderConfig {
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

interface TtsProvider {
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

type TtsProviderFactory = (config: TtsProviderConfig) => TtsProvider;

// macOS `say` adapter. Plumbs PLS via config because the loader is uniform
// across providers, but ignores the lexicon at synth time — `say` has no
// PLS support, and we'd rather warn loudly than silently mispronounce.
function createSayProvider(config: TtsProviderConfig): TtsProvider {
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
// `TtsProviderConfig`. Adding a Piper or ElevenLabs adapter is "implement
// `TtsProvider`, add one map entry" — no other call sites change.
const ttsProviders: Record<string, TtsProviderFactory> = {
  say: createSayProvider,
};

// --- 4. Audio pipeline -------------------------------------------------------
//
// The pipeline encapsulates everything the generator does with audio data
// *after* synthesis — concat, trim, duration, final-mile encode — so adding
// a new delivery format (Opus, AAC, FLAC) is one struct, not a scatter of
// conditionals across the loop. The pipeline is orthogonal to the TTS
// provider; they're composed at the bootstrap.
//
// Working representation throughout the pipeline is mono 16-bit PCM @ 22050
// Hz wrapped in WAV. We keep that across segments and chunks because:
//   - lossless concat is byte-splicing PCM (no re-encode loss accumulates)
//   - the leading-silence trim reads raw samples
//   - duration is exact from the WAV header
// Final-mile encoding to a delivered format happens in `encode()` — for WAV
// that's the identity function; for MP3 it's a single ffmpeg call.
//
// A future backend that wanted to keep its own codec internally (and skip
// the WAV → delivery final step) would have to implement every operation
// on its own buffers — not silently drop them. The interface is what makes
// the codec swap safe.
interface AudioPipeline {
  // Format the pipeline expects on every buffer it consumes/produces (until
  // `encode`). TTS providers must emit audio in this format.
  workingFormat: AudioFormat;
  // Working-format extension, used only for any tmp files written to disk.
  workingExt: string;
  // Delivered-format extension and MIME — shown to the browser.
  deliveryExt: string;
  deliveryMime: string;
  // Binaries this pipeline needs on PATH (e.g. ffmpeg for MP3 encode).
  // Unioned with the TTS provider's binaries at preflight.
  requiredBinaries: readonly string[];

  // Generate silence of the given duration in the working format. Used by
  // --mock and (eventually) for explicit pauses between marks.
  silence(durationSec: number): Uint8Array;
  // Precise duration of a working-format buffer.
  duration(buf: Uint8Array): number;
  // Splice working-format buffers into one with identical playback. MUST
  // be lossless w.r.t. the audio samples — no re-encode.
  concat(bufs: Uint8Array[]): Uint8Array;
  // Detect leading silence and return its length in *samples* (the caller
  // converts to seconds via `workingFormat.sampleRate` and shifts mark
  // times accordingly). Returns 0 if no significant silence.
  leadingSilenceSamples(buf: Uint8Array): number;
  // Drop `samples` leading audio samples and return the result.
  trim(buf: Uint8Array, samples: number): Uint8Array;
  // Final-mile encode for delivery (e.g. WAV → MP3). A future lossless-
  // delivery backend could make this the identity function.
  encode(workingBuf: Uint8Array): Promise<Uint8Array>;
}

// --- 5. WAV helpers (working-format implementation) --------------------------

// WAV header layout: 12-byte RIFF preamble, then chunks (fmt, data, ...).
// We don't assume the data chunk lives at byte 44 — `say` sometimes emits
// extra metadata chunks before it.
function findChunkRanges(buf: Uint8Array) {
  if (
    buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46 // "RIFF"
  ) {
    throw new Error("Not a RIFF file");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let fmt: { offset: number; size: number } | null = null;
  let data: { offset: number; size: number } | null = null;
  while (pos + 8 <= buf.byteLength) {
    // Bounds-safe: the loop condition above guarantees pos+3 is in range.
    const id =
      String.fromCharCode(buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!);
    const size = view.getUint32(pos + 4, true);
    if (id === "fmt ") fmt = { offset: pos + 8, size };
    else if (id === "data") {
      data = { offset: pos + 8, size };
      break; // we don't need anything past the data chunk
    }
    // Subchunks are word-aligned per RIFF spec.
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  return { fmt, data, view };
}

function wavDurationSeconds(buf: Uint8Array): number {
  const { fmt, data, view } = findChunkRanges(buf);
  const numChannels = view.getUint16(fmt.offset + 2, true);
  const sr = view.getUint32(fmt.offset + 4, true);
  const bps = view.getUint16(fmt.offset + 14, true);
  return data.size / (sr * numChannels * (bps / 8));
}

function buildSilentWav(durationSec: number): Uint8Array {
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const dataSize = numSamples * bytesPerSample;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  // RIFF header
  out.set([0x52, 0x49, 0x46, 0x46], 0);          // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);          // "WAVE"
  // fmt chunk
  out.set([0x66, 0x6d, 0x74, 0x20], 12);         // "fmt "
  view.setUint32(16, 16, true);                  // PCM fmt size
  view.setUint16(20, 1, true);                   // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  out.set([0x64, 0x61, 0x74, 0x61], 36);         // "data"
  view.setUint32(40, dataSize, true);
  // remainder is zero-initialized → silence
  return out;
}

// Build one canonical-headed WAV from any number of input WAVs that share the
// same PCM format (mono 16-bit @ sampleRate, which is what `say` emits below).
function concatWavs(inputs: Uint8Array[]): Uint8Array {
  if (inputs.length === 0) return buildSilentWav(0);
  const datas = inputs.map((b) => {
    const { data } = findChunkRanges(b);
    return b.subarray(data.offset, data.offset + data.size);
  });
  const totalData = datas.reduce((n, d) => n + d.byteLength, 0);
  const out = new Uint8Array(44 + totalData);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + totalData, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, totalData, true);
  let offset = 44;
  for (const d of datas) {
    out.set(d, offset);
    offset += d.byteLength;
  }
  return out;
}

// `say` opens each segment with dead silence followed by a 50–150ms ramp
// up into the first phoneme. Without trimming, seeking to a chapter
// boundary lands in that silence and the listener hears nothing for a beat
// before the first word. We trim leading samples until energy crosses a
// threshold for two consecutive 20ms windows — the consecutive check
// avoids stopping inside a non-monotonic attack (e.g. the "S" in "So"
// briefly spikes above threshold, dips, then climbs).
//
// Threshold ~2000 (with mid-speech around 5000–7000) catches the first
// audible syllable without clipping its leading consonant. Aggressive
// thresholds (4000+) cut soft fricatives like the "S" of "So" entirely;
// gentler ones (1000-) leave noticeable silence before the first sound.
function findLeadingSilenceSamples(wavBuf: Uint8Array): number {
  const { data } = findChunkRanges(wavBuf);
  const numSamples = data.size / 2; // assumes mono 16-bit PCM (bitsPerSample)
  const dv = new DataView(wavBuf.buffer, wavBuf.byteOffset + data.offset, data.size);
  const windowSize = Math.floor(sampleRate * 0.02); // 20ms
  const rmsThreshold = 2000;

  let prevAbove = false;
  for (let w = 0; w + windowSize <= numSamples; w += windowSize) {
    let sumSq = 0;
    for (let i = 0; i < windowSize; i++) {
      const s = dv.getInt16((w + i) * 2, true);
      sumSq += s * s;
    }
    const above = Math.sqrt(sumSq / windowSize) > rmsThreshold;
    if (above && prevAbove) return w - windowSize;
    prevAbove = above;
  }
  return 0;
}

// Drop `samples` leading PCM samples and rewrite the WAV header to match.
function trimLeadingSamples(wavBuf: Uint8Array, samples: number): Uint8Array {
  if (samples <= 0) return wavBuf;
  const { data } = findChunkRanges(wavBuf);
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const trimBytes = samples * bytesPerSample;
  const newDataSize = data.size - trimBytes;
  const out = new Uint8Array(44 + newDataSize);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + newDataSize, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, newDataSize, true);
  out.set(wavBuf.subarray(data.offset + trimBytes, data.offset + data.size), 44);
  return out;
}

// --- 6. Delivery encoders ----------------------------------------------------

// MP3 encoder via ffmpeg. Stream-in / stream-out so we never touch disk for
// the intermediate WAV — important because the working buffers can be tens
// of megabytes for long posts.
//
// MP3 encoding adds a small lookahead/padding (~26ms at the head, ~36ms at
// the tail) per the format spec. Modern decoders honor the LAME tag we
// emit and play gaplessly; the residual sub-30ms offset is well below
// perception thresholds at podcast-scale durations.
async function wavToMp3Ffmpeg(wavBuf: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "wav",
      "-i", "pipe:0",
      "-codec:a", "libmp3lame",
      "-b:a", mp3Bitrate,
      "-ac", String(channels),
      "-ar", String(sampleRate),
      "-f", "mp3",
      "pipe:1",
    ],
    // Bun copies a Blob into the child's stdin and closes the pipe on EOF.
    stdin: new Blob([wavBuf]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [outBytes, errText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}:\n${errText}`);
  }
  return new Uint8Array(outBytes);
}

// --- 7. Bootstrap: pipeline + TTS provider + preflight -----------------------

const workingFormat: AudioFormat = { sampleRate, channels, bitsPerSample };

const pipeline: AudioPipeline = {
  workingFormat,
  workingExt: ".wav",
  deliveryExt: ".mp3",
  deliveryMime: "audio/mpeg",
  requiredBinaries: ["ffmpeg"],
  silence: buildSilentWav,
  duration: wavDurationSeconds,
  concat: concatWavs,
  leadingSilenceSamples: findLeadingSilenceSamples,
  trim: trimLeadingSamples,
  encode: wavToMp3Ffmpeg,
};

// TTS provider selection. `--tts=NAME` picks the factory; default is `say`
// (macOS). New engines plug in by registering a factory in `ttsProviders`.
const ttsName = flags.get("tts") ?? "say";
const ttsFactory = ttsProviders[ttsName];
if (!ttsFactory) {
  console.error(
    `Unknown --tts=${ttsName}. Available: ${Object.keys(ttsProviders).join(", ")}`,
  );
  process.exit(1);
}

// PLS lexicon assembly. Two sources, both optional:
//   - posts/common-terms.pls — shared cross-post pronunciations (SHA-256,
//     PostgreSQL, …). Lives next to the posts so it's discoverable; merged
//     into every post's lexicon at build time.
//   - inline `<script type="application/pls+xml">` blocks in the post —
//     post-specific terms. Preserves the "one file per post" constraint
//     for pronunciations unique to that post.
// The merged result is one synthetic PLS document (one `<lexicon>` root
// holding all `<lexeme>`s). Order: common-terms first, then inline — so a
// PLS engine that picks the last match per grapheme lets a post override
// a common-terms entry.
const sharedPlsPath = join(dirname(htmlPath), "common-terms.pls");
type PlsSource = { label: string; xml: string };
const plsSources: PlsSource[] = [];
if (await Bun.file(sharedPlsPath).exists()) {
  plsSources.push({
    label: sharedPlsPath,
    xml: await Bun.file(sharedPlsPath).text(),
  });
}
inlinePlsBlocks.forEach((xml, i) => {
  plsSources.push({ label: `inline:${htmlPath}#${i}`, xml });
});

const lexemeBodyRegex = /<lexicon\b[^>]*>([\s\S]*?)<\/lexicon\s*>/;
function mergeLexicons(sources: PlsSource[]): PlsLexicon {
  // Slice each source's `<lexicon>...</lexicon>` body verbatim and stitch
  // them under one fresh root. Comments and whitespace ride along — they
  // don't affect runtime behavior and preserving them keeps the merged
  // output debuggable.
  const bodies = sources.map((s) => {
    const m = lexemeBodyRegex.exec(s.xml);
    if (!m) {
      console.error(`${s.label}: no <lexicon>...</lexicon> root found`);
      process.exit(1);
    }
    return `<!-- from ${s.label} -->${m[1]}`;
  });
  return {
    sources: sources.map((s) => s.label),
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" xml:lang="en-US">\n` +
      bodies.join("\n") +
      `\n</lexicon>\n`,
  };
}

const lexicon: PlsLexicon | undefined =
  plsSources.length > 0 ? mergeLexicons(plsSources) : undefined;
if (lexicon) {
  console.log(`Loaded PLS lexicon from: ${lexicon.sources.join(", ")}`);
}

const tts = ttsFactory({
  voice,
  rate,
  format: workingFormat,
  lexicon,
});

// Sanity-check that the provider's output format actually matches what the
// pipeline expects. Catching this here is much friendlier than a downstream
// WAV-header mismatch midway through synthesis.
const pf = tts.outputFormat;
const wf = pipeline.workingFormat;
if (
  pf.sampleRate !== wf.sampleRate ||
  pf.channels !== wf.channels ||
  pf.bitsPerSample !== wf.bitsPerSample
) {
  console.error(
    `TTS provider "${tts.name}" outputs ${pf.channels}ch ${pf.bitsPerSample}-bit @ ${pf.sampleRate}Hz; ` +
      `pipeline expects ${wf.channels}ch ${wf.bitsPerSample}-bit @ ${wf.sampleRate}Hz.`,
  );
  process.exit(1);
}

// Preflight: every required binary (TTS + pipeline) must exist on PATH.
// Surfacing this here is much friendlier than a cryptic failure 30 segments
// into a synthesis run.
const installHint = (bin: string): string => {
  if (bin === "ffmpeg") return `Install ffmpeg (\`brew install ffmpeg\`).`;
  if (bin === "say") return `\`say\` is macOS-only; pick a different --tts on other platforms.`;
  return `Install it and try again.`;
};
for (const bin of new Set([...tts.requiredBinaries, ...pipeline.requiredBinaries])) {
  if (!Bun.which(bin)) {
    console.error(`Required binary "${bin}" not found on PATH.\n${installHint(bin)}`);
    process.exit(1);
  }
}

console.log(`TTS: ${tts.name} (voice=${voice}, rate=${rate})`);
console.log(`Encoding MP3 @ ${mp3Bitrate} mono ${sampleRate}Hz`);

// --- 8. Process each chunk ---------------------------------------------------
//
// Per-chunk audio files are emitted alongside the full track (useful for
// cache-friendly regeneration: re-run on a single chunk and only that file
// changes). For the playback experience we also splice all chunks into one
// `full.<ext>` and emit absolute mark times + chapter ranges that match it.
//
// Working-format buffers live in memory for the whole run; only delivery-
// format bytes are written to disk.

type ChunkArtifact = {
  id: string;
  title: string;
  // Working-format buffer (lossless), kept for the final concat into `full`.
  buffer: Uint8Array;
  duration: number;
  // `text` carries the spoken text that follows each mark (up to the next
  // mark, or end of chunk). The drawer in the client renders this directly;
  // it's already plain text because the in-chunk format is plain text.
  localMarks: { name: string; time: number; text: string }[];
};

const artifacts: ChunkArtifact[] = [];

for (const chunk of chunks) {
  const segments = splitChunk(chunk.content);
  console.log(`  · ${chunk.id}: ${segments.length} segment(s)`);

  const segmentBufs: Uint8Array[] = [];
  const segmentDurations: number[] = [];

  for (const seg of segments) {
    let buf: Uint8Array;
    if (mock) {
      const wordCount = seg.text.split(/\s+/).filter(Boolean).length || 1;
      const estSec = (wordCount / rate) * 60 + 0.25;
      buf = pipeline.silence(estSec);
    } else {
      buf = await tts.synthesize(seg.text);
    }
    segmentBufs.push(buf);
    segmentDurations.push(pipeline.duration(buf));
  }

  const combined = pipeline.concat(segmentBufs);

  // Trim the leading silence so chapter seeks land on speech, not silence.
  // Everything inside the chunk shifts earlier by the trimmed duration;
  // mark 0 stays pinned to t=0 of the trimmed chunk (it now points to the
  // first phoneme rather than the silence that preceded it).
  const trimSamples = mock ? 0 : pipeline.leadingSilenceSamples(combined);
  const trimSeconds = trimSamples / pipeline.workingFormat.sampleRate;
  const trimmed = trimSamples > 0 ? pipeline.trim(combined, trimSamples) : combined;
  if (trimSeconds > 0) {
    console.log(`    trimmed ${(trimSeconds * 1000).toFixed(0)}ms of leading silence`);
  }

  // Encode + write the per-chunk delivery file. We do this even though the
  // current player loads only `full.<ext>` because the per-chunk files are
  // load-bearing for future partial-regen tooling (see methodology.md).
  const chunkDelivered = await pipeline.encode(trimmed);
  const chunkPath = join(outDir, `${chunk.id}${pipeline.deliveryExt}`);
  await Bun.write(chunkPath, chunkDelivered);

  // Compute mark times relative to the trimmed chunk's start.
  const localMarks: { name: string; time: number; text: string }[] = [];
  let t = 0;
  for (const [i, seg] of segments.entries()) {
    if (seg.markName) {
      localMarks.push({
        name: seg.markName,
        time: Math.max(0, t - trimSeconds),
        text: seg.text,
      });
    }
    t += segmentDurations[i]!;
  }

  artifacts.push({
    id: chunk.id,
    title: chunk.title,
    buffer: trimmed,
    duration: t - trimSeconds,
    localMarks,
  });
}

// Concatenate every chunk in the working (lossless) format, then encode the
// result for delivery. Doing the encode at the end (rather than per-chunk
// and concatenating MP3s) avoids the brittleness of MP3 concatenation and
// keeps cumulative encoder padding to a single occurrence per file.
const fullBuf = pipeline.concat(artifacts.map((a) => a.buffer));
const fullDelivered = await pipeline.encode(fullBuf);
const fullPath = join(outDir, `full${pipeline.deliveryExt}`);
await Bun.write(fullPath, fullDelivered);

const chapters: { id: string; title: string; startTime: number; endTime: number }[] = [];
const marks: { name: string; time: number; chapter: string; text: string }[] = [];
let offset = 0;
for (const a of artifacts) {
  const start = offset;
  const end = offset + a.duration;
  chapters.push({ id: a.id, title: a.title, startTime: round3(start), endTime: round3(end) });
  for (const m of a.localMarks) {
    marks.push({
      name: m.name,
      time: round3(start + m.time),
      chapter: a.id,
      text: m.text,
    });
  }
  offset = end;
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

const manifest = {
  slug,
  generatedAt: new Date().toISOString(),
  audio: `/generated/${slug}/full${pipeline.deliveryExt}`,
  duration: round3(offset),
  chapters,
  marks,
};
await Bun.write(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\nWrote ${chapters.length} chapter(s), ${marks.length} mark(s) to ${outDir}`);
console.log(`  full duration: ${manifest.duration.toFixed(2)}s`);
for (const c of chapters) {
  const count = marks.filter((m) => m.chapter === c.id).length;
  console.log(`  ${c.id.padEnd(14)} ${(c.endTime - c.startTime).toFixed(2)}s   ${count} mark(s)   "${c.title}"`);
}
