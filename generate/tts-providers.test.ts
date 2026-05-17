// Tests for the TTS provider registry and the `say` adapter. The synth
// integration test is gated on `say` being on PATH so it only runs on
// macOS dev boxes — everything else is pure construction/validation
// behavior and works anywhere.

import { test, expect, spyOn } from "bun:test";
import {
  createSayProvider,
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

test("ttsProviders registry contains say", () => {
  expect(Object.keys(ttsProviders)).toContain("say");
  expect(ttsProviders.say).toBe(createSayProvider);
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
