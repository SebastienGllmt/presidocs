// Tests for the TTS provider registry and the `say` adapter. The synth
// integration test is gated on `say` being on PATH so it only runs on
// macOS dev boxes — everything else is pure construction/validation
// behavior and works anywhere.

import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSayProvider,
  createMossProvider,
  ttsProviders,
  type PlsLexicon,
  type TtsProviderConfig,
} from "./tts-providers.ts";
import { type AudioFormat } from "./audio-pipeline.ts";

const monoFmt: AudioFormat = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };

const baseConfig = (overrides: Partial<TtsProviderConfig> = {}): TtsProviderConfig => ({
  voice: "Samantha",
  rate: 180,
  format: monoFmt,
  ...overrides,
});

test("ttsProviders registry contains say and moss", () => {
  expect(Object.keys(ttsProviders)).toContain("say");
  expect(ttsProviders.say).toBe(createSayProvider);
  expect(Object.keys(ttsProviders)).toContain("moss");
  expect(ttsProviders.moss).toBe(createMossProvider);
});

test("createSayProvider accepts the supported format and reports its identity", () => {
  const provider = createSayProvider(baseConfig());
  expect(provider.name).toBe("say");
  expect(provider.outputFormat).toEqual(monoFmt);
  expect(provider.requiredBinaries).toEqual(["say"]);
});

test("createSayProvider rejects stereo input", () => {
  expect(() =>
    createSayProvider(baseConfig({ format: { ...monoFmt, channels: 2 } })),
  ).toThrow(/only mono 16-bit PCM is supported/);
});

test("createSayProvider rejects non-16-bit depth", () => {
  expect(() =>
    createSayProvider(baseConfig({ format: { ...monoFmt, bitsPerSample: 24 } })),
  ).toThrow(/only mono 16-bit PCM is supported/);
});

test("createSayProvider warns when a PLS lexicon is passed (`say` has no PLS support)", () => {
  const lexicon: PlsLexicon = {
    sources: ["posts/common-terms.pls"],
    xml: "<?xml version=\"1.0\"?><lexicon/>",
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    createSayProvider(baseConfig({ lexicon }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/ignoring PLS lexicon from posts\/common-terms\.pls/);
  } finally {
    warn.mockRestore();
  }
});

test("createSayProvider stays quiet when no lexicon is passed", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    createSayProvider(baseConfig());
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

// Integration: actually run `say` and verify the output WAV matches the
// declared format. Gated on `say` being present so this is a no-op on
// Linux/CI.
const hasSay = Bun.which("say") !== null;
test.skipIf(!hasSay)(
  "say.synthesize: returns a WAV in the declared format",
  async () => {
    const provider = createSayProvider(baseConfig());
    const buf = await provider.synthesize("hello");
    // RIFF / WAVE magic
    expect(String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!)).toBe("RIFF");
    expect(String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!)).toBe("WAVE");
    // fmt body starts at byte 20 (after RIFF preamble + "fmt " + size).
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint16(22, true)).toBe(monoFmt.channels);
    expect(view.getUint32(24, true)).toBe(monoFmt.sampleRate);
    expect(view.getUint16(34, true)).toBe(monoFmt.bitsPerSample);
  },
);

test.skipIf(!hasSay)(
  "say.synthesize: empty / whitespace input still returns a valid WAV",
  async () => {
    const provider = createSayProvider(baseConfig());
    const buf = await provider.synthesize("   ");
    expect(String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!)).toBe("RIFF");
    expect(buf.byteLength).toBeGreaterThan(44); // header + at least some samples
  },
);

// --- MOSS adapter (factory-only) ---------------------------------------------
//
// These exercise the construction-time validation, which is all that runs
// before the first `synthesize`. The worker (and the multi-GB model load) is
// spawned lazily, so none of this touches Python — it's safe on any platform.
// Each test owns its MOSS_TTS_DIR / MOSS_TTS_PYTHON env so they don't bleed.

// A throwaway MOSS_TTS_DIR with a stand-in venv python and a reference clip,
// enough to get the factory past its existence checks.
function fakeMossEnv(): { dir: string; reference: string } {
  const dir = mkdtempSync(join(tmpdir(), "moss-env-"));
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
  writeFileSync(join(dir, ".venv", "bin", "python"), "#!/bin/sh\n");
  const reference = join(dir, "ref.wav");
  writeFileSync(reference, "RIFF"); // contents irrelevant; only existence is checked
  return { dir, reference };
}

function withMossEnv<T>(
  env: { MOSS_TTS_DIR?: string; MOSS_TTS_PYTHON?: string },
  fn: () => T,
): T {
  const saved = {
    MOSS_TTS_DIR: process.env.MOSS_TTS_DIR,
    MOSS_TTS_PYTHON: process.env.MOSS_TTS_PYTHON,
  };
  delete process.env.MOSS_TTS_DIR;
  delete process.env.MOSS_TTS_PYTHON;
  if (env.MOSS_TTS_DIR !== undefined) process.env.MOSS_TTS_DIR = env.MOSS_TTS_DIR;
  if (env.MOSS_TTS_PYTHON !== undefined) process.env.MOSS_TTS_PYTHON = env.MOSS_TTS_PYTHON;
  try {
    return fn();
  } finally {
    for (const k of ["MOSS_TTS_DIR", "MOSS_TTS_PYTHON"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const mossConfig = (overrides: Partial<TtsProviderConfig> = {}): TtsProviderConfig => ({
  voice: "Samantha", // overridden per-test with a real reference path
  rate: 180,
  format: monoFmt,
  ...overrides,
});

test("createMossProvider rejects stereo input (before any env lookup)", () => {
  withMossEnv({}, () => {
    expect(() =>
      createMossProvider(mossConfig({ format: { ...monoFmt, channels: 2 } })),
    ).toThrow(/only mono 16-bit PCM is supported/);
  });
});

test("createMossProvider errors clearly when MOSS_TTS_DIR is unset", () => {
  withMossEnv({}, () => {
    expect(() => createMossProvider(mossConfig())).toThrow(/set MOSS_TTS_DIR/);
  });
});

test("createMossProvider errors when the venv python is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "moss-nopy-"));
  withMossEnv({ MOSS_TTS_DIR: dir }, () => {
    expect(() => createMossProvider(mossConfig())).toThrow(/python interpreter not found/);
  });
});

test("createMossProvider errors when --voice isn't a real .wav reference", () => {
  const { dir } = fakeMossEnv();
  withMossEnv({ MOSS_TTS_DIR: dir }, () => {
    // default "Samantha" is a `say` voice name, not a reference clip
    expect(() => createMossProvider(mossConfig())).toThrow(/must be a path to a voice-clone reference/);
  });
});

test("createMossProvider accepts a real reference and reports its identity", () => {
  const { dir, reference } = fakeMossEnv();
  withMossEnv({ MOSS_TTS_DIR: dir }, () => {
    const provider = createMossProvider(mossConfig({ voice: reference }));
    expect(provider.name).toBe("moss");
    expect(provider.outputFormat).toEqual(monoFmt);
    expect(provider.requiredBinaries).toEqual(["ffmpeg"]);
  });
});

test("createMossProvider rejects an invalid MOSS_TTS_CONTINUATION mode", () => {
  const { dir, reference } = fakeMossEnv();
  const saved = process.env.MOSS_TTS_CONTINUATION;
  process.env.MOSS_TTS_CONTINUATION = "bogus";
  try {
    withMossEnv({ MOSS_TTS_DIR: dir }, () => {
      expect(() => createMossProvider(mossConfig({ voice: reference }))).toThrow(
        /MOSS_TTS_CONTINUATION must be instruction\|acoustic\|off/,
      );
    });
  } finally {
    if (saved === undefined) delete process.env.MOSS_TTS_CONTINUATION;
    else process.env.MOSS_TTS_CONTINUATION = saved;
  }
});

test("createMossProvider accepts each valid MOSS_TTS_CONTINUATION mode", () => {
  const { dir, reference } = fakeMossEnv();
  const saved = process.env.MOSS_TTS_CONTINUATION;
  try {
    for (const mode of ["instruction", "acoustic", "off"]) {
      process.env.MOSS_TTS_CONTINUATION = mode;
      withMossEnv({ MOSS_TTS_DIR: dir }, () => {
        expect(createMossProvider(mossConfig({ voice: reference })).name).toBe("moss");
      });
    }
  } finally {
    if (saved === undefined) delete process.env.MOSS_TTS_CONTINUATION;
    else process.env.MOSS_TTS_CONTINUATION = saved;
  }
});

test("createMossProvider warns when a PLS lexicon is passed (MOSS has no PLS support)", () => {
  const { dir, reference } = fakeMossEnv();
  const lexicon: PlsLexicon = {
    sources: ["posts/common-terms.pls"],
    xml: "<?xml version=\"1.0\"?><lexicon/>",
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    withMossEnv({ MOSS_TTS_DIR: dir }, () => {
      createMossProvider(mossConfig({ voice: reference, lexicon }));
    });
    expect(warn.mock.calls.some((c) => /ignoring PLS lexicon/.test(String(c[0])))).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("createMossProvider warns that --rate is ignored when non-default", () => {
  const { dir, reference } = fakeMossEnv();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    withMossEnv({ MOSS_TTS_DIR: dir }, () => {
      createMossProvider(mossConfig({ voice: reference, rate: 200 }));
    });
    expect(warn.mock.calls.some((c) => /ignoring --rate=200/.test(String(c[0])))).toBe(true);
  } finally {
    warn.mockRestore();
  }
});
