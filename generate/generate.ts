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
//   bun run generate/generate.ts posts/hash-functions.html --tts=espeak-ng  # Linux dev
//   bun run generate:prod posts/hash-functions.html     # production voice clone
//   bun run generate/generate.ts posts/hash-functions.html --mock     # silent audio
//
// Delivers MP3 @ 64 kbps mono. Requires `ffmpeg` on PATH plus whichever
// binaries the selected TTS provider needs (the preflight fails fast with
// a clear message if any are missing).
//
// TTS provider is selected by `--tts=NAME` (default: `say`, macOS-only,
// fast/cheap for iteration; `--tts=espeak-ng` is the Linux equivalent — same
// rough-draft role, but install it first: `sudo apt install espeak-ng`).
// `--tts=moss` is the production voice — a local
// MOSS-TTS voice clone. The `generate:prod` npm script is `--tts=moss`; with
// `MOSS_TTS_DIR` (your checkout) set in `.env`, production is just
// `bun run generate:prod <post.html>`. The voice clip is resolved per-post
// from `<meta name="author-email">` via `authors/<email>.wav` (see
// methodology.md "Per-author voice resolution"); pass `--voice=<reference.wav>`
// to override. Optional MOSS env overrides:
// `MOSS_TTS_PYTHON` (interpreter), `MOSS_TTS_DEVICE` (torch device),
// `MOSS_TTS_FFMPEG_LIB` (FFmpeg lib dir for torchcodec; auto-derived from the
// `ffmpeg` on PATH otherwise), `MOSS_TTS_CONTINUATION` (continuity strategy).
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

import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  createMp3AudioPipeline,
  type AudioFormat,
  type AudioPipeline,
} from "./audio-pipeline.ts";
import { ttsProviders, type PlsLexicon, type SegmentContext } from "./tts-providers.ts";
import { splitChapter } from "./narration.ts";
import { wrapWithCache, computeTextHash, computeCacheKey, type CachedTtsProvider } from "./tts-cache.ts";
import { forcedAligners, type ForcedAlignerName } from "./aligner.ts";
import { wrapWithAlignmentCache, type CachedAligner, type CachedWord } from "./aligner-cache.ts";
import { buildVtt, hasAlignment } from "./webvtt.ts";
import { parseLexicon } from "./pronunciation.ts";
import { normalizeChapterParents } from "./chapterParents.ts";
import { asMs, msToSeconds, type Milliseconds } from "../shared/time.ts";
import { resolveAuthorVoice } from "../shared/voiceResolution.ts";
import { manifestFileName, MANIFEST_HASHED_RE } from "../shared/manifestFile.ts";
import { parseAuthorEmailFromHtml } from "../server/postMeta.ts";

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
// No post path → batch mode: generate over every narrated post (delegated to
// generate-all.ts, which spawns this same script once per post). This is what
// `bun run generate:prod` with no argument resolves to. `--chapters` and
// `--force-mark` are single-post iteration knobs (they name marks/chapters in
// one specific post), so reject them here rather than forward a nonsensical
// filter to every post.
if (!htmlPath) {
  for (const single of ["chapters", "force-mark"]) {
    if (flags.has(single)) {
      console.error(`--${single} requires a specific post; pass one: bun run generate/generate.ts <post.html> --${single}=...`);
      process.exit(1);
    }
  }
  const { runBatch } = await import("./generate-all.ts");
  process.exit(await runBatch(argv));
}

const mock = flags.has("mock");
// `--tts=NAME` picks the provider factory. Default is platform-aware: `say` on
// macOS (preinstalled), `espeak-ng` everywhere else — the Linux equivalent in
// the same rough-draft role. Read here so the `voice` default below can be
// provider-aware.
const ttsName = flags.get("tts") ?? (process.platform === "darwin" ? "say" : "espeak-ng");
// `--voice` is the `say` voice name OR, for `moss`, the path to the clone
// reference clip. When --voice isn't passed and tts=moss, we auto-resolve from
// the post's `<meta name="author-email">` via `authors/<email>.wav` — see the
// per-author voice resolution in methodology.md. That happens after the HTML
// is loaded; this `voice` is initialized lazily below.
// Per-provider default voice when --voice isn't passed: `say` → a macOS voice
// name; `espeak-ng` → a language voice id; `moss` → "" (resolved per-author from
// authors/<email>.wav after the HTML loads, below).
const DEFAULT_VOICE: Record<string, string> = { say: "Samantha", "espeak-ng": "en-us" };
let voice = flags.get("voice") ?? (DEFAULT_VOICE[ttsName] ?? "");
const rate = Number(flags.get("rate") ?? "180"); // words/min for `say` / `espeak-ng`
const sampleRate = 22050;
const channels = 1;
const bitsPerSample = 16;

const mp3Bitrate = flags.get("bitrate") ?? "64k";

// Silence inserted between adjacent segments (and between chapters) at concat
// time, so sentences get a natural beat instead of running straight into each
// other. TTS engines leave little/no gap of their own, especially under
// continuation prompting. Mark times below are computed against this gapped
// layout so highlighting stays in sync. Set --segment-gap=0 to disable.
const segmentGapMs = asMs(Math.max(0, Number(flags.get("segment-gap") ?? "200")));

// `--force-mark=NAME[,NAME...]` re-rolls specific segment(s): the named marks'
// segments bypass the cache (forcing a fresh, possibly different MOSS take)
// while every other segment still hits, so the rebuild is fast. This backs the
// author's per-segment "regenerate" button (see methodology.md). No-op for
// `--mock` (which skips the cache entirely).
const forceMarks = new Set(
  (flags.get("force-mark") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// `--align=NAME` opts in to per-segment forced alignment for the drawer's
// word-highlight feature + the WebVTT subtitle sidecar (proposals/17). Default
// off, so existing builds are unchanged. Today the only backend is `qwen3`,
// gated by QWEN3_ALIGNER_DIR (see generate/aligner.ts). `--align-language`
// picks the language fed to the aligner (default English).
const alignName = flags.get("align") as ForcedAlignerName | undefined;
const alignLanguage = flags.get("align-language") ?? "English";

// `--chapters=ID[,ID,...]` keeps only the listed chapters (matched by
// data-chapter-id), in document order. Mostly a quick-iteration knob — the
// first end-to-end run with `--tts=moss --align=qwen3` on an unbuilt 30-
// chapter post takes hours because every segment loads the multi-GB MOSS
// AND Qwen3 models in fresh subprocesses; this lets the author try the
// pipeline on one or two chapters first to confirm it works before
// committing to the full render. The resulting manifest, audio, and
// captions.vtt only contain those chapters — re-run without the flag to
// produce the full set.
const chapterFilter = flags.get("chapters");
const chapterAllowlist = chapterFilter
  ? new Set(
      chapterFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

const html = await Bun.file(htmlPath).text();
const slug = basename(htmlPath).replace(/\.html?$/i, "");
const projectRoot = resolve(dirname(htmlPath), "..");
const outDir = join(projectRoot, "generated", slug);
await mkdir(outDir, { recursive: true });

// MOSS voice: when --voice isn't passed, look up `authors/<author-email>.wav`
// for THIS post's author (parsed from the post HTML). No env-var fallback —
// the per-author convention is the only source so a multi-author blog can't
// silently render the wrong voice (see methodology.md "Per-author voice
// resolution"). For `say` we leave the default voice name in place.
if (ttsName === "moss" && !voice) {
  const authorEmail = parseAuthorEmailFromHtml(html);
  const r = resolveAuthorVoice(projectRoot, authorEmail);
  if (!r.ok) {
    console.error(
      `Cannot resolve MOSS voice clip for ${htmlPath}: ${r.reason}.\n` +
        `  Add the clip at authors/<author-email>.wav, or pass --voice=<path>.`,
    );
    process.exit(1);
  }
  voice = r.clipPath;
}

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

// `parentId` (optional) is the second hierarchy level: a block with
// `data-chapter-parent` is a sub-chapter of the referenced chapter. Read raw
// here; `normalizeChapterParents` below validates it and enforces the two-level
// cap with a warn (never a hard fail).
type NarrationChapter = { id: string; title: string; content: string; parentId?: string };

const chapters: NarrationChapter[] = [];
const inlinePlsBlocks: string[] = [];
// Set when the post opts out of narration entirely via
// `<article data-narration="none">`. Distinct from "no narration written
// yet": a disabled post is skipped cleanly rather than erroring on zero
// chapters (so a batch generate over all posts doesn't choke on it).
let narrationDisabled = false;
let anonCount = 0;
let pendingChapter: { id: string; title: string; parentId?: string; buf: string[] } | null = null;
let pendingPlsBuf: string[] | null = null;

new HTMLRewriter()
  .on('script[type="text/narration"]', {
    element(el) {
      const id =
        el.getAttribute("data-chapter-id") ??
        el.getAttribute("id") ??
        `chapter-${anonCount++}`;
      const title = el.getAttribute("data-chapter-title") ?? id;
      const parentId = el.getAttribute("data-chapter-parent") ?? undefined;
      // HTMLRewriter walks the tree in document order and serializes script
      // elements one at a time, so a single shared `pending` is safe.
      pendingChapter = { id, title, parentId, buf: [] };
      el.onEndTag(() => {
        if (pendingChapter) {
          chapters.push({
            id: pendingChapter.id,
            title: pendingChapter.title,
            content: pendingChapter.buf.join(""),
            parentId: pendingChapter.parentId,
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
  .on("article[data-narration]", {
    element(el) {
      if ((el.getAttribute("data-narration") ?? "").toLowerCase() === "none") {
        narrationDisabled = true;
      }
    },
  })
  .transform(html);

if (narrationDisabled) {
  console.log(`Narration intentionally disabled (data-narration="none") in ${htmlPath}; skipping.`);
  process.exit(0);
}

if (chapters.length === 0) {
  console.error(`No <script type="text/narration"> blocks found in ${htmlPath}`);
  process.exit(1);
}

// Validate the optional `data-chapter-parent` pointers and enforce the
// two-level cap. Degrades to a flat chapter rather than hard-failing —
// matching the opt-out philosophy of never erroring a whole batch generate
// over one bad post. The pure implementation lives in `./chapterParents.ts`
// so it can be unit-tested without the HTMLRewriter pipeline above.
normalizeChapterParents(chapters);

// Apply --chapters=ID[,ID,...] truncation AFTER normalization so a sub-chapter
// kept while its parent is dropped doesn't carry a now-dangling parentId.
// A kept sub-chapter whose parent was filtered out is reparented to top level
// (we drop the parentId pointer rather than refuse) — keeps the truncated
// build well-formed without needing the author to also list the parent.
if (chapterAllowlist) {
  const before = chapters.length;
  const kept = chapters.filter((c) => chapterAllowlist.has(c.id));
  const keptIds = new Set(kept.map((c) => c.id));
  for (const c of kept) if (c.parentId && !keptIds.has(c.parentId)) c.parentId = undefined;
  const missing = [...chapterAllowlist].filter((id) => !chapters.some((c) => c.id === id));
  if (missing.length > 0) {
    console.warn(`  · --chapters: no chapter id matched: ${missing.join(", ")}`);
  }
  chapters.length = 0;
  chapters.push(...kept);
  console.log(`Chapter filter --chapters=${chapterFilter}: kept ${kept.length}/${before}`);
}

console.log(`Found ${chapters.length} narration chapter(s) in ${htmlPath}`);
if (inlinePlsBlocks.length > 0) {
  console.log(`Found ${inlinePlsBlocks.length} inline PLS block(s) in ${htmlPath}`);
}

// --- 2. Split each chapter at <mark> -----------------------------------------
//
// Segment parsing (and the paragraph-derived `continuesPrevious` signal) lives
// in ./narration.ts so it's unit-testable without booting this script.

// --- 3. Bootstrap: pipeline + TTS provider + preflight -----------------------
//
// The pipeline (silence / duration / concat / leading-silence / trim /
// encode) lives in ./audio-pipeline.ts so each op is unit-testable in
// isolation. The pipeline is orthogonal to the TTS provider; they're
// composed here at the bootstrap. Working representation is mono 16-bit
// PCM @ 22050 Hz in WAV; delivery is MP3.

const workingFormat: AudioFormat = { sampleRate, channels, bitsPerSample };
const pipeline: AudioPipeline = createMp3AudioPipeline(workingFormat, mp3Bitrate);

// TTS provider selection (parsed above as `ttsName`). New engines plug in by
// registering a factory in `ttsProviders`.
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
// Label lexicon sources by their path RELATIVE TO THE REPO ROOT, never the
// absolute/invocation path. The merged local lexicon XML feeds the TTS cache
// key (see tts-cache.ts), and the label rides along inside it as a
// `<!-- from ... -->` comment — so an absolute path would make the key depend
// on the machine and on HOW generate was invoked (absolute from the regenerate
// endpoint vs. relative from the CLI vs. different cwds), busting the cache
// both between equivalent runs and across machines sharing a cache. A
// repo-relative path is stable across all of those and still debuggable.
const repoRel = (p: string) => relative(projectRoot, resolve(p));
if (await Bun.file(sharedPlsPath).exists()) {
  sharedPlsSources.push({
    label: repoRel(sharedPlsPath),
    xml: await Bun.file(sharedPlsPath).text(),
  });
}
inlinePlsBlocks.forEach((xml, i) => {
  localPlsSources.push({ label: `inline:${repoRel(htmlPath)}#${i}`, xml });
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

// Resolve --force-mark names to the raw segment texts the cache keys on (the
// cache predicate is matched against `seg.text`, pre-substitution — the same
// string handed to `tts.synthesize`). Warn on any name that matches no mark so
// a typo doesn't silently regenerate nothing.
const forcedTexts = new Set<string>();
if (forceMarks.size > 0) {
  const seen = new Set<string>();
  for (const chapter of chapters) {
    for (const seg of splitChapter(chapter.content)) {
      if (seg.markName && forceMarks.has(seg.markName)) {
        forcedTexts.add(seg.text);
        seen.add(seg.markName);
      }
    }
  }
  const missing = [...forceMarks].filter((m) => !seen.has(m));
  if (missing.length > 0) {
    console.warn(`  · --force-mark: no segment found for mark(s): ${missing.join(", ")}`);
  }
  if (seen.size > 0) {
    console.log(`Force-regenerating segment(s): ${[...seen].join(", ")}`);
  }
}

const ttsIdentity = {
  providerName: rawTts.name,
  // Use the provider's machine-independent voice id when it has one
  // (MOSS hashes its reference clip's contents); fall back to the raw
  // voice name otherwise (`say`). Keeps an absolute, per-machine clip
  // path out of the cache key so a shared cache hits across machines.
  voice: rawTts.cacheVoiceId ?? voice,
  rate,
  format: workingFormat,
  localLexiconXml: localLexicon?.xml ?? null,
};
const cachedTts: CachedTtsProvider | null = mock
  ? null
  : wrapWithCache(rawTts, {
      cacheDir,
      identity: ttsIdentity,
      forceResynthesize: forcedTexts.size > 0 ? (text) => forcedTexts.has(text) : undefined,
    });
const tts = cachedTts ?? rawTts;

// Optional: per-segment forced alignment for word-level drawer highlighting +
// the WebVTT subtitle sidecar (proposals/17). The alignment cache shares the
// TTS cache directory: words.json files live next to their .wav under the
// same `<text-hash>/<full-hash>` bucket, so a segment re-roll (which
// overwrites the .wav at the same path) MUST also force a fresh alignment —
// otherwise the stale words.json would describe the old audio.
let cachedAligner: CachedAligner | null = null;
if (alignName && !mock) {
  const factory = forcedAligners[alignName];
  if (!factory) {
    console.error(
      `--align=${alignName} is not a known aligner. Known: ${Object.keys(forcedAligners).join(", ")}.`,
    );
    process.exit(1);
  }
  const rawAligner = factory({ defaultLanguage: alignLanguage });
  // Alignment runs on the MERGED lexicon (the same text the TTS engine
  // received, including cross-post `common-terms.pls` substitutions),
  // because the AUDIO contains the substituted speech regardless of which
  // file the lexeme came from. The cache key for words.json reuses the TTS
  // cache key, which intentionally excludes `common-terms.pls` — same
  // tradeoff as the WAV cache: a shared-lexicon edit doesn't invalidate
  // every post until the per-segment audio is itself re-rolled.
  const lexEntries = lexicon ? parseLexicon(lexicon.xml) : [];
  cachedAligner = wrapWithAlignmentCache({
    cacheDir,
    aligner: rawAligner,
    language: alignLanguage,
    lexicon: { entries: lexEntries, ipaSupported: false }, // MOSS's ipaSupported stays false; see tts-providers.ts
    forceRealign: forcedTexts.size > 0 ? (text) => forcedTexts.has(text) : undefined,
  });
  console.log(`Alignment: ${alignName} (language=${alignLanguage})`);
}

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
  if (bin === "say") return `\`say\` is macOS-only; on Linux use \`--tts=espeak-ng\` instead.`;
  if (bin === "espeak-ng")
    return `Install espeak-ng (Debian/Ubuntu: \`sudo apt install espeak-ng\`; Fedora: \`sudo dnf install espeak-ng\`; macOS: \`brew install espeak-ng\`).`;
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
  // `segmentStartInChapter` is the segment's pre-trim start time (ms) within
  // the chapter; combined with the chapter-level `trimMs` it lets the
  // manifest serializer project per-word segment-WAV-relative times into
  // master-track absolute times (proposals/17 §7.2 — words live in segment
  // WAV coords inside the cache so the same cached segment can be reused
  // across posts at different positions).
  localMarks: {
    name: string;
    time: Milliseconds;
    text: string;
    segmentStartInChapter: Milliseconds;
    words?: CachedWord[];
    // The mark's stage/control pointer (proposal 47). Absent (undefined) =
    // "leave the stage unchanged"; "none"/"" = an explicit clear; otherwise a
    // `<figure id>`. Carried verbatim onto the manifest mark.
    figure?: string;
    // The mark's per-step slideshow pointer (proposal 48). Absent (undefined) =
    // "no step cue"; "none"/"" = clear stepped mode; otherwise a journey step
    // label. Threaded onto the manifest mark exactly like `figure`.
    step?: string;
  }[];
  trimMs: Milliseconds;
};

const artifacts: ChapterArtifact[] = [];

// Defect guard: a synthesized segment that is ENTIRELY silence (no speech
// detected anywhere) is a degenerate TTS take — MOSS occasionally emits one
// (e.g. a 4s clip of pure silence). It poisons the build invisibly: the
// per-chapter leading-silence trim removes the whole "silent" segment, so any
// aligned words for it fall before t=0 and get dropped, and the mark ships with
// no word timing. Today that only surfaced far downstream at the deploy gate
// (verify-narration: "N spoken mark(s) have no word-level timing") — or worse,
// as dead air in the track. We catch it here at synth time and fail with the
// exact re-roll command. Detection reuses `leadingSilenceMs` (the SAME
// measurement that drives the trim, so the guard fires on exactly the inputs
// that would break the trim): an all-silent clip reports its full duration as
// leading silence, so `duration - leadingSilence <= ε` means "no speech." Scoped
// to mark-bearing segments with real (letter/number) content — punctuation- or
// whitespace-only segments legitimately synthesize to near-silence, and only a
// mark-bearing segment is individually re-rollable via `--force-mark`.
const silentMarks: { mark: string; chapter: string; durationMs: Milliseconds }[] = [];
const SILENCE_EPSILON_MS = asMs(50);
const hasSpeakableContent = (s: string) => /[\p{L}\p{N}]/u.test(s);

// Reusable inter-segment / inter-chapter silence (built once). `null` when
// gaps are disabled, so concat falls back to the original back-to-back glue.
const segmentGap = segmentGapMs > 0 ? await pipeline.silence(segmentGapMs) : null;
if (segmentGap) console.log(`Inserting ${segmentGapMs}ms of silence between segments`);

// Interleave `gap` between every adjacent pair of `parts` (no leading/trailing
// gap). Used for both within-chapter segments and the cross-chapter join.
const interleave = (parts: Uint8Array[], gap: Uint8Array | null): Uint8Array[] => {
  if (!gap) return parts;
  const out: Uint8Array[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(gap);
    out.push(p);
  });
  return out;
};

for (const chapter of chapters) {
  const segments = splitChapter(chapter.content);
  console.log(`  · ${chapter.id}: ${segments.length} segment(s)`);

  const segmentBufs: Uint8Array[] = [];
  const segmentDurations: Milliseconds[] = [];
  // Per-segment aligned words, in segment-WAV coords. Sparse: index i is
  // populated only when alignment is enabled AND the segment carries a mark
  // name (we only emit `words[]` on entries that show up in the manifest).
  const segmentWords: (CachedWord[] | null)[] = [];

  for (const [i, seg] of segments.entries()) {
    let buf: Uint8Array;
    if (mock) {
      const wordCount = seg.text.split(/\s+/).filter(Boolean).length || 1;
      const estMs = asMs(Math.round(((wordCount / rate) * 60 + 0.25) * 1000));
      buf = await pipeline.silence(estMs);
    } else {
      // Cross-segment prosody context (see methodology.md). When this segment
      // continues the previous one, hand the engine the prior segment's text
      // and just-synthesized audio so it can avoid a fresh-paragraph restart.
      // This is best-effort and intentionally NOT part of the cache key, so a
      // cached segment is reused even if its neighbor later changes.
      const context: SegmentContext = seg.continuesPrevious
        ? {
            continuesPrevious: true,
            previousText: segments[i - 1]?.text,
            previousAudio: segmentBufs[i - 1],
          }
        : { continuesPrevious: false };
      buf = await tts.synthesize(seg.text, context);
    }
    segmentBufs.push(buf);
    const segDuration = await pipeline.duration(buf);
    segmentDurations.push(segDuration);
    // Flag a degenerate all-silence take before it can poison the trim (see
    // `silentMarks` above). Skips --mock (silence is its whole design) and runs
    // on cached buffers too, so a previously-cached bad take is caught on the
    // next build rather than shipped.
    if (!mock && seg.markName && hasSpeakableContent(seg.text)) {
      const lead = await pipeline.leadingSilenceMs(buf);
      if (segDuration - lead <= SILENCE_EPSILON_MS) {
        silentMarks.push({ mark: seg.markName, chapter: chapter.id, durationMs: segDuration });
      }
    }
    // Run alignment on the just-synthesized (or just-cached) audio. We align
    // every segment regardless of whether it carries a mark name, because
    // the cache is keyed on text + identity and re-aligning a no-mark segment
    // costs the same as a mark-bearing one — but only store words[] for
    // mark-bearing segments (those are what the manifest renders).
    if (!mock && cachedAligner && seg.markName) {
      const textHash = computeTextHash(seg.text);
      const fullHash = computeCacheKey(ttsIdentity, seg.text);
      const words = await cachedAligner.align(textHash, fullHash, seg.text, buf);
      segmentWords.push(words);
    } else {
      segmentWords.push(null);
    }
  }

  const combined = pipeline.concat(interleave(segmentBufs, segmentGap));

  // Trim the leading silence so chapter seeks land on speech, not silence.
  // Everything inside the chapter shifts earlier by the trimmed duration;
  // mark 0 stays pinned to t=0 of the trimmed chapter (it now points to the
  // first phoneme rather than the silence that preceded it). Uses the GUARDED
  // trim, which leaves a cushion before the detected onset so a soft word-
  // initial fricative isn't mistaken for silence and clipped (see
  // leadingSilenceTrimMs in audio-pipeline.ts).
  const trimMs = mock ? asMs(0) : await pipeline.leadingSilenceTrimMs(combined);
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

  // Compute mark times relative to the trimmed chapter's start. The same gap
  // we spliced into `combined` precedes every segment after the first, so it
  // must advance `t` here too or marks would drift later than their audio.
  const localMarks: ChapterArtifact["localMarks"] = [];
  let t = asMs(0);
  for (const [i, seg] of segments.entries()) {
    if (i > 0) t = asMs(t + segmentGapMs);
    if (seg.markName) {
      localMarks.push({
        name: seg.markName,
        time: asMs(Math.max(0, t - trimMs)),
        text: seg.text,
        segmentStartInChapter: t,
        words: segmentWords[i] ?? undefined,
        // null (attribute omitted) → undefined → omitted from the manifest
        // (unchanged); "none"/""/`<id>` is carried through as the literal.
        figure: seg.figure ?? undefined,
        // Same treatment for the per-step pointer (proposal 48 §3).
        step: seg.step ?? undefined,
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
    trimMs,
  });
}

// Fail before writing any artifact if a segment came back as pure silence.
// We do this AFTER the loop (not on first hit) so one run reports every bad
// take and the author can re-roll them all in a single `--force-mark`. Exiting
// here leaves the previous (good) manifest/audio untouched — we never overwrite
// a working build with a silent one.
if (silentMarks.length > 0) {
  console.error(
    `\n${silentMarks.length} narration segment(s) synthesized to pure silence (degenerate TTS take):`,
  );
  for (const s of silentMarks) {
    console.error(
      `  ✗ mark "${s.mark}" (chapter ${s.chapter}) — ${msToSeconds(s.durationMs).toFixed(2)}s, no speech detected`,
    );
  }
  console.error(
    `\nA silent take ships as dead air and loses the segment's word-level timing. Re-roll the bad take(s):\n` +
      `  bun run generate:prod ${relative(projectRoot, resolve(htmlPath))} --force-mark=${silentMarks.map((s) => s.mark).join(",")}\n` +
      `If a re-roll keeps coming back silent, reword the line (MOSS can choke on e.g. a spaced " - ").`,
  );
  await tts.close?.();
  await cachedAligner?.close?.();
  process.exit(1);
}

// Concatenate every chapter in the working (lossless) format. The encode
// happens further below (after we've computed chapter offsets) so the MP3
// can carry in-file CHAP/CTOC frames; doing the encode at the end rather
// than per chapter avoids the brittleness of MP3 concatenation and keeps
// cumulative encoder padding to a single occurrence per file.
const fullBuf = pipeline.concat(interleave(artifacts.map((a) => a.buffer), segmentGap));

// `manifestChapters` / `manifestMarks` are the flattened entries that ship
// in the manifest JSON — distinct from the parsed-input `chapters` array
// (which holds the script text). The same chapter shows up in both, but
// with different shapes: text content in `chapters`, timing in
// `manifestChapters`. Computed BEFORE the encode so the same chapter
// times can be embedded as ID3 CHAP frames inside the MP3.
const manifestChapters: { id: string; title: string; startTime: Milliseconds; endTime: Milliseconds; parentId?: string }[] = [];
type ManifestWord = { s: number; e: number; t: Milliseconds; d: Milliseconds };
const manifestMarks: { name: string; time: Milliseconds; chapter: string; text: string; words?: ManifestWord[]; figure?: string; step?: string }[] = [];
// carry each chapter's (normalized) parent pointer into the
// manifest. Absent on flat posts, so their manifest stays byte-identical.
const parentById = new Map(chapters.map((c) => [c.id, c.parentId]));
let offset = asMs(0);
for (const [i, a] of artifacts.entries()) {
  // Same gap is spliced before every chapter after the first (see fullBuf).
  if (i > 0) offset = asMs(offset + segmentGapMs);
  const start = offset;
  const end = asMs(offset + a.duration);
  manifestChapters.push({ id: a.id, title: a.title, startTime: start, endTime: end, parentId: parentById.get(a.id) });
  for (const m of a.localMarks) {
    // Project each word's segment-WAV-relative time to master-track absolute
    // time. The shift mirrors how the mark itself is positioned:
    //   chapter offset
    //   + max(0, segmentStartInChapter + word.t - chapter.trimMs)
    // — so a word whose start would land in the trimmed-off region of seg 0
    // clamps to chapter start (it shouldn't exist in practice because the
    // trim removes silence, not speech, but the clamp is the defensive
    // contract). Words whose end falls entirely below trimMs are dropped.
    let manifestWords: ManifestWord[] | undefined;
    if (m.words && m.words.length > 0) {
      manifestWords = [];
      for (const w of m.words) {
        const rawStart = m.segmentStartInChapter + w.t - a.trimMs;
        const rawEnd = rawStart + w.d;
        if (rawEnd <= 0) continue; // word lies entirely in trimmed region
        const clampedStart = Math.max(0, rawStart);
        const masterStart = asMs(start + clampedStart);
        const adjustedDur = asMs(Math.max(0, rawEnd - clampedStart));
        manifestWords.push({ s: w.s, e: w.e, t: masterStart, d: adjustedDur });
      }
      if (manifestWords.length === 0) manifestWords = undefined;
    }
    manifestMarks.push({
      name: m.name,
      time: asMs(start + m.time),
      chapter: a.id,
      text: m.text,
      words: manifestWords,
      // Only carry `figure` when the mark set it — conditional spread keeps the
      // key ABSENT (not `figure: undefined`) for legacy posts, so their
      // serialized manifest stays byte-identical (proposal 47 §6).
      ...(m.figure !== undefined ? { figure: m.figure } : {}),
      // Same conditional spread for the per-step pointer (proposal 48 §3): an
      // unset `step` omits the key, so un-annotated marks stay byte-identical
      // and only annotated marks change — keeping the cache invariant (§2).
      ...(m.step !== undefined ? { step: m.step } : {}),
    });
  }
  offset = end;
}

// Encode with chapters baked in. The `<podcast:chapters>` JSON sidecar
// (chapters.json) is still the rich surface every modern podcast client
// reads; CHAP/CTOC in the file is redundant coverage for clients that
// look in the MP3 itself. Hierarchy degrades to a flat list here, same
// shape as the sidecar — the in-page player is where true nesting lives.
const fullDelivered = await pipeline.encode(fullBuf, {
  chapters: manifestChapters.map((c) => ({
    id: c.id,
    title: c.parentId ? `${chapters.find((p) => p.id === c.parentId)?.title ?? c.parentId} — ${c.title}` : c.title,
    startMs: c.startTime,
    endMs: c.endTime,
  })),
});

// Content-hash the final track into its filename (`full.<hash>.mp3`). This is
// the cache-busting contract for BOTH dev and prod: the URL changes whenever
// the audio changes, so a regenerated track is always fetched fresh — without
// relying on revalidation headers, which Chrome's *media* cache notoriously
// ignores for <audio> (a hard-refresh doesn't even evict it). The flip side is
// the file can be cached indefinitely while unchanged. The hash goes into the
// manifest's `audio` URL below; the player only ever reads `manifest.audio`, so
// nothing downstream needs to know the scheme.
const ext = pipeline.deliveryExt;
// Full SHA-256 of the delivered track: the first 16 hex are the cache-busting
// filename token (`full.<hash>.<ext>`); the FULL digest is persisted in the
// manifest below for the stable URL's integrity surface — `Repr-Digest`
// (RFC 9530) and `<podcast:integrity>` (W3C SRI). See shared/audioDigest.ts.
const audioDigest = new Bun.CryptoHasher("sha256").update(fullDelivered).digest("hex");
const audioHash = audioDigest.slice(0, 16);
const fullName = `full.${audioHash}${ext}`;
const fullPath = join(outDir, fullName);
await Bun.write(fullPath, fullDelivered);

// Sweep previously-emitted full tracks for this slug — the just-superseded
// hash, plus any legacy unhashed `full.<ext>`. Otherwise stale tracks pile up
// across dev iterations and (since copy-static ships every `*.mp3`) bloat the
// prod bundle with dead audio.
const staleFullRe = new RegExp(`^full\\.[0-9a-f]{16}${ext.replace(".", "\\.")}$`);
for (const f of await readdir(outDir)) {
  if (f === fullName) continue;
  if (f === `full${ext}` || staleFullRe.test(f)) {
    await unlink(join(outDir, f)).catch(() => {});
  }
}

const manifest = {
  slug,
  generatedAt: new Date().toISOString(),
  audio: `/generated/${slug}/${fullName}`,
  // Full SHA-256 hex of the audio bytes (the filename token is its 16-hex
  // prefix). Consumed at build time by feeds.ts (podcast:integrity) and
  // episode-audio.ts (the Worker's Repr-Digest map), and at request time by the
  // dev server. Hashed into the manifest name below so the content-addressing
  // invariant (filename = hash of narration-bearing fields) still holds.
  audioDigest,
  // Build provenance: what actually produced this narration. NOT folded into the
  // manifest-name hash below — the engine/voice/aligner choice is already fully
  // reflected in the hashed `audioDigest` (different engine → different bytes)
  // and `marks` (different/absent aligner → different/absent `words`), so an
  // unchanged regenerate stays byte-identical and cache-warm. The deploy gate
  // (verify-narration.ts) reads this to refuse shipping a post that wasn't built
  // with MOSS + forced alignment — e.g. the espeak-ng-and-no-`--align` artifacts
  // a bare `bun run generate` leaves behind during a test pass.
  provenance: {
    tts: ttsName,
    voice,
    aligner: alignName ?? null,
    alignLanguage: alignName ? alignLanguage : null,
    mock,
  },
  duration: offset,
  chapters: manifestChapters,
  marks: manifestMarks,
};
// Content-address the manifest filename (`manifest.<hash>.json`), mirroring the
// `full.<hash>.mp3` scheme above. The manifest is the index the player fetches
// to discover the current `full.<hash>` URL; served at a STABLE url it gets
// pinned stale by any cache that ignores revalidation (the service worker's
// cache-first store, the Cloudflare edge), and a stale manifest points at a
// swept `full.<hash>` → NotSupportedError on play. Hashing the name makes it
// immutable end-to-end. The hash covers only the narration-bearing fields (NOT
// `generatedAt`/`slug`), so an unchanged regenerate keeps the same name and
// stays cache-warm. The served HTML's `data-narration-src` is rewritten to this
// name at build time (strip-served-html.ts); the dev server resolves a bare
// `manifest.json` request to it (createDevServer.ts).
const manifestJson = JSON.stringify(manifest, null, 2);
const manifestHash = new Bun.CryptoHasher("sha256")
  .update(JSON.stringify({
    audio: manifest.audio,
    audioDigest: manifest.audioDigest,
    duration: manifest.duration,
    chapters: manifest.chapters,
    marks: manifest.marks,
  }))
  .digest("hex")
  .slice(0, 16);
const manifestName = manifestFileName(manifestHash);
await Bun.write(join(outDir, manifestName), manifestJson);

// Sweep superseded manifests (the prior hash, plus any legacy unhashed
// `manifest.json`) so stale indices don't accumulate or get shipped by
// copy-static. Mirrors the full-track sweep above.
for (const f of await readdir(outDir)) {
  if (f === manifestName) continue;
  if (f === "manifest.json" || MANIFEST_HASHED_RE.test(f)) {
    await unlink(join(outDir, f)).catch(() => {});
  }
}

// WebVTT sidecar — emit ONLY when alignment data is present, so pre-alignment
// builds (no `--align=...`) keep their previous file set byte-for-byte. The
// runtime drawer doesn't consume this file; it exists for the future
// social-media video subtitle pipeline (proposals/17 §5, §10) and for general
// interop with caption tooling. Same alignment table feeds both manifest and
// sidecar, so they can't drift.
if (hasAlignment(manifestMarks)) {
  const vtt = buildVtt({ marks: manifestMarks, duration: manifest.duration });
  await Bun.write(join(outDir, "captions.vtt"), vtt);
  console.log(`  · wrote captions.vtt (${manifestMarks.filter((m) => m.words?.length).length} aligned cue(s))`);
}

console.log(`\nWrote ${manifestChapters.length} chapter(s), ${manifestMarks.length} mark(s) to ${outDir}`);
console.log(`  full duration: ${msToSeconds(manifest.duration).toFixed(2)}s`);
for (const c of manifestChapters) {
  const count = manifestMarks.filter((m) => m.chapter === c.id).length;
  const lenSec = msToSeconds(asMs(c.endTime - c.startTime));
  console.log(`  ${c.id.padEnd(14)} ${lenSec.toFixed(2)}s   ${count} mark(s)   "${c.title}"`);
}

if (cachedAligner) {
  const { hits, misses, totalTokens, unlocatedTokens } = cachedAligner.stats;
  let line = `  Alignment cache: ${hits} hit(s), ${misses} miss(es)`;
  if (totalTokens > 0) {
    line += `, ${totalTokens} token(s) aligned`;
    if (unlocatedTokens > 0) {
      const pct = ((unlocatedTokens / totalTokens) * 100).toFixed(1);
      line += ` (${unlocatedTokens} unlocated = ${pct}%)`;
    }
  }
  console.log(line);
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

// Release the provider's long-lived resources (e.g. MOSS's worker process).
// Without this the worker keeps the event loop alive and the process hangs
// after this point instead of exiting — which also leaves the regenerate
// endpoint's `proc.exited` unresolved, so its job never reports done.
await tts.close?.();
await cachedAligner?.close?.();
