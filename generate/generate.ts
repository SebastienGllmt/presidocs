// Extracts the inline narration script from a blog post HTML file, splits
// each chapter at <mark name="..."/> boundaries, synthesizes one WAV per
// segment via a pluggable TTS provider, concatenates segments into one
// master track, and emits a manifest with absolute mark timings.
//
// Usage:
//   bun run generate/generate.ts posts/hash-functions.html
//   bun run generate/generate.ts posts/hash-functions.html --voice="Samantha"
//   bun run generate/generate.ts posts/hash-functions.html --bitrate=96k
//   bun run generate/generate.ts posts/hash-functions.html --tts=say
//   MOSS_TTS_DIR=/path/to/MOSS-TTS \
//     bun run generate/generate.ts posts/hash-functions.html \
//       --tts=moss --voice=/path/to/my_voice.wav     # production voice clone
//   bun run generate/generate.ts posts/hash-functions.html --mock     # silent audio
//
// Delivers MP3 @ 64 kbps mono. Requires `ffmpeg` on PATH plus whichever
// binaries the selected TTS provider needs (the preflight fails fast with
// a clear message if any are missing).
//
// TTS provider is selected by `--tts=NAME` (default: `say`, macOS-only,
// fast/cheap for iteration). `--tts=moss` is the production voice — a local
// MOSS-TTS voice clone: set `MOSS_TTS_DIR` to your MOSS-TTS checkout and pass
// `--voice=<reference.wav>` (the clip to clone). Optional MOSS env overrides:
// `MOSS_TTS_PYTHON` (interpreter), `MOSS_TTS_DEVICE` (torch device),
// `MOSS_TTS_FFMPEG_LIB` (FFmpeg lib dir for torchcodec; auto-derived from the
// `ffmpeg` on PATH otherwise). Register new providers in `./tts-providers.ts`.
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
import { wrapWithCache, type CachedTtsProvider } from "./tts-cache.ts";
import { asMs, msToSeconds, type Milliseconds } from "../shared/time.ts";

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
  console.error("usage: bun run generate/generate.ts <post.html> [--tts=say] [--voice=Samantha] [--mock]");
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
// wrote (modulo HTMLRewriter's streaming chunk boundaries, which we re-join).
//
// Two block types share this single pass:
//   - `text/narration` — the spoken-script for one chapter
//   - `application/pls+xml` — inline pronunciation lexicon (optional, zero
//     or more blocks; concatenated and merged with `common-terms.pls` at
//     bootstrap)

type NarrationChapter = { id: string; title: string; content: string };

const chapters: NarrationChapter[] = [];
const inlinePlsBlocks: string[] = [];
let anonCount = 0;
let pendingChapter: { id: string; title: string; buf: string[] } | null = null;
let pendingPlsBuf: string[] | null = null;

new HTMLRewriter()
  .on('script[type="text/narration"]', {
    element(el) {
      const id =
        el.getAttribute("data-chapter-id") ??
        el.getAttribute("id") ??
        `chapter-${anonCount++}`;
      const title = el.getAttribute("data-chapter-title") ?? id;
      // HTMLRewriter walks the tree in document order and serializes script
      // elements one at a time, so a single shared `pending` is safe.
      pendingChapter = { id, title, buf: [] };
      el.onEndTag(() => {
        if (pendingChapter) {
          chapters.push({
            id: pendingChapter.id,
            title: pendingChapter.title,
            content: pendingChapter.buf.join(""),
          });
          pendingChapter = null;
        }
      });
    },
    text(t) {
      pendingChapter?.buf.push(t.text);
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

if (chapters.length === 0) {
  console.error(`No <script type="text/narration"> blocks found in ${htmlPath}`);
  process.exit(1);
}

console.log(`Found ${chapters.length} narration chapter(s) in ${htmlPath}`);
if (inlinePlsBlocks.length > 0) {
  console.log(`Found ${inlinePlsBlocks.length} inline PLS block(s) in ${htmlPath}`);
}

// --- 2. Split each chapter at <mark> -----------------------------------------
//
// The in-chapter format is plain text plus `<mark name="..."/>` boundaries —
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

function splitChapter(content: string): Segment[] {
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
// We keep the shared and inline sources separate so the local-only set
// can feed the cache identity (see below) while the merged set feeds the
// TTS provider.
const sharedPlsPath = join(dirname(htmlPath), "common-terms.pls");
type PlsSource = { label: string; xml: string };
const sharedPlsSources: PlsSource[] = [];
const localPlsSources: PlsSource[] = [];
if (await Bun.file(sharedPlsPath).exists()) {
  sharedPlsSources.push({
    label: sharedPlsPath,
    xml: await Bun.file(sharedPlsPath).text(),
  });
}
inlinePlsBlocks.forEach((xml, i) => {
  localPlsSources.push({ label: `inline:${htmlPath}#${i}`, xml });
});
const plsSources: PlsSource[] = [...sharedPlsSources, ...localPlsSources];

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

// Local-only lexicon for the cache identity. Excluding cross-post shared
// sources (e.g. `common-terms.pls`) from the cache key means edits to
// those files don't blow away every post's cache. The merged `lexicon`
// above is still what the provider synthesizes against, so a fresh
// synthesis still honors the latest shared pronunciations — only
// already-cached segments keep their old ones until the cache is wiped.
const localLexicon: PlsLexicon | null =
  localPlsSources.length > 0 ? mergeLexicons(localPlsSources) : null;

const rawTts = ttsFactory({
  voice,
  rate,
  format: workingFormat,
  lexicon,
});

// Wrap with a segment-level disk cache so edits to a single sentence only
// re-synthesize that segment. The cache lives under `generated/.tts-cache/`
// — shared across posts because segments are addressed by content
// (provider + voice + rate + format + post-local lexicon + text), not by
// post. Only the post-local lexicon goes into the key; see tts-cache.ts
// for the rationale.
// Mock runs bypass the cache: the silent-audio shortcut is already cheap,
// and caching it would just waste disk on never-played placeholders.
const cacheDir = join(projectRoot, "generated", ".tts-cache");
const cachedTts: CachedTtsProvider | null = mock
  ? null
  : wrapWithCache(rawTts, {
      cacheDir,
      identity: {
        providerName: rawTts.name,
        voice,
        rate,
        format: workingFormat,
        localLexiconXml: localLexicon?.xml ?? null,
      },
    });
const tts = cachedTts ?? rawTts;

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

// --- 4. Process each chapter -------------------------------------------------
//
// Per-chapter audio files are emitted alongside the full track. They're not
// what makes regeneration fast — the segment-level cache does that — but
// they're useful for debugging and for any future workflow that wants to
// serve individual chapter audio separately. For the playback experience we
// also splice all chapters into one `full.<ext>` and emit absolute mark
// times + chapter ranges that match it.
//
// Working-format buffers live in memory for the whole run; only delivery-
// format bytes are written to disk.

type ChapterArtifact = {
  id: string;
  title: string;
  // Working-format buffer (lossless), kept for the final concat into `full`.
  buffer: Uint8Array;
  duration: Milliseconds;
  // `text` carries the spoken text that follows each mark (up to the next
  // mark, or end of chapter). The drawer in the client renders this directly;
  // it's already plain text because the in-chapter format is plain text.
  localMarks: { name: string; time: Milliseconds; text: string }[];
};

const artifacts: ChapterArtifact[] = [];

for (const chapter of chapters) {
  const segments = splitChapter(chapter.content);
  console.log(`  · ${chapter.id}: ${segments.length} segment(s)`);

  const segmentBufs: Uint8Array[] = [];
  const segmentDurations: Milliseconds[] = [];

  for (const seg of segments) {
    let buf: Uint8Array;
    if (mock) {
      const wordCount = seg.text.split(/\s+/).filter(Boolean).length || 1;
      const estMs = asMs(Math.round(((wordCount / rate) * 60 + 0.25) * 1000));
      buf = await pipeline.silence(estMs);
    } else {
      buf = await tts.synthesize(seg.text);
    }
    segmentBufs.push(buf);
    segmentDurations.push(await pipeline.duration(buf));
  }

  const combined = pipeline.concat(segmentBufs);

  // Trim the leading silence so chapter seeks land on speech, not silence.
  // Everything inside the chapter shifts earlier by the trimmed duration;
  // mark 0 stays pinned to t=0 of the trimmed chapter (it now points to the
  // first phoneme rather than the silence that preceded it).
  const trimMs = mock ? asMs(0) : await pipeline.leadingSilenceMs(combined);
  const trimmed = trimMs > 0 ? await pipeline.trim(combined, trimMs) : combined;
  if (trimMs > 0) {
    console.log(`    trimmed ${trimMs}ms of leading silence`);
  }

  // Encode + write the per-chapter delivery file. Not used by the current
  // player (which loads only `full.<ext>`) but handy for debugging and any
  // workflow that wants per-chapter audio served separately.
  const chapterDelivered = await pipeline.encode(trimmed);
  const chapterPath = join(outDir, `${chapter.id}${pipeline.deliveryExt}`);
  await Bun.write(chapterPath, chapterDelivered);

  // Compute mark times relative to the trimmed chapter's start.
  const localMarks: { name: string; time: Milliseconds; text: string }[] = [];
  let t = asMs(0);
  for (const [i, seg] of segments.entries()) {
    if (seg.markName) {
      localMarks.push({
        name: seg.markName,
        time: asMs(Math.max(0, t - trimMs)),
        text: seg.text,
      });
    }
    t = asMs(t + segmentDurations[i]!);
  }

  artifacts.push({
    id: chapter.id,
    title: chapter.title,
    buffer: trimmed,
    duration: asMs(t - trimMs),
    localMarks,
  });
}

// Concatenate every chapter in the working (lossless) format, then encode
// the result for delivery. Doing the encode at the end (rather than per
// chapter and concatenating MP3s) avoids the brittleness of MP3 concatenation
// and keeps cumulative encoder padding to a single occurrence per file.
const fullBuf = pipeline.concat(artifacts.map((a) => a.buffer));
const fullDelivered = await pipeline.encode(fullBuf);
const fullPath = join(outDir, `full${pipeline.deliveryExt}`);
await Bun.write(fullPath, fullDelivered);

// `manifestChapters` / `manifestMarks` are the flattened entries that ship
// in the manifest JSON — distinct from the parsed-input `chapters` array
// (which holds the script text). The same chapter shows up in both, but
// with different shapes: text content in `chapters`, timing in
// `manifestChapters`.
const manifestChapters: { id: string; title: string; startTime: Milliseconds; endTime: Milliseconds }[] = [];
const manifestMarks: { name: string; time: Milliseconds; chapter: string; text: string }[] = [];
let offset = asMs(0);
for (const a of artifacts) {
  const start = offset;
  const end = asMs(offset + a.duration);
  manifestChapters.push({ id: a.id, title: a.title, startTime: start, endTime: end });
  for (const m of a.localMarks) {
    manifestMarks.push({
      name: m.name,
      time: asMs(start + m.time),
      chapter: a.id,
      text: m.text,
    });
  }
  offset = end;
}

const manifest = {
  slug,
  generatedAt: new Date().toISOString(),
  audio: `/generated/${slug}/full${pipeline.deliveryExt}`,
  duration: offset,
  chapters: manifestChapters,
  marks: manifestMarks,
};
await Bun.write(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`\nWrote ${manifestChapters.length} chapter(s), ${manifestMarks.length} mark(s) to ${outDir}`);
console.log(`  full duration: ${msToSeconds(manifest.duration).toFixed(2)}s`);
for (const c of manifestChapters) {
  const count = manifestMarks.filter((m) => m.chapter === c.id).length;
  const lenSec = msToSeconds(asMs(c.endTime - c.startTime));
  console.log(`  ${c.id.padEnd(14)} ${lenSec.toFixed(2)}s   ${count} mark(s)   "${c.title}"`);
}

if (cachedTts) {
  const { hits, misses } = cachedTts.stats;
  console.log(`  TTS cache: ${hits} hit(s), ${misses} miss(es) (${cacheDir})`);

  // Persist the set of TEXT-hashes this post currently uses. `clean.ts`
  // reads these per-post indices to GC orphaned text-hash buckets in the
  // shared cache. Crucially, this is OVERWRITTEN (not unioned) on every
  // run: a sentence removed from the post drops its text-hash here, and
  // the next clean reaps the whole bucket — every voice/rate variant of
  // that sentence in one shot. Re-running with a different voice writes
  // the same set of text-hashes (text didn't change), so old voice
  // variants survive inside their bucket.
  const keysPath = join(outDir, "cache-keys.json");
  const current = Array.from(cachedTts.textHashes).sort();
  await Bun.write(keysPath, JSON.stringify(current, null, 2));
}
