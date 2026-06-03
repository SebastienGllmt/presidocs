// Production-Worker smoke for the stable shareable audio URL (proposals/32 §10).
//
// This is the tier the Bun dev server CANNOT cover: it drives the real
// `createWorker.ts` under `wrangler dev` (workerd/Miniflare), so it exercises the
// prod-only glue — `serveStableEpisode`'s internal `env.ASSETS.fetch` + header
// rewrite, the static-asset fall-through, `applyRangeSupport`, and
// `withSecurityHeaders`. In particular it asserts the two things dev couldn't:
// `Content-Length` on the 200 (copied from the ASSETS response) and the document
// CSP wrapping the stable response. URLs are discovered from the served
// `/podcast.xml` so the test doesn't hardcode a slug.
//
// NOT named `*.e2e.ts` / `*.test.ts` on purpose: it's a separate heavy tier (a
// full build + wrangler), run only via its own script — `bun run test:e2e:prod`
// — never by the default `bun test` or the Chrome `test:e2e` lane. No browser.
//
// Precondition: the blog has generated audio on disk (see harness). The harness
// runs `bun run build`, which rewrites source posts (managed <script> tags) +
// versions.json per normal build behavior — run on an ephemeral/CI checkout.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startWranglerServer, type BlogServer } from "./harness.ts";

let server: BlogServer;
let stableUrl: string; // absolute …/episode.<ext>
let hashedUrl: string; // absolute …/full.<hash>.<ext>
let feedXml: string;

beforeAll(async () => {
  server = await startWranglerServer();
  // Discover the episode URLs from the Worker-served feed.
  const res = await fetch(`${server.baseURL}/podcast.xml`);
  expect(res.status, "podcast.xml should be served by the Worker").toBe(200);
  feedXml = await res.text();
  const stablePath = feedXml.match(/<enclosure url="[^"]*(\/generated\/[^"]+\/episode\.[a-z0-9]+)"/i)?.[1];
  const hashedPath = feedXml.match(/<podcast:source uri="[^"]*(\/generated\/[^"]+\/full\.[0-9a-f]{16}\.[a-z0-9]+)"/i)?.[1];
  expect(stablePath, "feed must carry a stable episode enclosure (is audio generated?)").toBeTruthy();
  expect(hashedPath, "feed must advertise the content-addressed source").toBeTruthy();
  stableUrl = `${server.baseURL}${stablePath}`;
  hashedUrl = `${server.baseURL}${hashedPath}`;
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

test("prod Worker serves the stable episode URL with the full header contract", async () => {
  const res = await fetch(stableUrl);
  expect(res.status).toBe(200);
  const h = res.headers;
  // strong validator + revalidating policy (never immutable)
  expect(h.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
  expect(h.get("cache-control")).toBe("no-cache");
  expect(h.get("cdn-cache-control")).toBe("max-age=60, stale-while-revalidate=604800");
  expect(h.get("accept-ranges")).toBe("bytes");
  expect(h.get("content-type")).toContain("audio/mpeg");
  // PROD-ONLY assertions the Bun dev server can't make:
  //  - Content-Length is copied from the ASSETS response (dev streams chunked);
  //  - the document CSP wraps the response (withSecurityHeaders, run_worker_first).
  expect(Number(h.get("content-length"))).toBeGreaterThan(0);
  expect(h.get("content-security-policy")).toContain("default-src 'none'");
  // RFC 9530 representation digest, resolved via the build-time map → Worker.
  expect(h.get("repr-digest")).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
});

test("prod: If-None-Match → 304 echoing the cache headers", async () => {
  const etag = (await fetch(stableUrl)).headers.get("etag")!;
  const res = await fetch(stableUrl, { headers: { "If-None-Match": etag } });
  expect(res.status).toBe(304);
  expect(res.headers.get("etag")).toBe(etag);
  expect(res.headers.get("cache-control")).toBe("no-cache");
});

test("prod: ranged GET → 206 echoing ETag + Repr-Digest", async () => {
  const res = await fetch(stableUrl, { headers: { Range: "bytes=0-99" } });
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
  expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
  // Repr-Digest is representation-level (range-independent) — present on the 206.
  expect(res.headers.get("repr-digest")).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  const body = await res.arrayBuffer();
  expect(body.byteLength).toBe(100);
});

test("prod: If-Range guard — stale validator serves full 200, current → 206", async () => {
  const stale = await fetch(stableUrl, {
    headers: { Range: "bytes=0-99", "If-Range": '"deadbeefdeadbeef"' },
  });
  expect(stale.status).toBe(200);
  expect(stale.headers.get("content-range")).toBeNull();

  const etag = stale.headers.get("etag")!;
  const fresh = await fetch(stableUrl, {
    headers: { Range: "bytes=0-99", "If-Range": etag },
  });
  expect(fresh.status).toBe(206);
});

test("prod: unknown slug falls through to a 404", async () => {
  const res = await fetch(`${server.baseURL}/generated/does-not-exist/episode.mp3`);
  expect(res.status).toBe(404);
});

test("prod: HEAD → 200 (not 206) with the ETag and an empty body", async () => {
  // (Content-Length is intentionally not asserted: the Workers runtime drops it
  // on HEAD responses — it's a SHOULD, not a MUST, per RFC 9110 §9.3.2.)
  const res = await fetch(stableUrl, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{16}"$/);
  expect((await res.arrayBuffer()).byteLength).toBe(0);
});

test("prod: the hashed player URL is served (ASSETS fall-through) + range-capable (applyRangeSupport)", async () => {
  const full = await fetch(hashedUrl);
  expect(full.status).toBe(200);
  // NOTE (proposals/32 finding): the Workers Assets binding serves content-hashed
  // files as `public, max-age=0, must-revalidate` — NOT `immutable` (no `_headers`
  // rule sets that). So we only assert a cache policy is present, not its value;
  // baking in the current value would lock in the status quo this finding questions.
  expect(full.headers.get("cache-control")).toBeTruthy();

  const ranged = await fetch(hashedUrl, { headers: { Range: "bytes=0-99" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
});

test("prod: feed (served by the Worker) carries stable enclosure + alternateEnclosure + integrity", () => {
  expect(feedXml).toMatch(/<enclosure url="[^"]*\/episode\.[a-z0-9]+"/i);
  expect(feedXml).not.toMatch(/<enclosure url="[^"]*\/full\.[0-9a-f]{16}\./i);
  expect(feedXml).toContain("<podcast:alternateEnclosure");
  expect(feedXml).toMatch(/<podcast:integrity type="sri" value="sha256-[A-Za-z0-9+/]+=*"\/>/);
});
