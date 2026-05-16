// Extracts inline SSML from a blog post HTML file, splits each chunk at
// <mark name="..."/> boundaries, synthesizes one WAV per segment with the
// macOS `say` command, concatenates segments into one master track, and
// emits a manifest with absolute mark timings.
//
// Usage:
//   bun run scripts/generate.ts posts/hash-functions.html
//   bun run scripts/generate.ts posts/hash-functions.html --voice="Samantha"
//   bun run scripts/generate.ts posts/hash-functions.html --bitrate=96k
//   bun run scripts/generate.ts posts/hash-functions.html --mock     # silent audio
//
// Delivers MP3 @ 64 kbps mono. Requires `ffmpeg` on PATH (the preflight
// check below fails fast with a clear message if missing).
//
// The `--mock` flag is for environments without `say` — it generates silent
// audio of estimated duration so the player can still be demoed end-to-end.

import { $ } from "bun";
import { XMLParser } from "fast-xml-parser";
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
  console.error("usage: bun run scripts/generate.ts <post.html> [--voice=Samantha] [--mock]");
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

// --- 1. Extract SSML chunks --------------------------------------------------
//
// HTMLRewriter (Bun built-in, lol-html under the hood) is a proper streaming
// HTML parser. Regex on HTML is unsound — comments that wrap a `<script>`,
// `>` inside attribute values, mismatched quoting, etc. all defeat naive
// patterns. With HTMLRewriter we walk the parse tree by CSS selector and
// collect the raw text content per matching element.
//
// `<script>` content is treated as RAWTEXT by the HTML parser: tags inside
// are NOT parsed and entities are NOT decoded. That's what we want — the
// SSML payload comes out byte-identical to what the author wrote (modulo
// streaming chunk boundaries, which we re-join).

type SsmlChunk = { id: string; title: string; ssml: string };

const chunks: SsmlChunk[] = [];
let anonCount = 0;
let pending: { id: string; title: string; buf: string[] } | null = null;

new HTMLRewriter()
  .on('script[type="application/ssml+xml"]', {
    element(el) {
      const id =
        el.getAttribute("data-chunk-id") ??
        el.getAttribute("id") ??
        `chunk-${anonCount++}`;
      const title = el.getAttribute("data-chunk-title") ?? id;
      // HTMLRewriter walks the tree in document order and serializes script
      // elements one at a time, so a single shared `pending` is safe.
      pending = { id, title, buf: [] };
      el.onEndTag(() => {
        if (pending) {
          chunks.push({ id: pending.id, title: pending.title, ssml: pending.buf.join("") });
          pending = null;
        }
      });
    },
    text(t) {
      pending?.buf.push(t.text);
    },
  })
  .transform(html);

if (chunks.length === 0) {
  console.error(`No <script type="application/ssml+xml"> blocks found in ${htmlPath}`);
  process.exit(1);
}

console.log(`Found ${chunks.length} SSML chunk(s) in ${htmlPath}`);

// --- 2. Split each SSML chunk at <mark> --------------------------------------
//
// fast-xml-parser walks the SSML as a real XML tree, so we get correct
// behavior on namespaces, single/double-quoted attrs, self-closing vs.
// explicit close tags, CDATA, comments, entity decoding, and arbitrary
// nesting (e.g. `<prosody>` wrapping speech).
//
// We use `preserveOrder: true` so element + text nodes come back in
// document order — essential, because the meaning of `<mark>` is "split
// the surrounding text at THIS point in time."
//
// Tree shape (with preserveOrder + ignoreAttributes:false):
//   PreservedNode =
//     | { "#text": string }
//     | { [tagName]: PreservedNode[], ":@"?: { "@_<attr>": string } }
type PreservedNode =
  | { "#text": string }
  | ({ ":@"?: Record<string, string> } & Record<string, PreservedNode[]>);

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  // Preserve whitespace inside text nodes so we can normalize at the end of
  // each segment, not partway through. (XML's `xml:space` defaults are too
  // surprising to rely on here.)
  trimValues: false,
  // We don't need PIs or comments in the output.
  commentPropName: "",
});

type Segment = { markName: string | null; text: string };

function splitSsml(ssml: string): Segment[] {
  const tree = xmlParser.parse(ssml) as PreservedNode[];
  // SSML requires `<speak>` as the document root. We enforce it here both
  // because the spec says so and because XML's single-root rule means the
  // parser silently drops everything after a sibling void element when no
  // root exists — bare-text-with-marks would produce wrong output rather
  // than wrong-but-loud output.
  const speakNode = tree.find(
    (n): n is Exclude<PreservedNode, { "#text": string }> =>
      !("#text" in n) && childTagName(n) === "speak",
  );
  if (!speakNode) {
    throw new Error("SSML chunk must be wrapped in <speak>...</speak>");
  }
  const root = (speakNode as Record<string, PreservedNode[]>)["speak"] ?? [];

  const out: Segment[] = [];
  let currentMark: string | null = null;
  let buffer = "";

  const flush = () => {
    const text = normalizeWhitespace(buffer);
    if (currentMark !== null || text) {
      out.push({ markName: currentMark, text });
    }
    buffer = "";
  };

  const walk = (nodes: PreservedNode[]) => {
    for (const node of nodes) {
      if ("#text" in node) {
        buffer += node["#text"];
        continue;
      }
      const tag = childTagName(node);
      if (!tag) continue;
      const attrs = node[":@"] as Record<string, string> | undefined;
      const children = (node as Record<string, PreservedNode[]>)[tag] ?? [];
      if (tag === "mark") {
        // Boundary: emit the just-built segment, then start a new one
        // labeled with this mark's name.
        flush();
        currentMark = attrs?.["@_name"] ?? null;
      } else if (tag === "break") {
        // A pause cue. `say` honors a comma as a brief pause; SSML-aware
        // engines will ignore the comma and use their native break.
        buffer += ", ";
      } else {
        // <prosody>, <emphasis>, <voice>, <sub>, etc. — we don't apply
        // their effects with `say`, but their *text content* still needs
        // to be spoken, so recurse into them.
        walk(children);
      }
    }
  };

  walk(root);
  flush();
  return out;
}

// Helper: get the single element-tag key of a node (everything except `:@`).
function childTagName(node: PreservedNode): string | null {
  for (const k of Object.keys(node)) {
    if (k !== ":@" && k !== "#text") return k;
  }
  return null;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// --- 3. Audio pipeline -------------------------------------------------------
//
// The pipeline encapsulates everything the generator does with audio data,
// so adding a new delivery format (Opus, AAC, FLAC) is one struct, not a
// scatter of conditionals across the loop.
//
// Working representation throughout the pipeline is mono 16-bit PCM @ 22050
// Hz wrapped in WAV. We keep that across segments and chunks because:
//   - lossless concat is byte-splicing PCM (no re-encode loss accumulates)
//   - the leading-silence trim reads raw samples
//   - duration is exact from the WAV header
// Final-mile encoding to a delivered format happens in `encode()` — for WAV
// that's the identity function; for MP3 it's a single ffmpeg call.
//
// `synthesize` / `silence` / `duration` / `concat` / `leadingSilenceSamples`
// / `trim` all operate on the working-format buffer. A future backend that
// wanted to keep its own codec internally (and skip the WAV → delivery
// final step) would have to implement these operations on its own buffers
// — but it MUST implement them, not silently drop them. The interface is
// what makes the codec swap safe.
interface AudioPipeline {
  // Working-format extension, used only for any tmp files written to disk.
  workingExt: string;
  // Delivered-format extension and MIME — shown to the browser.
  deliveryExt: string;
  deliveryMime: string;
  // Sample rate of the working format. Used to convert
  // leadingSilenceSamples()'s sample-count return into seconds.
  samplesPerSecond: number;
  // External binaries that must exist on PATH. Probed at startup.
  requiredBinaries: readonly string[];

  // Synthesize one segment of speech. Returns a buffer in the working
  // format (e.g. a WAV file's bytes).
  synthesize(text: string): Promise<Uint8Array>;
  // Generate silence of the given duration in the working format. Used by
  // --mock and (eventually) for explicit pauses between marks.
  silence(durationSec: number): Uint8Array;
  // Precise duration of a working-format buffer.
  duration(buf: Uint8Array): number;
  // Splice working-format buffers into one with identical playback. MUST
  // be lossless w.r.t. the audio samples — no re-encode.
  concat(bufs: Uint8Array[]): Uint8Array;
  // Detect leading silence and return its length in *samples* (so the
  // caller can convert to seconds via samplesPerSecond and shift mark
  // times accordingly). Returns 0 if no significant silence.
  leadingSilenceSamples(buf: Uint8Array): number;
  // Drop `samples` leading audio samples and return the result.
  trim(buf: Uint8Array, samples: number): Uint8Array;
  // Final-mile encode for delivery (e.g. WAV → MP3). A future lossless-
  // delivery backend could make this the identity function.
  encode(workingBuf: Uint8Array): Promise<Uint8Array>;
}

// --- 4. WAV helpers (working-format implementation) --------------------------

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
  const numSamples = data.size / 2;
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

// Synthesize one chunk of speech with `say` and return the resulting WAV
// bytes. `say` can't write to stdout, so we round-trip through a tmp file.
async function sayToWavBytes(text: string): Promise<Uint8Array> {
  const dataFormat = `LEI16@${sampleRate}`;
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
}

// --- 5. Delivery encoders ----------------------------------------------------

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

// --- 6. Pipeline -------------------------------------------------------------

const pipeline: AudioPipeline = {
  workingExt: ".wav",
  deliveryExt: ".mp3",
  deliveryMime: "audio/mpeg",
  samplesPerSecond: sampleRate,
  requiredBinaries: ["say", "ffmpeg"],
  synthesize: sayToWavBytes,
  silence: buildSilentWav,
  duration: wavDurationSeconds,
  concat: concatWavs,
  leadingSilenceSamples: findLeadingSilenceSamples,
  trim: trimLeadingSamples,
  encode: wavToMp3Ffmpeg,
};

// Preflight: every required binary must exist on PATH. Surfacing a clear
// error here is much friendlier than a cryptic `say` or `ffmpeg` failure
// 30 segments into a synthesis run.
for (const bin of pipeline.requiredBinaries) {
  if (!Bun.which(bin)) {
    console.error(
      `Required binary "${bin}" not found on PATH.\n` +
        (bin === "ffmpeg"
          ? `Install ffmpeg (\`brew install ffmpeg\`).`
          : `Install it and try again.`),
    );
    process.exit(1);
  }
}

console.log(`Encoding MP3 @ ${mp3Bitrate} mono ${sampleRate}Hz`);

// --- 7. Process each chunk ---------------------------------------------------
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
  // mark, or end of chunk). The drawer in the client renders this directly,
  // so it stays plain text — no SSML markup leaks through.
  localMarks: { name: string; time: number; text: string }[];
};

const artifacts: ChunkArtifact[] = [];

for (const chunk of chunks) {
  const segments = splitSsml(chunk.ssml);
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
      buf = await pipeline.synthesize(seg.text);
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
  const trimSeconds = trimSamples / pipeline.samplesPerSecond;
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
