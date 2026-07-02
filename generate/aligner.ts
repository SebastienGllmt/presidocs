// The ForcedAligner contract + the Qwen3-ForcedAligner-0.6B adapter.
//
// The aligner takes (segment audio, segment text) and returns per-token
// timing — the input the drawer's word-highlight feature and the future
// social-video subtitle pipeline both consume. See proposals/17.
//
// This file MIRRORS tts-providers.ts in shape on purpose: a small interface
// describing a single capability (`align`), and one factory per backend that
// validates its install at construction time. The Qwen3 backend drives a
// long-lived worker (generate/align_worker.py) exactly like the MOSS provider
// drives moss_worker.py: the model loads once and each segment is one request
// over a JSON stdin/stdout protocol. This replaced an earlier spawn-per-call
// design whose per-segment model reload dominated alignment time (~5.9s of
// every ~6.5s was reload; see align_worker.py and methodology.md).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { asMs, type Milliseconds } from "../shared/time.ts";
import { LongLivedJsonWorker } from "./longLivedJsonWorker.ts";

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

// --- Worker protocol ---------------------------------------------------------
//
// The Qwen3 adapter runs align_worker.py as a long-lived child (mirroring
// moss_worker.py): the model loads once and we stream one segment per request
// over newline-delimited JSON. See align_worker.py for the rationale (the
// per-segment model reload was the dominant cost) and the full protocol. We
// control both ends of the protocol now, so the worker hands back structured
// tokens — no stdout text-format to parse.
type AlignRequest = { audio: string; text: string; language: string };
type AlignToken = { start: number; end: number; text: string };
type AlignResponse = { ready?: boolean; ok?: boolean; tokens?: AlignToken[]; error?: string };

// The long-lived subprocess + newline-delimited-JSON scaffold lives in
// generate/longLivedJsonWorker.ts (shared with the MOSS TTS provider). This
// file keeps only the qwen3 protocol: the message shapes above, the spawn
// command, and the ready-handshake check below.

// Map the worker's seconds-based tokens to the pipeline's ms AlignedToken.
// Exported for tests — this is where the seconds→ms rounding lives now that
// the worker emits structured tokens instead of a printed text format.
export function alignedTokensFromWorker(tokens: readonly AlignToken[]): AlignedToken[] {
  return tokens.map((t) => ({
    text: t.text,
    startMs: asMs(Math.round(t.start * 1000)),
    endMs: asMs(Math.round(t.end * 1000)),
  }));
}
export const _alignedTokensFromWorkerForTests = alignedTokensFromWorker;

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
  // Default to CPU. With the model load amortized by the long-lived worker
  // (below), per-segment alignment compute is ~1s, so CPU costs us nothing we
  // miss — and it leaves the whole GPU to MOSS, whose ~13.4 GB already
  // over-subscribes an 11 GB card (see methodology.md "Memory requirements").
  // Override with QWEN3_ALIGNER_DEVICE=cuda:0 / mps on machines with VRAM to
  // spare or a unified-memory GPU.
  const device = process.env.QWEN3_ALIGNER_DEVICE ?? "cpu";
  const workerScript = join(import.meta.dir, "align_worker.py");

  // Lazily-spawned long-lived worker (shared scaffold): `null` until the first
  // align, started at most once, so a fully-cached build never loads the model.
  // Mirrors the MOSS provider.
  const worker = new LongLivedJsonWorker<AlignRequest, AlignResponse>({
    name: "qwen3 align worker",
    spawn: () => {
      const cmd = [python, workerScript, "--model", modelDir, "--device", device];
      const proc = Bun.spawn({
        cmd,
        cwd: dir, // run from the checkout so qwen_asr / its model resolve
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit", // model-load progress + errors stream to the terminal
      });
      console.log(`  · qwen3: loading aligner model on ${device} (first segment only)…`);
      return proc;
    },
    onReady: (ready) => {
      if (!ready.ready) {
        throw new Error(`qwen3 align worker: expected ready handshake, got ${JSON.stringify(ready)}`);
      }
    },
  });

  async function doAlign(audioPath: string, text: string, language: string) {
    const res = await worker.request({ audio: audioPath, text, language });
    if (!res.ok) {
      throw new Error(`qwen3 alignment failed: ${res.error ?? "unknown error"}`);
    }
    const tokens = alignedTokensFromWorker(res.tokens ?? []);
    if (tokens.length === 0) {
      throw new Error(`qwen3 aligner returned no tokens (text="${text.slice(0, 80)}"…).`);
    }
    return tokens;
  }

  return {
    name: "qwen3",
    requiredBinaries: [],
    async align(audioPath, text, opts) {
      if (!existsSync(audioPath)) {
        throw new Error(`qwen3 aligner: audio file not found at ${audioPath}`);
      }
      const language = opts?.language ?? defaultLanguage;
      return doAlign(audioPath, text, language);
    },
    close: () => worker.close(),
  };
}

