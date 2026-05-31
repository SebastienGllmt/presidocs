// ForcedAligner registry + the Qwen3-ForcedAligner-0.6B adapter.
//
// The aligner takes (segment audio, segment text) and returns per-token
// timing — the input the drawer's word-highlight feature and the future
// social-video subtitle pipeline both consume. See proposals/17.
//
// This file MIRRORS tts-providers.ts in shape on purpose: a small interface
// describing a single capability (`align`), and one factory per backend that
// validates its install at construction time. The very first backend (Qwen3)
// is a one-shot subprocess per align; a long-lived worker (mirroring
// moss_worker.py) is a future optimization once we wire alignment into the
// build pipeline. For now the goal is "can we even talk to align.py" — a
// preflight + a smoke-check tool the author runs after install.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { asMs, type Milliseconds } from "../shared/time.ts";

// One aligned token. Granularity is the aligner's choice — for Qwen3 it's
// roughly word-level on English (sub-word BPE pieces are merged by the model
// before output), but the type stays "token" so consumers don't assume a
// particular tokenization. The drawer-side mapping to displayed words (and
// the PLS-substitution back-projection) is a separate concern; see
// proposals/17 §8.
export interface AlignedToken {
  text: string;
  startMs: Milliseconds;
  endMs: Milliseconds;
}

export interface AlignOptions {
  // BCP-47-ish language label as the underlying tool expects. Qwen3 takes
  // English/Chinese/Cantonese/French/German/Italian/Japanese/Korean/
  // Portuguese/Russian/Spanish. Defaults to the factory config's
  // defaultLanguage when unset.
  language?: string;
}

export interface ForcedAligner {
  // Stable identifier for cache keys, log lines, and the test registry check.
  name: string;
  // Binaries this aligner needs on PATH (e.g. "python", or empty if it
  // bundles its own interpreter). The preflight already validates them.
  requiredBinaries: readonly string[];
  // Align a single audio buffer against its known transcript and return per-
  // token timing. The audio path is on the local disk; the aligner reads it
  // directly (it can be a temp file written by the pipeline).
  align(audioPath: string, text: string, opts?: AlignOptions): Promise<AlignedToken[]>;
  // Release any long-lived resources. Stateless (one-shot subprocess) backends
  // omit it; a future worker-style backend uses it to shut down its child.
  close?(): Promise<void> | void;
}

export interface ForcedAlignerConfig {
  // Language fed to `align()` calls when the caller omits `opts.language`.
  // Defaults to "English" if not set.
  defaultLanguage?: string;
}

export type ForcedAlignerFactory = (config: ForcedAlignerConfig) => ForcedAligner;

// --- Qwen3 adapter -----------------------------------------------------------
//
// Wraps `python align.py <audio> <text> --language <lang> [--device <dev>]`
// from a local checkout of https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B.
//
// Install layout the factory expects (mirrors how MOSS_TTS_DIR works):
//   <QWEN3_ALIGNER_DIR>/
//     align.py                       (the entrypoint that prints token timings)
//     .venv/bin/python               (the venv interpreter; override via
//                                     QWEN3_ALIGNER_PYTHON)
//     Qwen3-ForcedAligner-0.6B/      (the model weights, downloaded once)
//
// Env overrides:
//   QWEN3_ALIGNER_DIR     — repo root (required, no portable default)
//   QWEN3_ALIGNER_PYTHON  — alternate interpreter
//   QWEN3_ALIGNER_DEVICE  — torch device string (e.g. "cpu", "cuda:0", "mps").
//                           When unset we let align.py pick its default
//                           ("cuda:0"); set "cpu" on machines without CUDA.

// align.py prints one token per line, e.g. "  0.000 -   0.300\tHash". One
// regex captures both timestamps + the token text, ignoring whatever
// whitespace align.py picked (currently a tab, but we don't depend on it).
const ALIGN_LINE = /^\s*([\d.]+)\s*-\s*([\d.]+)\s+(.+?)\s*$/;

function parseAlignerOutput(stdout: string): AlignedToken[] {
  const out: AlignedToken[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(ALIGN_LINE);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      text: m[3]!,
      // align.py prints seconds; the rest of the pipeline lives in ms.
      startMs: asMs(Math.round(start * 1000)),
      endMs: asMs(Math.round(end * 1000)),
    });
  }
  return out;
}

// Exported for tests so we don't have to round-trip through a real subprocess
// to verify the parser handles the format quirks (leading whitespace, extra
// blank lines, trailing newline, multi-digit seconds, etc.).
export const _parseAlignerOutputForTests = parseAlignerOutput;

// Locate each aligned token's character range in the substituted text by
// walking the two streams in parallel. The aligner emits tokens with text +
// timing but not offsets; we have to recover offsets to project them through
// the PLS substitution map. Strategy: skip whitespace at the cursor, then
// try an exact match, then a case-insensitive match, then fall back to a
// forward indexOf — and skip the token if even that fails.
//
// This is deliberately conservative. Real Qwen3 output may need its own
// quirks (collapsed punctuation, Unicode normalization, sub-word pieces);
// each failure mode should be added here with a dedicated test case rather
// than a heuristic. For now we cover the common case (one token per
// whitespace-separated word, matching casing).
export type TokenWithOffset = AlignedToken & { substitutedStart: number; substitutedEnd: number };

export function findTokenOffsetsInSubstituted(
  substituted: string,
  tokens: readonly AlignedToken[],
): TokenWithOffset[] {
  const out: TokenWithOffset[] = [];
  let cursor = 0;
  const lowered = substituted.toLowerCase();
  for (const tok of tokens) {
    while (cursor < substituted.length && /\s/.test(substituted[cursor]!)) cursor++;
    const want = tok.text;
    if (substituted.startsWith(want, cursor)) {
      out.push({ ...tok, substitutedStart: cursor, substitutedEnd: cursor + want.length });
      cursor += want.length;
      continue;
    }
    const wantLower = want.toLowerCase();
    if (lowered.slice(cursor, cursor + want.length) === wantLower) {
      out.push({ ...tok, substitutedStart: cursor, substitutedEnd: cursor + want.length });
      cursor += want.length;
      continue;
    }
    const found = lowered.indexOf(wantLower, cursor);
    if (found < 0) continue; // give up on this token rather than corrupt the cursor
    out.push({ ...tok, substitutedStart: found, substitutedEnd: found + want.length });
    cursor = found + want.length;
  }
  return out;
}

export function createQwen3Aligner(config: ForcedAlignerConfig = {}): ForcedAligner {
  const defaultLanguage = config.defaultLanguage ?? "English";

  const dir = process.env.QWEN3_ALIGNER_DIR;
  if (!dir) {
    throw new Error(
      "createQwen3Aligner: set QWEN3_ALIGNER_DIR to your Qwen3-ForcedAligner checkout " +
        "(e.g. QWEN3_ALIGNER_DIR=/path/to/qwen3-aligner).",
    );
  }
  const alignScript = join(dir, "align.py");
  if (!existsSync(alignScript)) {
    throw new Error(
      `createQwen3Aligner: align.py not found at ${alignScript}. ` +
        `QWEN3_ALIGNER_DIR should point at a checkout that contains align.py at its root.`,
    );
  }
  const python = process.env.QWEN3_ALIGNER_PYTHON ?? join(dir, ".venv", "bin", "python");
  if (!existsSync(python)) {
    throw new Error(
      `createQwen3Aligner: python interpreter not found at ${python}. ` +
        `Set QWEN3_ALIGNER_PYTHON to override, or create the venv in QWEN3_ALIGNER_DIR.`,
    );
  }
  // Model dir is the align.py default (it lives next to align.py). We check
  // it up-front so a missing-weights install fails here rather than after a
  // multi-second torch import.
  const modelDir = join(dir, "Qwen3-ForcedAligner-0.6B");
  if (!existsSync(modelDir)) {
    throw new Error(
      `createQwen3Aligner: model directory not found at ${modelDir}. ` +
        `Download the weights (huggingface-cli download Qwen/Qwen3-ForcedAligner-0.6B --local-dir ${modelDir}).`,
    );
  }
  const device = process.env.QWEN3_ALIGNER_DEVICE; // optional; align.py defaults to cuda:0

  return {
    name: "qwen3",
    requiredBinaries: [],
    async align(audioPath, text, opts) {
      if (!existsSync(audioPath)) {
        throw new Error(`qwen3 aligner: audio file not found at ${audioPath}`);
      }
      const language = opts?.language ?? defaultLanguage;
      // Build argv explicitly so the transcript stays one shell-safe arg even
      // when it contains spaces, quotes, or punctuation. Bun.spawn does not
      // run a shell when given an array, so no quoting is required.
      const cmd = [
        python,
        alignScript,
        audioPath,
        text,
        "--language",
        language,
        ...(device ? ["--device", device] : []),
      ];
      const proc = Bun.spawn({
        cmd,
        cwd: dir, // run from the repo so align.py's default --model path resolves
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exit !== 0) {
        throw new Error(
          `qwen3 aligner exited with status ${exit}.\n` +
            `stderr:\n${stderr.trim()}\n` +
            `stdout:\n${stdout.trim()}`,
        );
      }
      const tokens = parseAlignerOutput(stdout);
      if (tokens.length === 0) {
        throw new Error(
          `qwen3 aligner returned no token lines (text="${text.slice(0, 80)}"…).\n` +
            `stdout:\n${stdout.trim()}`,
        );
      }
      return tokens;
    },
  };
}

// Registry mirroring `ttsProviders`. Keep this list flat — the build picks an
// aligner by name (e.g. `--aligner=qwen3`) once alignment is wired into the
// pipeline. For now the single entry is enough to give callers a stable
// indirection and to give tests a registry to assert against.
export const forcedAligners = {
  qwen3: createQwen3Aligner,
} satisfies Record<string, ForcedAlignerFactory>;

export type ForcedAlignerName = keyof typeof forcedAligners;
