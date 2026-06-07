#!/usr/bin/env bun
// Smoke-check for the Qwen3 forced-aligner install. Mirrors how the MOSS
// setup is auditioned end-to-end via `bun run sound-test` — preflight tests
// only verify file paths exist, but this script actually invokes align.py
// against a real (audio, transcript) pair and prints the result, so the
// author can confirm the model loads, torch/CUDA is happy, and the parser
// understands align.py's output before any pipeline integration starts.
//
// Usage:
//   bun engine/generate/align-check.ts <audio.wav> "<transcript>" [--language English]
//
// Or from the presidocs repo itself:
//   QWEN3_ALIGNER_DIR=/path/to/qwen3-aligner \
//     bun generate/align-check.ts /path/to/clip.wav "the transcript"
//
// Exits 0 on success (prints a token table), non-zero on any failure with a
// pointed message (missing env, missing file, aligner crash, no tokens
// returned).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseCliArgs } from "../shared/cliArgs.ts";
import { createQwen3Aligner } from "./aligner.ts";

const USAGE =
  "usage: bun generate/align-check.ts <audio.wav> <transcript> [--language English]";

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

// `--language English` and `--language=English` are both handled by parseArgs;
// a bad/unknown flag prints USAGE and exits 2 via the shared wrapper.
const { values, positionals } = parseCliArgs(
  {
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { language: { type: "string" } },
  },
  { usage: USAGE, exitCode: 2 },
);
if (positionals.length !== 2) usage();
const language = values.language;
const [audioArg, transcript] = positionals as [string, string];
const audioPath = resolve(audioArg);
if (!existsSync(audioPath)) {
  console.error(`align-check: audio file not found: ${audioPath}`);
  process.exit(1);
}

const aligner = createQwen3Aligner({ defaultLanguage: language ?? "English" });
console.log(`align-check: invoking ${aligner.name} on ${audioPath}`);
console.log(`align-check: transcript (${transcript.length} chars): ${JSON.stringify(transcript.slice(0, 80))}${transcript.length > 80 ? "…" : ""}`);
console.log(`align-check: this may take a while on first run (model load).`);

const t0 = performance.now();
let tokens;
let failed = false;
try {
  tokens = await aligner.align(audioPath, transcript, language ? { language } : undefined);
} catch (err) {
  console.error(`align-check: FAILED — ${(err as Error).message}`);
  failed = true;
} finally {
  // align() spins up a long-lived worker child; close it so this script can
  // exit instead of hanging on the never-ending stdout read (mirrors how
  // generate.ts tears the worker down). In `finally` so it runs on both the
  // success and failure paths before we exit.
  await aligner.close?.();
}
if (failed || !tokens) process.exit(1);
const elapsedMs = Math.round(performance.now() - t0);

console.log("");
console.log(`align-check: got ${tokens.length} token${tokens.length === 1 ? "" : "s"} in ${elapsedMs}ms`);
console.log("");
console.log("  start    end      token");
console.log("  -------  -------  -----");
for (const tok of tokens) {
  const s = (tok.startMs / 1000).toFixed(3).padStart(7);
  const e = (tok.endMs / 1000).toFixed(3).padStart(7);
  console.log(`  ${s}  ${e}  ${tok.text}`);
}
console.log("");
console.log("align-check: OK");
