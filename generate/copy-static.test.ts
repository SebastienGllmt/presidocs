import { test, expect } from "bun:test";
import { shouldShipGeneratedFile } from "./copy-static.ts";

// The keep-rule that decides which `generated/<slug>/` files reach dist/.
// proposals/39: captions.vtt joins the shipped set so it can back a
// <podcast:transcript type="text/vtt">.

test("ships the manifest and word-timed transcript", () => {
  expect(shouldShipGeneratedFile("manifest.f08390bb7a2d25d7.json")).toBe(true);
  expect(shouldShipGeneratedFile("manifest.json")).toBe(true); // dev bare-name fallback
  expect(shouldShipGeneratedFile("captions.vtt")).toBe(true);
});

test("does NOT ship the full audio track (served from R2, not dist)", () => {
  // A long track can exceed Cloudflare's 25 MiB static-asset cap, so the full
  // narration is served from R2 by the Worker and uploaded by the deploy step,
  // never bundled into dist/.
  expect(shouldShipGeneratedFile("full.f2985f8c0b4fd293.mp3")).toBe(false);
  // A stray .mp3 isn't shipped either (the rule no longer matches the extension).
  expect(shouldShipGeneratedFile("clip.mp3")).toBe(false);
});

test("does NOT ship build-internal files or stray same-extension names", () => {
  // Build-internal: GC index, caches.
  expect(shouldShipGeneratedFile("cache-keys.json")).toBe(false);
  // A stray .vtt that isn't our captions sidecar must not be swept in
  // (the rule is an exact-name match, like manifest.json).
  expect(shouldShipGeneratedFile("notes.vtt")).toBe(false);
  expect(shouldShipGeneratedFile("subtitles.vtt")).toBe(false);
  // A stray .json that isn't a manifest must not be shipped.
  expect(shouldShipGeneratedFile("random.json")).toBe(false);
  // The social-media video is a LOCAL artifact — never shipped to Cloudflare
  // (large files, uploaded to platforms by hand). Neither the clip nor sidecar.
  expect(shouldShipGeneratedFile("video.f08390bb7a2d25d7.mp4")).toBe(false);
  expect(shouldShipGeneratedFile("video.f08390bb7a2d25d7.json")).toBe(false);
  // A stray .mp4 must not be swept in either.
  expect(shouldShipGeneratedFile("preview.mp4")).toBe(false);
});

test("never ships dotfiles (notably macOS AppleDouble sidecars)", () => {
  expect(shouldShipGeneratedFile("._full.f2985f8c0b4fd293.mp3")).toBe(false);
  expect(shouldShipGeneratedFile("._captions.vtt")).toBe(false);
  expect(shouldShipGeneratedFile(".DS_Store")).toBe(false);
});
