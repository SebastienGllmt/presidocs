// Extracts inline SSML from a blog post HTML file, splits each chunk at
// <mark name="..."/> boundaries, synthesizes one WAV per segment with the
// macOS `say` command, concatenates segments into one WAV per chunk, and
// emits a manifest with absolute mark timings.
//
// Usage:
//   bun run scripts/generate.ts posts/hash-functions.html
//   bun run scripts/generate.ts posts/hash-functions.html --voice="Samantha"
//   bun run scripts/generate.ts posts/hash-functions.html --mock     # silent audio
//
// The `--mock` flag is for environments without `say` — it generates silent
// WAVs of estimated duration so the player can still be demoed end-to-end.

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
  console.error("usage: bun run scripts/generate.ts <post.html> [--voice=Samantha] [--mock]");
  process.exit(1);
}

const mock = flags.has("mock");
const voice = flags.get("voice") ?? "Samantha";
const rate = Number(flags.get("rate") ?? "180"); // words/min for `say`
const sampleRate = 22050;
const channels = 1;
const bitsPerSample = 16;

const html = await Bun.file(htmlPath).text();
const slug = basename(htmlPath).replace(/\.html?$/i, "");
const projectRoot = resolve(dirname(htmlPath), "..");
const outDir = join(projectRoot, "audio", slug);
await mkdir(outDir, { recursive: true });

// --- 1. Extract SSML chunks --------------------------------------------------

type SsmlChunk = { id: string; title: string; ssml: string };

const chunks: SsmlChunk[] = [];
const re = /<script\s+type="application\/ssml\+xml"([^>]*)>([\s\S]*?)<\/script>/gi;
let match: RegExpExecArray | null;
let anonCount = 0;
while ((match = re.exec(html)) !== null) {
  const attrs = match[1];
  const idAttr =
    /\bdata-chunk-id\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ??
    /\bid\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ??
    `chunk-${anonCount++}`;
  const titleAttr =
    /\bdata-chunk-title\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? idAttr;
  chunks.push({ id: idAttr, title: titleAttr, ssml: match[2] });
}

if (chunks.length === 0) {
  console.error(`No <script type="application/ssml+xml"> blocks found in ${htmlPath}`);
  process.exit(1);
}

console.log(`Found ${chunks.length} SSML chunk(s) in ${htmlPath}`);

// --- 2. Split each SSML chunk at <mark> --------------------------------------

type Segment = { markName: string | null; text: string };

function splitSsml(ssml: string): Segment[] {
  // Drop the <speak> wrapper.
  let body = ssml.replace(/<\/?speak[^>]*>/gi, "");
  // Convert <break time="..."/> to a comma so `say` pauses naturally.
  body = body.replace(/<break\b[^>]*\/>/gi, ", ");
  // Split at <mark name="..."/>.
  const parts = body.split(/<mark\s+name="([^"]+)"\s*\/>/g);
  // parts pattern: [leadingText, mark1, text1, mark2, text2, ...]
  const out: Segment[] = [];
  const leading = stripTagsAndEntities(parts[0] ?? "").trim();
  if (leading) out.push({ markName: null, text: leading });
  for (let i = 1; i < parts.length; i += 2) {
    const text = stripTagsAndEntities(parts[i + 1] ?? "").trim();
    out.push({ markName: parts[i], text });
  }
  return out;
}

function stripTagsAndEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/\s+/g, " ");
}

// --- 3. Audio helpers --------------------------------------------------------

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
    const id =
      String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
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

async function sayToWav(text: string, outPath: string) {
  // Force a consistent PCM format so segments concatenate cleanly.
  const dataFormat = `LEI16@${sampleRate}`;
  // Empty input would make `say` error out; substitute a tiny pause.
  const spoken = text.trim().length === 0 ? "..." : text;
  await $`say --voice=${voice} --rate=${rate} --output-file=${outPath} --file-format=WAVE --data-format=${dataFormat} ${spoken}`.quiet();
}

// --- 4. Process each chunk ---------------------------------------------------
//
// Per-chunk WAVs are still emitted (useful for cache-friendly regeneration:
// re-run on a single chunk by hand and only that file changes). For the
// playback experience we also splice all chunks into one `full.wav` and emit
// absolute mark times + chapter ranges that match it.

type ChunkArtifact = {
  id: string;
  title: string;
  buffer: Uint8Array;
  duration: number;
  localMarks: { name: string; time: number }[];
};

const artifacts: ChunkArtifact[] = [];

for (const chunk of chunks) {
  const segments = splitSsml(chunk.ssml);
  console.log(`  · ${chunk.id}: ${segments.length} segment(s)`);

  const tmpDir = join(outDir, `_tmp_${chunk.id}`);
  await mkdir(tmpDir, { recursive: true });
  const segmentBufs: Uint8Array[] = [];
  const segmentDurations: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let buf: Uint8Array;
    if (mock) {
      const wordCount = seg.text.split(/\s+/).filter(Boolean).length || 1;
      const estSec = (wordCount / rate) * 60 + 0.25;
      buf = buildSilentWav(estSec);
    } else {
      const segPath = join(tmpDir, `seg-${i}.wav`);
      await sayToWav(seg.text, segPath);
      buf = new Uint8Array(await Bun.file(segPath).arrayBuffer());
    }
    segmentBufs.push(buf);
    segmentDurations.push(wavDurationSeconds(buf));
  }

  const combined = concatWavs(segmentBufs);
  const outFile = join(outDir, `${chunk.id}.wav`);
  await Bun.write(outFile, combined);

  // Compute mark times relative to the chunk's start.
  const localMarks: { name: string; time: number }[] = [];
  let t = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.markName) localMarks.push({ name: seg.markName, time: t });
    t += segmentDurations[i];
  }

  artifacts.push({
    id: chunk.id,
    title: chunk.title,
    buffer: combined,
    duration: t,
    localMarks,
  });

  await rm(tmpDir, { recursive: true, force: true });
}

// Concatenate every chunk into one master audio file. Chapters are the
// chunks; marks get translated to absolute time.
const fullBuf = concatWavs(artifacts.map((a) => a.buffer));
const fullPath = join(outDir, "full.wav");
await Bun.write(fullPath, fullBuf);

const chapters: { id: string; title: string; startTime: number; endTime: number }[] = [];
const marks: { name: string; time: number; chapter: string }[] = [];
let offset = 0;
for (const a of artifacts) {
  const start = offset;
  const end = offset + a.duration;
  chapters.push({ id: a.id, title: a.title, startTime: round3(start), endTime: round3(end) });
  for (const m of a.localMarks) {
    marks.push({ name: m.name, time: round3(start + m.time), chapter: a.id });
  }
  offset = end;
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

const manifest = {
  slug,
  generatedAt: new Date().toISOString(),
  audio: `/audio/${slug}/full.wav`,
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
