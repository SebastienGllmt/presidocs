import { test, expect } from "bun:test";
import { audioFileName, synthTextFor, type SoundTestVoice } from "./soundTest.ts";
import type { LexEntry } from "../generate/pronunciation.ts";

const voice: SoundTestVoice = {
  providerName: "moss",
  voiceId: "moss-clip:abc",
  format: { sampleRate: 22050, channels: 1, bitsPerSample: 16 },
};

test("synthTextFor prefers alias on a non-IPA engine", () => {
  const e: LexEntry = { graphemes: ["SHA-256"], alias: "shah two fifty six" };
  expect(synthTextFor(e, false)).toBe("shah two fifty six");
});

test("synthTextFor wraps IPA only when the engine supports it", () => {
  const e: LexEntry = { graphemes: ["x"], alias: "ess", ipa: "ɛks" };
  expect(synthTextFor(e, true)).toBe("/ɛks/");
  expect(synthTextFor(e, false)).toBe("ess");
});

test("synthTextFor returns null when there's nothing usable", () => {
  expect(synthTextFor({ graphemes: ["x"] }, true)).toBeNull();
  // IPA-only entry on a non-IPA engine has no usable pronunciation.
  expect(synthTextFor({ graphemes: ["x"], ipa: "ɛks" }, false)).toBeNull();
});

test("audioFileName is a stable .wav name and tracks the synth text", () => {
  const a = audioFileName(voice, "shah two fifty six");
  const b = audioFileName(voice, "shah two fifty six");
  const c = audioFileName(voice, "shah two five six"); // edited respelling
  expect(a).toMatch(/^[0-9a-f]{32}\.wav$/);
  expect(a).toBe(b); // deterministic → editing nothing keeps the same file
  expect(a).not.toBe(c); // editing the alias → new file → old audio is "stale"
});

test("audioFileName tracks the voice identity", () => {
  const other: SoundTestVoice = { ...voice, voiceId: "moss-clip:def" };
  expect(audioFileName(voice, "hello")).not.toBe(audioFileName(other, "hello"));
});
