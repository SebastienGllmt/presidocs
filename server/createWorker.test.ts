import { test, expect } from "bun:test";
import { staticAssetContentTypeOverride, feedAssetCorsOrigin } from "./createWorker.ts";

// The prod Worker pins a Content-Type for assets the Static Assets binding's
// extension default doesn't reliably give us. proposals/39 adds .vtt.

test("feed paths get their validator-sniffable MIME types", () => {
  expect(staticAssetContentTypeOverride("/feed.xml")).toBe("application/atom+xml; charset=utf-8");
  expect(staticAssetContentTypeOverride("/podcast.xml")).toBe("application/rss+xml; charset=utf-8");
});

test("any .vtt transcript is pinned to text/vtt (not octet-stream/plain)", () => {
  expect(staticAssetContentTypeOverride("/generated/offer-files/captions.vtt")).toBe(
    "text/vtt; charset=utf-8",
  );
  expect(staticAssetContentTypeOverride("/generated/some-other-post/captions.vtt")).toBe(
    "text/vtt; charset=utf-8",
  );
});

test("social-media video is pinned to video/mp4|webm (methodology.md → \"Video export\")", () => {
  expect(staticAssetContentTypeOverride("/generated/offer-files/video.f08390bb7a2d25d7.mp4")).toBe("video/mp4");
  expect(staticAssetContentTypeOverride("/generated/offer-files/video.f08390bb7a2d25d7.webm")).toBe("video/webm");
});

test("ordinary asset paths are left untouched (null → no override)", () => {
  expect(staticAssetContentTypeOverride("/posts/offer-files")).toBeNull();
  expect(staticAssetContentTypeOverride("/generated/offer-files/full.f2985f8c0b4fd293.mp3")).toBeNull();
  expect(staticAssetContentTypeOverride("/generated/offer-files/chapters.json")).toBeNull();
  expect(staticAssetContentTypeOverride("/sitemap.xml")).toBeNull(); // only feed .xml paths are overridden
});

// Cross-origin readability for browser-based podcast players: the feeds and the
// <podcast:chapters>/<podcast:transcript> targets get ACAO:*; nothing else does.

test("feed sidecars are CORS-readable (ACAO:*) for browser podcast players", () => {
  expect(feedAssetCorsOrigin("/feed.xml")).toBe("*");
  expect(feedAssetCorsOrigin("/podcast.xml")).toBe("*");
  expect(feedAssetCorsOrigin("/generated/offer-files/chapters.json")).toBe("*");
  expect(feedAssetCorsOrigin("/generated/offer-files/captions.vtt")).toBe("*");
});

test("CORS is NOT granted to API/identity routes, audio, or other assets", () => {
  // API/identity responses (handled before the asset fall-through; must stay same-origin).
  expect(feedAssetCorsOrigin("/comments")).toBeNull();
  expect(feedAssetCorsOrigin("/auth/me")).toBeNull();
  expect(feedAssetCorsOrigin("/post-version")).toBeNull();
  expect(feedAssetCorsOrigin("/openapi.json")).toBeNull();
  // Only `/chapters.json`, not any `*.json` — manifests stay same-origin.
  expect(feedAssetCorsOrigin("/generated/offer-files/manifest.f2985f8c0b4fd293.json")).toBeNull();
  // Audio + article HTML + sitemap: not feed sidecars.
  expect(feedAssetCorsOrigin("/generated/offer-files/full.f2985f8c0b4fd293.mp3")).toBeNull();
  expect(feedAssetCorsOrigin("/posts/offer-files")).toBeNull();
  expect(feedAssetCorsOrigin("/sitemap.xml")).toBeNull();
});
