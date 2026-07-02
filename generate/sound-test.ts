// Offline synthesis for the dev-only sound-test page (see shared/soundTest.ts
// and server/dev/soundTest.dev.ts). Renders one short WAV per lexeme in a PLS
// lexicon into `generated/.sound-test/`, so an author can audition how the
// production voice reads each respelling — and re-roll one when MOSS mangles it.
//
// Usage:
//   bun run generate/sound-test.ts posts/common-terms.pls --index=3   # one lexeme
//   bun run generate/sound-test.ts posts/common-terms.pls --all       # every missing/stale lexeme
//   bun run generate/sound-test.ts posts/common-terms.pls --all --force  # re-roll all
//
// Defaults to `--tts=moss` (the production voice; this whole feature exists to
// catch MOSS's probabilistic mispronunciations). The voice clip is required:
// pass `--voice=<path>` explicitly, or — on a single-author blog — let it
// auto-resolve from the one author's `authors/<email>.wav`. The dev-server
// endpoint always passes `--voice=` (resolved from the session user's
// `authors/<email>.wav`), so manual auto-resolution is just a CLI convenience.
// Like the post pipeline it loads the multi-GB model once per run, so `--all`
// synthesizes the whole lexicon in a single model load; a single `--index`
// re-roll is one segment.
//
// This is offline/localhost-only and is spawned by the dev server's
// `/dev/sound-test/regenerate` endpoint (the trusted-localhost carve-out from
// the "dumb edge server" rule); it is never part of the prod Worker.

import { mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { leadingSilenceTrimMs, trimLeadingMs, type AudioFormat } from "./audio-pipeline.ts";
import { ttsProviders } from "./tts-providers.ts";
import { parseLexicon } from "./pronunciation.ts";
import { SOUND_TEST_DIR, audioFileName, synthTextFor, type SoundTestVoice } from "../shared/soundTest.ts";
import { resolveAuthorVoice } from "../shared/voiceResolution.ts";
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

const plsPath = positional[0];
if (!plsPath) {
  console.error("usage: bun run generate/sound-test.ts <lexicon.pls> [--tts=moss] [--index=N | --all] [--force]");
  process.exit(1);
}

const ttsName = flags.get("tts") ?? "moss";
// Voice: explicit --voice wins; otherwise, for moss, auto-resolve once we know
// the content root (below) — but only when the blog has a single author. The
// dev-server endpoints always pass --voice explicitly (resolved from the
// session user); auto-resolution is purely a manual-CLI convenience for the
// common single-author blog.
let voice = flags.get("voice") ?? (ttsName === "say" ? "Samantha" : "");
const rate = Number(flags.get("rate") ?? "180");
// MOSS interprets IPA (`/.../`); `say` reads the slashes literally. The current
// common-terms.pls is alias-only, but honor IPA entries on an IPA engine so the
// auditioned audio matches what the post pipeline would synthesize.
const ipaSupported = ttsName !== "say";

const format: AudioFormat = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };

const all = flags.has("all");
const force = flags.has("force");
const index = flags.has("index") ? Number(flags.get("index")) : null;
if (!all && index === null) {
  console.error("specify --all or --index=N");
  process.exit(1);
}

const lexXml = await Bun.file(plsPath).text();
const entries = parseLexicon(lexXml);
if (entries.length === 0) {
  console.error(`No <lexeme> entries found in ${plsPath}`);
  process.exit(1);
}

const contentRoot = resolve(dirname(plsPath), "..");
const outDir = join(contentRoot, "generated", SOUND_TEST_DIR);
await mkdir(outDir, { recursive: true });

// Manual-CLI voice auto-resolution: if `--voice` wasn't passed and we're using
// MOSS, scan `posts/` for distinct author-emails — if there's exactly one,
// resolve `authors/<email>.wav`. For multi-author blogs we require --voice to
// be explicit (the page does this by passing the session user's resolved
// clip); guessing one author over another would silently audition in the
// wrong voice. No env-var fallback (the convention is per-author files).
if (ttsName === "moss" && !voice) {
  const postsDir = dirname(plsPath);
  const files = await readdir(postsDir).catch(() => []);
  const emails = new Set<string>();
  for (const f of files) {
    if (!/\.html?$/i.test(f)) continue;
    const html = await Bun.file(join(postsDir, f)).text();
    const e = parseAuthorEmailFromHtml(html);
    if (e) emails.add(e.trim().toLowerCase());
  }
  if (emails.size === 0) {
    console.error(
      `--tts=moss needs a voice. No author-email found in any ${postsDir}/*.html; pass --voice=<path>.`,
    );
    process.exit(1);
  }
  if (emails.size > 1) {
    console.error(
      `--tts=moss on a multi-author blog needs --voice=<path> (found authors: ${[...emails].join(", ")}).`,
    );
    process.exit(1);
  }
  const [only] = [...emails];
  const r = resolveAuthorVoice(contentRoot, only!);
  if (!r.ok) {
    console.error(`Cannot resolve MOSS voice clip for ${only}: ${r.reason}.`);
    process.exit(1);
  }
  voice = r.clipPath;
}

const ttsFactory = ttsProviders[ttsName];
if (!ttsFactory) {
  console.error(`Unknown --tts=${ttsName}. Available: ${Object.keys(ttsProviders).join(", ")}`);
  process.exit(1);
}

// No lexicon handed to the provider: we synthesize the already-substituted
// pronunciation text ourselves (see shared/soundTest.ts), so the engine just
// reads it. This is what makes the audio's identity track the respelling.
const tts = ttsFactory({ voice, rate, format });
const voiceIdent: SoundTestVoice = {
  providerName: tts.name,
  voiceId: tts.cacheVoiceId ?? voice,
  format,
};

// Trim leading silence with the GUARDED trim (see leadingSilenceTrimMs): it
// leaves a cushion before the detected speech onset, so a soft word-initial
// fricative (the "s" of "Swap", "shah") isn't mistaken for silence and clipped —
// the bug that made every S-term lose its start. For a one-word clip the lead is
// almost always within the guard, so in practice nothing is trimmed; the guard
// is what makes that safe. MOSS's trailing artifact is trimmed inside the
// provider. ffmpeg (used by the trim) is required regardless of the engine.
for (const bin of new Set(["ffmpeg", ...tts.requiredBinaries])) {
  if (!Bun.which(bin)) {
    console.error(`Required binary "${bin}" not found on PATH.`);
    process.exit(1);
  }
}

// Resolve which entries to render, and the full set of CURRENT valid filenames
// (used both to skip already-rendered ones and to GC stale audio on --all).
type Target = { i: number; synthText: string; file: string };
const targets: Target[] = [];
const validFiles = new Set<string>();
entries.forEach((entry, i) => {
  const synthText = synthTextFor(entry, ipaSupported);
  if (!synthText) return; // nothing usable for this engine
  const file = audioFileName(voiceIdent, synthText);
  validFiles.add(file);
  if (all || i === index) targets.push({ i, synthText, file });
});

if (index !== null && targets.length === 0) {
  console.error(`No auditionable lexeme at --index=${index} (out of range or no pronunciation).`);
  process.exit(1);
}

const existing = new Set(await readdir(outDir).catch(() => []));

let rendered = 0;
for (const { i, synthText, file } of targets) {
  // --all renders only what's missing (unless --force); a targeted --index
  // always re-rolls (that's the "this take was bad, try again" button).
  if (all && !force && existing.has(file)) continue;
  console.log(`[${i}] synthesizing ${JSON.stringify(synthText)} → ${file}`);
  let buf = await tts.synthesize(synthText, { continuesPrevious: false });
  buf = await trimLeadingMs(buf, await leadingSilenceTrimMs(buf));
  await Bun.write(join(outDir, file), buf);
  rendered++;
}

// On a full sweep, delete audio that no current lexeme maps to anymore — the
// leftovers from edited/removed aliases. Skipped for a single --index so a
// targeted re-roll never touches other lexemes' files.
if (all) {
  for (const f of existing) {
    if (f.endsWith(".wav") && !validFiles.has(f)) {
      await unlink(join(outDir, f)).catch(() => {});
    }
  }
}

console.log(`Done: ${rendered} clip(s) rendered to ${outDir}`);

// MOSS holds a long-lived worker; without close() the process hangs (and the
// regenerate endpoint's job would never report done). No-op for `say`.
await tts.close?.();
