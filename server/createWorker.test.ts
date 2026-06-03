import { test, expect } from "bun:test";
import { staticAssetContentTypeOverride } from "./createWorker.ts";

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

test("ordinary asset paths are left untouched (null → no override)", () => {
  expect(staticAssetContentTypeOverride("/posts/offer-files")).toBeNull();
  expect(staticAssetContentTypeOverride("/generated/offer-files/full.f2985f8c0b4fd293.mp3")).toBeNull();
  expect(staticAssetContentTypeOverride("/generated/offer-files/chapters.json")).toBeNull();
  expect(staticAssetContentTypeOverride("/sitemap.xml")).toBeNull(); // only feed .xml paths are overridden
});
