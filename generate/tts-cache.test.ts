import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  computeCacheKey,
  computeTextHash,
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
  localLexiconXml: null,
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

test("computeCacheKey differs by local lexicon", () => {
  expect(computeCacheKey(baseIdentity, "x")).not.toBe(
    computeCacheKey({ ...baseIdentity, localLexiconXml: "<lexicon/>" }, "x"),
  );
});

test("computeTextHash depends only on text", () => {
  // Same text, different identity → same text-hash. This is the property
  // that lets GC reap all voice/rate variants of a removed sentence in
  // one shot.
  const a = computeTextHash("hello");
  const b = computeTextHash("hello");
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(computeTextHash("hello")).not.toBe(computeTextHash("hello!"));
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

test("wrapWithCache: tracks every text-hash it touches (hits and misses)", async () => {
  const fake = makeFake();
  const cached = wrapWithCache(fake, { cacheDir, identity: baseIdentity });
  await cached.synthesize("alpha");
  await cached.synthesize("beta");
  await cached.synthesize("alpha"); // hit — should not double-count or skip
  // Two distinct texts → two distinct text-hashes, regardless of hit/miss.
  expect(cached.textHashes.size).toBe(2);
  expect(cached.textHashes.has(computeTextHash("alpha"))).toBe(true);
  expect(cached.textHashes.has(computeTextHash("beta"))).toBe(true);
});

test("wrapWithCache: same text + different identity share one bucket", async () => {
  // Different voice produces a different full-hash file, but both live
  // inside the same text-hash bucket. That's what lets removed sentences
  // GC every variant at once.
  const fake = makeFake();
  const cachedA = wrapWithCache(fake, { cacheDir, identity: baseIdentity });
  await cachedA.synthesize("hello");
  const cachedB = wrapWithCache(fake, {
    cacheDir,
    identity: { ...baseIdentity, voice: "Daniel" },
  });
  await cachedB.synthesize("hello");

  // Both wrappers report the same single text-hash.
  expect(cachedA.textHashes).toEqual(cachedB.textHashes);
  expect(cachedA.textHashes.size).toBe(1);

  // On disk: one bucket dir, two full-hash files inside.
  const buckets = readdirSync(cacheDir);
  expect(buckets.length).toBe(1);
  expect(buckets[0]).toBe(computeTextHash("hello"));
  expect(readdirSync(join(cacheDir, buckets[0]!)).length).toBe(2);
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
