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
// Register new providers in `./tts-providers.ts`.
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

import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createMp3AudioPipeline,
  type AudioFormat,
  type AudioPipeline,
} from "./audio-pipeline.ts";
import { ttsProviders, type PlsLexicon } from "./tts-providers.ts";

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

// --- 3. Bootstrap: pipeline + TTS provider + preflight -----------------------
//
// The pipeline (silence / duration / concat / leading-silence / trim /
// encode) lives in ./audio-pipeline.ts so each op is unit-testable in
// isolation. The pipeline is orthogonal to the TTS provider; they're
// composed here at the bootstrap. Working representation is mono 16-bit
// PCM @ 22050 Hz in WAV; delivery is MP3.

const workingFormat: AudioFormat = { sampleRate, channels, bitsPerSample };
const pipeline: AudioPipeline = createMp3AudioPipeline(workingFormat, mp3Bitrate);

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

// --- 4. Process each chunk ---------------------------------------------------
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
      buf = await pipeline.silence(estSec);
    } else {
      buf = await tts.synthesize(seg.text);
    }
    segmentBufs.push(buf);
    segmentDurations.push(await pipeline.duration(buf));
  }

  const combined = pipeline.concat(segmentBufs);

  // Trim the leading silence so chapter seeks land on speech, not silence.
  // Everything inside the chunk shifts earlier by the trimmed duration;
  // mark 0 stays pinned to t=0 of the trimmed chunk (it now points to the
  // first phoneme rather than the silence that preceded it).
  const trimSeconds = mock ? 0 : await pipeline.leadingSilenceSeconds(combined);
  const trimmed = trimSeconds > 0 ? await pipeline.trim(combined, trimSeconds) : combined;
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
