// Unit tests for isContentHashedAsset — the predicate that gates the prod
// `immutable` Cache-Control (server/createWorker.ts). The load-bearing property
// is the REJECT side: it must never match a stable-named, mutable URL, or a
// cache would pin a mutable resource forever (methodology → `immutable`).

import { describe, expect, test } from "bun:test";
import {
  isContentHashedAsset,
  BUNDLE_HASHED_RE,
  MANIFEST_HASHED_RE,
  FULL_AUDIO_HASHED_RE,
  VIDEO_HASHED_RE,
} from "./manifestFile.ts";

describe("isContentHashedAsset", () => {
  test("matches content-addressed names (hash pins the bytes)", () => {
    expect(isContentHashedAsset("manifest.0123456789abcdef.json")).toBe(true);
    expect(isContentHashedAsset("full.88ec61b30372d408.mp3")).toBe(true);
    expect(isContentHashedAsset("full.88ec61b30372d408.opus")).toBe(true);
    expect(isContentHashedAsset("video.0123456789abcdef.mp4")).toBe(true);
    expect(isContentHashedAsset("video.0123456789abcdef.webm")).toBe(true);
    expect(isContentHashedAsset("chunk-vs1e1arw.js")).toBe(true);
    expect(isContentHashedAsset("chunk-jq5ddgxc.css")).toBe(true);
  });

  test("REJECTS every stable-named mutable file (the invariant)", () => {
    // The stable shareable episode URL — mutable, must keep revalidating.
    expect(isContentHashedAsset("episode.mp3")).toBe(false);
    // Bare (legacy / dev-fallback) names — no hash token.
    expect(isContentHashedAsset("manifest.json")).toBe(false);
    expect(isContentHashedAsset("full.mp3")).toBe(false);
    // Per-post mutable sidecars + feeds + the un-hashed service worker + HTML.
    expect(isContentHashedAsset("chapters.json")).toBe(false);
    expect(isContentHashedAsset("captions.vtt")).toBe(false);
    expect(isContentHashedAsset("feed.xml")).toBe(false);
    expect(isContentHashedAsset("podcast.xml")).toBe(false);
    expect(isContentHashedAsset("sw.js")).toBe(false);
    expect(isContentHashedAsset("index.html")).toBe(false);
    expect(isContentHashedAsset("")).toBe(false);
  });

  test("rejects near-misses: wrong hash length / wrong shape", () => {
    expect(isContentHashedAsset("manifest.0123456789abcde.json")).toBe(false); // 15 hex
    expect(isContentHashedAsset("manifest.0123456789abcdefa.json")).toBe(false); // 17 hex
    expect(isContentHashedAsset("chunk-short.js")).toBe(false); // <8 hash chars
    expect(isContentHashedAsset("chunk-vs1e1arw.mjs")).toBe(false); // not js/css
    expect(isContentHashedAsset("notchunk-vs1e1arw.js")).toBe(false); // anchored prefix
    expect(isContentHashedAsset("full.NOTHEXNOTHEXNO.mp3")).toBe(false); // non-hex token
  });

  test("regexes are anchored (no substring/path matches)", () => {
    expect(BUNDLE_HASHED_RE.test("a/chunk-vs1e1arw.js")).toBe(false);
    expect(MANIFEST_HASHED_RE.test("x-manifest.0123456789abcdef.json")).toBe(false);
    expect(FULL_AUDIO_HASHED_RE.test("full.88ec61b30372d408.mp3.bak")).toBe(false);
    expect(VIDEO_HASHED_RE.test("video.0123456789abcdef.mov")).toBe(false);
  });
});
