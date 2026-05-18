import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  computeCacheKey,
  wrapWithCache,
  type TtsCacheIdentity,
} from "./tts-cache.ts";
import { type TtsProvider } from "./tts-providers.ts";
import { type AudioFormat } from "./audio-pipeline.ts";

const monoFmt: AudioFormat = { sampleRate: 22050, channels: 1, bitsPerSample: 16 };

const baseIdentity: TtsCacheIdentity = {
  providerName: "say",
  voice: "Samantha",
  rate: 180,
  format: monoFmt,
  lexiconXml: null,
};

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "tts-cache-test-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

// Builds a fake TTS provider that returns a deterministic byte payload
// keyed off the input text, plus a hit counter so tests can assert the
// inner provider was bypassed on cache hits.
function makeFake(): TtsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    outputFormat: monoFmt,
    requiredBinaries: [],
    calls,
    async synthesize(text) {
      calls.push(text);
      return new TextEncoder().encode(`SYNTH:${text}`);
    },
  };
}

test("computeCacheKey is stable for the same inputs", () => {
  const a = computeCacheKey(baseIdentity, "hello");
  const b = computeCacheKey(baseIdentity, "hello");
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});

test("computeCacheKey differs by text", () => {
  expect(computeCacheKey(baseIdentity, "hello")).not.toBe(
    computeCacheKey(baseIdentity, "hello!"),
  );
});

test("computeCacheKey differs by voice", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey({ ...baseIdentity, voice: "Daniel" }, "x"),
  );
});

test("computeCacheKey differs by rate", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey({ ...baseIdentity, rate: 200 }, "x"),
  );
});

test("computeCacheKey differs by provider name", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey({ ...baseIdentity, providerName: "piper" }, "x"),
  );
});

test("computeCacheKey differs by output format", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey(
      { ...baseIdentity, format: { ...monoFmt, sampleRate: 44100 } },
      "x",
    ),
  );
});

test("computeCacheKey differs by lexicon", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey({ ...baseIdentity, lexiconXml: "<lexicon/>" }, "x"),
  );
});

test("wrapWithCache: miss then hit on identical input", async () => {
  const fake = makeFake();
  const cached = wrapWithCache(fake, { cacheDir, identity: baseIdentity });

  const first = await cached.synthesize("hello");
  expect(new TextDecoder().decode(first)).toBe("SYNTH:hello");
  expect(cached.stats).toEqual({ hits: 0, misses: 1 });
  expect(fake.calls).toEqual(["hello"]);

  const second = await cached.synthesize("hello");
  expect(new TextDecoder().decode(second)).toBe("SYNTH:hello");
  expect(cached.stats).toEqual({ hits: 1, misses: 1 });
  // Inner provider was NOT called again — the hit served from disk.
  expect(fake.calls).toEqual(["hello"]);
});

test("wrapWithCache: hit survives a fresh wrapper over the same cacheDir", async () => {
  const first = makeFake();
  const cachedOne = wrapWithCache(first, { cacheDir, identity: baseIdentity });
  await cachedOne.synthesize("persisted");
  expect(first.calls).toEqual(["persisted"]);

  // Simulate a second `bun run generate` over the same cache directory.
  const second = makeFake();
  const cachedTwo = wrapWithCache(second, { cacheDir, identity: baseIdentity });
  const buf = await cachedTwo.synthesize("persisted");
  expect(new TextDecoder().decode(buf)).toBe("SYNTH:persisted");
  expect(cachedTwo.stats).toEqual({ hits: 1, misses: 0 });
  expect(second.calls).toEqual([]); // inner not invoked at all
});

test("wrapWithCache: different text produces independent cache entries", async () => {
  const fake = makeFake();
  const cached = wrapWithCache(fake, { cacheDir, identity: baseIdentity });
  await cached.synthesize("a");
  await cached.synthesize("b");
  await cached.synthesize("a"); // hit
  expect(cached.stats).toEqual({ hits: 1, misses: 2 });
  expect(fake.calls).toEqual(["a", "b"]);
  expect(readdirSync(cacheDir).length).toBe(2);
});

test("wrapWithCache: identity change invalidates", async () => {
  const fake = makeFake();
  const cachedA = wrapWithCache(fake, { cacheDir, identity: baseIdentity });
  await cachedA.synthesize("hello");

  const cachedB = wrapWithCache(fake, {
    cacheDir,
    identity: { ...baseIdentity, voice: "Daniel" },
  });
  await cachedB.synthesize("hello");
  // Same text but different voice => second call must miss and re-synth.
  expect(cachedB.stats).toEqual({ hits: 0, misses: 1 });
  expect(fake.calls).toEqual(["hello", "hello"]);
});

test("wrapWithCache: passes through provider identity fields", () => {
  const fake = makeFake();
  const cached = wrapWithCache(fake, { cacheDir, identity: baseIdentity });
  expect(cached.name).toBe(fake.name);
  expect(cached.outputFormat).toEqual(fake.outputFormat);
  expect(cached.requiredBinaries).toEqual(fake.requiredBinaries);
});

test("wrapWithCache: creates cacheDir lazily on first miss", async () => {
  const subdir = join(cacheDir, "nested", "deeper");
  const fake = makeFake();
  // Two consecutive hits without invoking synthesize should not create the dir.
  const cached = wrapWithCache(fake, {
    cacheDir: subdir,
    identity: baseIdentity,
  });
  // Trigger one miss → dir must exist after.
  await cached.synthesize("trigger");
  expect(readdirSync(subdir).length).toBe(1);
});
