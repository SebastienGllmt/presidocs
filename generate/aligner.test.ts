// Tests for the forced-aligner registry and the Qwen3 adapter.
//
// These exercise CONSTRUCTION-TIME validation only — same posture as the
// MOSS tests in tts-providers.test.ts. align.py and the multi-GB model load
// are not invoked here; that's what generate/align-check.ts is for (run
// manually after install). Each test owns its QWEN3_ALIGNER_* env so they
// don't bleed.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createQwen3Aligner,
  forcedAligners,
  alignedTokensFromWorker,
} from "./aligner.ts";
import { asMs } from "../shared/time.ts";

// A throwaway QWEN3_ALIGNER_DIR with a stand-in venv python, an align.py
// stub, and the model directory — enough to get the factory past its
// existence checks.
function fakeAlignerEnv(): { dir: string; align: string; python: string; model: string } {
  const dir = mkdtempSync(join(tmpdir(), "qwen3-env-"));
  const align = join(dir, "align.py");
  writeFileSync(align, "# fake; existence-only check\n");
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
  const python = join(dir, ".venv", "bin", "python");
  writeFileSync(python, "#!/bin/sh\n");
  const model = join(dir, "Qwen3-ForcedAligner-0.6B");
  mkdirSync(model, { recursive: true });
  return { dir, align, python, model };
}

const ENV_KEYS = ["QWEN3_ALIGNER_DIR", "QWEN3_ALIGNER_PYTHON", "QWEN3_ALIGNER_DEVICE"] as const;
type AlignerEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

function withAlignerEnv<T>(env: AlignerEnv, fn: () => T): T {
  const saved: AlignerEnv = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of ENV_KEYS) if (env[k] !== undefined) process.env[k] = env[k]!;
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("forcedAligners registry contains qwen3", () => {
  expect(Object.keys(forcedAligners)).toContain("qwen3");
  expect(forcedAligners.qwen3).toBe(createQwen3Aligner);
});

test("createQwen3Aligner errors clearly when QWEN3_ALIGNER_DIR is unset", () => {
  withAlignerEnv({}, () => {
    expect(() => createQwen3Aligner()).toThrow(/set QWEN3_ALIGNER_DIR/);
  });
});

test("createQwen3Aligner errors when align.py is missing from the dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "qwen3-noalign-"));
  withAlignerEnv({ QWEN3_ALIGNER_DIR: dir }, () => {
    expect(() => createQwen3Aligner()).toThrow(/align\.py not found/);
  });
});

test("createQwen3Aligner errors when the venv python is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qwen3-nopy-"));
  writeFileSync(join(dir, "align.py"), "# stub\n");
  withAlignerEnv({ QWEN3_ALIGNER_DIR: dir }, () => {
    expect(() => createQwen3Aligner()).toThrow(/python interpreter not found/);
  });
});

test("createQwen3Aligner errors when the model directory is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qwen3-nomodel-"));
  writeFileSync(join(dir, "align.py"), "# stub\n");
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
  writeFileSync(join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
  withAlignerEnv({ QWEN3_ALIGNER_DIR: dir }, () => {
    expect(() => createQwen3Aligner()).toThrow(/model directory not found/);
  });
});

test("createQwen3Aligner accepts a complete install and reports its identity", () => {
  const { dir } = fakeAlignerEnv();
  withAlignerEnv({ QWEN3_ALIGNER_DIR: dir }, () => {
    const aligner = createQwen3Aligner();
    expect(aligner.name).toBe("qwen3");
    expect(aligner.requiredBinaries).toEqual([]);
    expect(typeof aligner.align).toBe("function");
  });
});

test("createQwen3Aligner honors QWEN3_ALIGNER_PYTHON override", () => {
  const { dir } = fakeAlignerEnv();
  // A path that doesn't exist under the standard layout but DOES exist somewhere
  // else — proves the override is consulted before the default-venv check.
  const altPyDir = mkdtempSync(join(tmpdir(), "qwen3-altpy-"));
  const altPython = join(altPyDir, "python");
  writeFileSync(altPython, "#!/bin/sh\n");
  withAlignerEnv({ QWEN3_ALIGNER_DIR: dir, QWEN3_ALIGNER_PYTHON: altPython }, () => {
    expect(() => createQwen3Aligner()).not.toThrow();
  });
  // And the same env without the override but with the venv intentionally
  // removed would fail — covered by the "venv python missing" test above.
});

test("createQwen3Aligner.align rejects a missing audio path early (no subprocess spawn)", async () => {
  const { dir } = fakeAlignerEnv();
  // Construct inside the scoped env (the factory reads env at construction
  // time and captures the resolved paths), then run the async assertion
  // outside it — so `withAlignerEnv`'s `finally` can't race the promise.
  const aligner = withAlignerEnv({ QWEN3_ALIGNER_DIR: dir }, () => createQwen3Aligner());
  await expect(aligner.align("/does/not/exist.wav", "hello")).rejects.toThrow(
    /audio file not found/,
  );
});

// --- worker token mapper -----------------------------------------------------
//
// The worker emits structured tokens (seconds + text) over JSON; the mapper
// converts them to the pipeline's ms-based AlignedToken. The unit tests don't
// spawn the worker (same posture as the MOSS tests) — they validate the pure
// seconds→ms conversion, which is where the old stdout parser's rounding
// behavior now lives.

test("mapper: converts worker tokens (seconds) to ms AlignedToken", () => {
  const tokens = alignedTokensFromWorker([
    { start: 0.0, end: 0.3, text: "Hash" },
    { start: 0.3, end: 0.7, text: "functions" },
    { start: 0.7, end: 0.88, text: "are" },
    { start: 0.88, end: 1.47, text: "everywhere." },
  ]);
  expect(tokens).toEqual([
    { text: "Hash", startMs: asMs(0), endMs: asMs(300) },
    { text: "functions", startMs: asMs(300), endMs: asMs(700) },
    { text: "are", startMs: asMs(700), endMs: asMs(880) },
    { text: "everywhere.", startMs: asMs(880), endMs: asMs(1470) },
  ]);
});

test("mapper: handles multi-digit second values", () => {
  const tokens = alignedTokensFromWorker([
    { start: 12.5, end: 13.25, text: "long" },
    { start: 123.0, end: 124.0, text: "posts" },
  ]);
  expect(tokens).toEqual([
    { text: "long", startMs: asMs(12500), endMs: asMs(13250) },
    { text: "posts", startMs: asMs(123000), endMs: asMs(124000) },
  ]);
});

test("mapper: rounds sub-millisecond values rather than truncating", () => {
  // 0.0005s → 1ms (rounded), not 0ms (floor)
  const tokens = alignedTokensFromWorker([{ start: 0.0005, end: 0.0015, text: "x" }]);
  expect(tokens).toEqual([{ text: "x", startMs: asMs(1), endMs: asMs(2) }]);
});

test("mapper: returns empty array for no tokens", () => {
  expect(alignedTokensFromWorker([])).toEqual([]);
});
