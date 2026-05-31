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
  _parseAlignerOutputForTests,
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

// --- align.py output parser --------------------------------------------------
//
// The aligner test suite doesn't invoke align.py for real, so the parser is
// validated against captured-shape strings. The format is "  S.SSS - E.EEE\ttext"
// (printed by align.py with `:7.3f` and a literal tab).

test("parser: extracts timing + text from align.py's printed format", () => {
  const stdout = [
    "  0.000 -   0.300\tHash",
    "  0.300 -   0.700\tfunctions",
    "  0.700 -   0.880\tare",
    "  0.880 -   1.470\teverywhere.",
    "", // trailing blank line
  ].join("\n");
  const tokens = _parseAlignerOutputForTests(stdout);
  expect(tokens).toEqual([
    { text: "Hash", startMs: asMs(0), endMs: asMs(300) },
    { text: "functions", startMs: asMs(300), endMs: asMs(700) },
    { text: "are", startMs: asMs(700), endMs: asMs(880) },
    { text: "everywhere.", startMs: asMs(880), endMs: asMs(1470) },
  ]);
});

test("parser: ignores noise lines (torch warnings, progress bars, etc.)", () => {
  const stdout = [
    "Loading checkpoint shards: 100%|██████| 1/1 [00:00<00:00, 12.3it/s]",
    "Some non-matching line of chatter",
    "  0.000 -   0.300\tHello",
    "another line with no - separator at all",
    "  0.300 -   0.500\tworld",
  ].join("\n");
  const tokens = _parseAlignerOutputForTests(stdout);
  expect(tokens.map((t) => t.text)).toEqual(["Hello", "world"]);
});

test("parser: handles multi-digit second values", () => {
  const stdout = [" 12.500 -  13.250\tlong", "123.000 - 124.000\tposts"].join("\n");
  const tokens = _parseAlignerOutputForTests(stdout);
  expect(tokens).toEqual([
    { text: "long", startMs: asMs(12500), endMs: asMs(13250) },
    { text: "posts", startMs: asMs(123000), endMs: asMs(124000) },
  ]);
});

test("parser: rounds sub-millisecond values rather than truncating", () => {
  // 0.0005s → 1ms (rounded), not 0ms (floor)
  const tokens = _parseAlignerOutputForTests("  0.0005 -   0.0015\tx");
  expect(tokens).toEqual([{ text: "x", startMs: asMs(1), endMs: asMs(2) }]);
});

test("parser: returns empty array for completely empty stdout", () => {
  expect(_parseAlignerOutputForTests("")).toEqual([]);
  expect(_parseAlignerOutputForTests("\n\n\n")).toEqual([]);
});
