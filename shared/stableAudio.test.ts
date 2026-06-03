// Unit tests for the stable shareable-audio helpers (shared/stableAudio.ts).
// These lock the spec-critical behavior that both servers depend on: ETag
// extraction (strong validator = content hash), conditional-request matching,
// and the If-Range range-gating that prevents cross-version stitching.
// See proposals/32-stable-shareable-audio-url.md §7/§9.

import { describe, expect, test } from "bun:test";
import {
  audioEtag,
  ifNoneMatchSatisfied,
  rangeHonored,
  stableAudioHeaders,
  stableEpisodePath,
  stableEpisodeSlug,
} from "./stableAudio.ts";

describe("stableEpisodeSlug", () => {
  test("matches a stable episode path and captures the slug", () => {
    expect(stableEpisodeSlug("/generated/offer-files/episode.mp3")).toBe("offer-files");
    expect(stableEpisodeSlug("/generated/a-b-c/episode.m4a")).toBe("a-b-c");
  });

  test("rejects the hashed file, the manifest, and unrelated paths", () => {
    expect(stableEpisodeSlug("/generated/offer-files/full.88ec61b30372d408.mp3")).toBeNull();
    expect(stableEpisodeSlug("/generated/offer-files/manifest.json")).toBeNull();
    expect(stableEpisodeSlug("/generated/offer-files/sub/episode.mp3")).toBeNull();
    expect(stableEpisodeSlug("/posts/offer-files")).toBeNull();
  });
});

describe("audioEtag", () => {
  test("extracts a strong ETag from a content-addressed audio path", () => {
    expect(audioEtag("/generated/offer-files/full.88ec61b30372d408.mp3")).toBe(
      '"88ec61b30372d408"',
    );
    // bare filename form (dev resolves to this)
    expect(audioEtag("full.88ec61b30372d408.mp3")).toBe('"88ec61b30372d408"');
  });

  test("is null for a legacy bare name with no hash", () => {
    expect(audioEtag("/generated/offer-files/full.mp3")).toBeNull();
  });
});

describe("stableEpisodePath (the one shared derivation: copy button + feeds)", () => {
  test("maps the hashed full-track path to the stable episode path", () => {
    expect(stableEpisodePath("/generated/offer-files/full.88ec61b30372d408.mp3")).toBe(
      "/generated/offer-files/episode.mp3",
    );
    // preserves a non-mp3 extension
    expect(stableEpisodePath("/generated/x/full.0123456789abcdef.m4a")).toBe(
      "/generated/x/episode.m4a",
    );
    // legacy bare full.<ext> (no hash)
    expect(stableEpisodePath("/generated/x/full.mp3")).toBe("/generated/x/episode.mp3");
  });

  test("round-trips with stableEpisodeSlug", () => {
    const stable = stableEpisodePath("/generated/offer-files/full.88ec61b30372d408.mp3");
    expect(stableEpisodeSlug(stable)).toBe("offer-files");
  });

  test("leaves an unrecognized path unchanged (graceful fallback)", () => {
    expect(stableEpisodePath("/generated/x/something-else.mp3")).toBe(
      "/generated/x/something-else.mp3",
    );
  });
});

describe("stableAudioHeaders", () => {
  test("is revalidating, never immutable, and tiers the CDN policy", () => {
    const h = stableAudioHeaders('"88ec61b30372d408"');
    expect(h["Cache-Control"]).toBe("no-cache");
    expect(h["CDN-Cache-Control"]).toBe("max-age=60, stale-while-revalidate=604800");
    expect(h["Accept-Ranges"]).toBe("bytes");
    expect(h["ETag"]).toBe('"88ec61b30372d408"');
    // The two directives the proposal forbids on the stable URL must be absent.
    expect(JSON.stringify(h)).not.toContain("immutable");
    expect(JSON.stringify(h)).not.toContain("must-revalidate");
  });

  test("omits ETag when there's no hash to validate against", () => {
    expect(stableAudioHeaders(null).ETag).toBeUndefined();
  });
});

describe("ifNoneMatchSatisfied (→ 304)", () => {
  const etag = '"88ec61b30372d408"';
  test("matches exact, wildcard, weak form, and list membership", () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfied("*", etag)).toBe(true);
    expect(ifNoneMatchSatisfied('W/"88ec61b30372d408"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"other", "88ec61b30372d408"', etag)).toBe(true);
  });
  test("no match → no 304", () => {
    expect(ifNoneMatchSatisfied('"deadbeefdeadbeef"', etag)).toBe(false);
    expect(ifNoneMatchSatisfied(null, etag)).toBe(false);
    expect(ifNoneMatchSatisfied(etag, null)).toBe(false);
  });
});

describe("rangeHonored (If-Range guard)", () => {
  const etag = '"88ec61b30372d408"';
  test("no If-Range → honor the Range", () => {
    expect(rangeHonored(null, etag)).toBe(true);
  });
  test("If-Range exact strong match → honor", () => {
    expect(rangeHonored(etag, etag)).toBe(true);
  });
  test("If-Range mismatch or unvalidatable → ignore Range (serve full 200)", () => {
    expect(rangeHonored('"deadbeefdeadbeef"', etag)).toBe(false);
    expect(rangeHonored('W/"88ec61b30372d408"', etag)).toBe(false); // weak: not valid for If-Range
    expect(rangeHonored("Wed, 21 Oct 2015 07:28:00 GMT", etag)).toBe(false); // date form, no Last-Modified
    expect(rangeHonored(etag, null)).toBe(false); // no strong validator available
  });
});
