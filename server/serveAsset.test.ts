// Unit tests for the unified serving engine (server/serveAsset.ts). This is the
// pure surface both createWorker.ts and createDevServer.ts delegate their
// Range/206/416/If-Range/304 orchestration to; Phase 5b extends this with
// fast-check property tests against the same functions.
//
// The load-bearing case is the If-Range-"ignore" regression guard (row 11 of
// proposals/refactor/phase3/3a-serving-unification.md §1): a hashed/immutable
// asset must still honor a ranged seek even when the request carries an
// If-Range that doesn't match — otherwise every browser media re-seek turns
// into a full multi-MB 200.

import { test, expect } from "bun:test";
import {
  serveAsset,
  conditionalNotModified,
  stableEpisodeResponseHeaders,
  type AssetSource,
} from "./serveAsset.ts";

const SIZE = 200;

function makeSource(): AssetSource {
  const bytes = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) bytes[i] = i % 256;
  return {
    size: SIZE,
    slice: (s, e) => bytes.subarray(s, e + 1),
    whole: () => bytes,
  };
}

// A realistic stable-episode policy header set.
function policyHeaders(): Record<string, string> {
  return {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: '"deadbeefdeadbeef"',
    "Accept-Ranges": "bytes",
    "Repr-Digest": "sha-256=:abc:",
    "Content-Type": "audio/mpeg",
    "Content-Length": String(SIZE),
  };
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

// --- 200: whole body + Content-Length, policy headers intact ---------------

test("200: whole body, Content-Length, policy headers intact", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers(),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Length")).toBe(String(SIZE));
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("ETag")).toBe('"deadbeefdeadbeef"');
  expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  expect(res.headers.get("Content-Range")).toBeNull();
  expect((await bodyBytes(res)).byteLength).toBe(SIZE);
});

// --- 206: forms + Content-Range/Content-Length math + policy headers ride ---

test("206: closed range bytes=0-99", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=0-99" }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(206);
  expect(res.statusText).toBe("Partial Content");
  expect(res.headers.get("Content-Range")).toBe(`bytes 0-99/${SIZE}`);
  expect(res.headers.get("Content-Length")).toBe("100");
  // Policy headers (immutable CC, ETag, Repr-Digest) ride onto the 206.
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("ETag")).toBe('"deadbeefdeadbeef"');
  expect(res.headers.get("Repr-Digest")).toBe("sha-256=:abc:");
  expect((await bodyBytes(res)).byteLength).toBe(100);
});

test("206: open-ended range bytes=100-", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=100-" }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toBe(`bytes 100-199/${SIZE}`);
  expect(res.headers.get("Content-Length")).toBe("100");
  expect((await bodyBytes(res)).byteLength).toBe(100);
});

test("206: suffix range bytes=-100", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=-100" }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toBe(`bytes 100-199/${SIZE}`);
  expect(res.headers.get("Content-Length")).toBe("100");
  expect((await bodyBytes(res)).byteLength).toBe(100);
});

// --- 416: out-of-bounds → problem+json + Content-Range + policy minus CT/CL --

test("416: out-of-bounds start → problem+json (D1 contract)", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=500-600" }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(416);
  // problem+json body owns Content-Type; policy CT is skipped.
  expect(res.headers.get("Content-Type")).toBe("application/problem+json");
  expect(res.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
  // Policy headers merged on (RFC-friendlier) except the problem-owned CT/CL.
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("ETag")).toBe('"deadbeefdeadbeef"');
  expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  // Content-Length is the problem body's own, NOT the policy's SIZE.
  expect(res.headers.get("Content-Length")).not.toBe(String(SIZE));
  const body = (await res.json()) as { type: string; status: number; title: string };
  expect(body.type).toBe("about:blank");
  expect(body.status).toBe(416);
  expect(typeof body.title).toBe("string");
});

// --- HEAD with Range → full 200 shape (bodied; caller runtime strips) --------

test("HEAD with Range → full 200 (Range suppressed)", async () => {
  const res = serveAsset(makeSource(), {
    method: "HEAD",
    requestHeaders: new Headers({ Range: "bytes=0-99" }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Length")).toBe(String(SIZE));
  expect(res.headers.get("Content-Range")).toBeNull();
});

// --- If-Range strong-etag ----------------------------------------------------

const ETAG = '"deadbeefdeadbeef"';

test("If-Range strong-etag: exact match → 206", () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=0-99", "If-Range": ETAG }),
    headers: policyHeaders(),
    ifRange: { kind: "strong-etag", etag: ETAG },
  });
  expect(res.status).toBe(206);
});

test("If-Range strong-etag: mismatch → full 200", () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=0-99", "If-Range": '"other-etag-value"' }),
    headers: policyHeaders(),
    ifRange: { kind: "strong-etag", etag: ETAG },
  });
  expect(res.status).toBe(200);
});

test("If-Range strong-etag: HTTP-date form → full 200 (we send no Last-Modified)", () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({
      Range: "bytes=0-99",
      "If-Range": "Wed, 21 Oct 2015 07:28:00 GMT",
    }),
    headers: policyHeaders(),
    ifRange: { kind: "strong-etag", etag: ETAG },
  });
  expect(res.status).toBe(200);
});

test("If-Range strong-etag: null etag + any If-Range → full 200", () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({ Range: "bytes=0-99", "If-Range": ETAG }),
    headers: policyHeaders(),
    ifRange: { kind: "strong-etag", etag: null },
  });
  expect(res.status).toBe(200);
});

// --- If-Range ignore: the row-11 regression guard ----------------------------

test("If-Range ignore: mismatched If-Range STILL yields 206 (row-11 guard — prevents the 20MB-per-seek bug)", async () => {
  const res = serveAsset(makeSource(), {
    method: "GET",
    requestHeaders: new Headers({
      Range: "bytes=0-99",
      "If-Range": '"a-completely-different-validator"',
    }),
    headers: policyHeaders(),
    ifRange: { kind: "ignore" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toBe(`bytes 0-99/${SIZE}`);
  expect((await bodyBytes(res)).byteLength).toBe(100);
});

// --- conditionalNotModified --------------------------------------------------

test("conditionalNotModified: If-None-Match matches → 304 echoing headers, body null", async () => {
  const res = conditionalNotModified(
    new Headers({ "If-None-Match": ETAG }),
    ETAG,
    policyHeaders(),
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(304);
  expect(res!.body).toBeNull();
  expect(res!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(res!.headers.get("ETag")).toBe(ETAG);
});

test("conditionalNotModified: `*` matches → 304", () => {
  const res = conditionalNotModified(new Headers({ "If-None-Match": "*" }), ETAG, {});
  expect(res).not.toBeNull();
  expect(res!.status).toBe(304);
});

test("conditionalNotModified: null etag → null (proceed)", () => {
  expect(conditionalNotModified(new Headers({ "If-None-Match": "*" }), null, {})).toBeNull();
});

test("conditionalNotModified: no If-None-Match → null (proceed)", () => {
  expect(conditionalNotModified(new Headers(), ETAG, {})).toBeNull();
});

// --- stableEpisodeResponseHeaders --------------------------------------------

test("stableEpisodeResponseHeaders: with etag + valid digest, ext with dot", () => {
  const h = stableEpisodeResponseHeaders({
    etag: ETAG,
    slug: "hash-functions",
    ext: ".mp3",
    digest: "a".repeat(64),
  });
  expect(h["ETag"]).toBe(ETAG);
  expect(h["Cache-Control"]).toBe("no-cache");
  expect(h["Accept-Ranges"]).toBe("bytes");
  expect(h["CDN-Cache-Control"]).toBe("max-age=60, stale-while-revalidate=604800");
  expect(h["Content-Disposition"]).toContain("hash-functions.mp3");
  expect(h["Repr-Digest"]).toMatch(/^sha-256=:.+:$/);
});

test("stableEpisodeResponseHeaders: ext without dot yields same download name", () => {
  const h = stableEpisodeResponseHeaders({ etag: ETAG, slug: "post", ext: "mp3" });
  expect(h["Content-Disposition"]).toContain("post.mp3");
});

test("stableEpisodeResponseHeaders: null etag → no ETag header", () => {
  const h = stableEpisodeResponseHeaders({ etag: null, slug: "post", ext: "mp3" });
  expect(h["ETag"]).toBeUndefined();
});

test("stableEpisodeResponseHeaders: invalid/absent digest → no Repr-Digest", () => {
  const noDigest = stableEpisodeResponseHeaders({ etag: ETAG, slug: "post", ext: "mp3" });
  expect(noDigest["Repr-Digest"]).toBeUndefined();
  const badDigest = stableEpisodeResponseHeaders({
    etag: ETAG,
    slug: "post",
    ext: "mp3",
    digest: "not-a-sha256",
  });
  expect(badDigest["Repr-Digest"]).toBeUndefined();
});
