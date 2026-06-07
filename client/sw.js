// Service Worker for presidocs-powered blogs. Handles offline cache for the
// static asset surface (article HTML, hashed JS/CSS, MP3s, narration manifest,
// Automerge WASM). Push + notificationclick + sync handlers will slot in here
// when those proposals land (methodology.md → Web Push; proposal 06 §5, §6).
//
// VERSION is a build-time placeholder replaced at copy time by
// engine/generate/copy-static.ts (Bun's bundler doesn't process this file
// because it's served as a top-level /sw.js, not part of the bundle graph).
// Per deploy this gets a fresh value, so activate's cache reap deletes the
// previous deploy's entries.
//
// Why vanilla JS instead of TS: SW files are served as-is to the browser; if
// this were .ts we'd need a build step to transpile and a name-stable output.
// The whole point of /sw.js at the origin root is that its URL is fixed for
// the registration to claim scope: "/" — keeping it plain JS removes one
// build layer between the source and what the browser fetches.

const VERSION = "__SW_VERSION__";
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

// Precache the absolute baseline so a known-good index + the WASM the comments
// client lazy-loads are always offline. Other posts are runtime-cached as the
// user visits them.
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/assets/automerge.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE_URLS)),
  );
  // Skip the "waiting" phase — the new SW takes over on next navigation.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Reap caches from older deploys. VERSION embeds the deploy timestamp, so
    // anything not ending with the current value is stale.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.endsWith(`-${VERSION}`)).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Network-only: dynamic / auth / freshness-critical surfaces. Caching even
  // briefly creates races (a logout that doesn't take, a comment that doesn't
  // show, a doc-version banner that reads stale).
  if (
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/comments" ||
    url.pathname === "/resolutions" ||
    url.pathname === "/post-version" ||
    url.pathname === "/_a"
  ) {
    return; // no e.respondWith() → browser does the fetch
  }

  // The stable shareable episode URL (/generated/<slug>/episode.<ext>) is the one
  // MUTABLE resource under /generated/: it's server-revalidated (strong ETag +
  // Cache-Control: no-cache), not content-addressed (see methodology → Stable
  // shareable episode URL). Pass it through so the browser honors that
  // revalidation — caching it here (cache-first OR network-first) would risk
  // serving a stale episode after a regeneration, the exact thing the stable URL
  // exists to avoid. Its offline story isn't needed: the in-page player rides the
  // content-hashed path, and this is a share/feed URL.
  if (/^\/generated\/[^/]+\/episode\.[a-z0-9]+$/.test(url.pathname)) {
    return; // no e.respondWith() → browser fetches, honoring ETag/Cache-Control
  }

  // Cache-first: content-addressed or hash-named static. URL changes when
  // bytes change, so a cache hit is correctness-safe forever.
  if (
    url.pathname.startsWith("/generated/") ||   // content-hashed mp3 + manifest
    url.pathname.startsWith("/assets/") ||      // automerge.wasm, authors.json, og/, etc.
    /-[a-z0-9]{8}\.(?:js|css)$/.test(url.pathname)
  ) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Network-first w/ cache fallback: navigations + post HTML. The author wants
  // a re-publish to show up immediately; cache only kicks in when offline.
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    e.respondWith(networkFirst(req));
    return;
  }

  // Default: pass through (browser does its own fetch).
});

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  // Range requests need 206-shaped responses synthesized from the cached full
  // body; serving a full 200 to a Range request works in Chromium but Safari
  // has been observed to reject mid-track.
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    return cacheFirstRanged(cache, req, rangeHeader);
  }
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cache = await caches.open(RUNTIME_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// Cache-first with Range support. The cache holds the full 200; on a Range hit
// we slice the body and synthesize a 206 with Content-Range. The parser is no
// longer a third hand-rolled copy: it's `resolveRange` from shared/httpRange.ts
// — the SAME resolver the dev server + prod Worker use — transpiled to plain JS
// and spliced in below at copy time (the SW can't `import` TS). Verdict mapping:
//   none          → full 200 (no/invalid range, incl. the bare `bytes=-`, which
//                    the old hand-rolled copy wrongly 416'd)
//   satisfiable   → 206 slice with Content-Range
//   unsatisfiable → 416 with `bytes */size`
async function cacheFirstRanged(cache, req, rangeHeader) {
  // Cache key is the request without the Range header — we store the full body.
  const cacheKey = new Request(req.url);
  let full = await cache.match(cacheKey);
  if (!full) {
    const res = await fetch(new Request(req.url));
    if (!res.ok) return res;
    cache.put(cacheKey, res.clone());
    full = res;
  }
  const bytes = new Uint8Array(await full.arrayBuffer());
  const size = bytes.byteLength;
  const outcome = resolveRange(rangeHeader, size);
  if (outcome.kind === "unsatisfiable") {
    return new Response("range not satisfiable", {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": unsatisfiedRangeHeader(size),
      },
    });
  }
  if (outcome.kind === "none") {
    return new Response(bytes, {
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
      },
    });
  }
  const { start, end } = outcome;
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": contentRangeHeader(start, end, size),
      "Content-Length": String(end - start + 1),
    },
  });
}

// The single shared RFC 7233 resolver from shared/httpRange.ts. The block
// between the two markers below is REGENERATED from that source at copy time by
// engine/generate/copy-static.ts (transpiled to plain JS, `export` stripped),
// so the shipped SW never drifts from the dev-server/Worker parser. The
// authored copy here is kept faithful for readability + so the raw file is
// valid, but it is never executed (the dev server never registers the SW); the
// shipped behaviour is what generate/swHttpRange.test.ts guards.
// __HTTP_RANGE_START__
const SINGLE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;
function isResolvableRangeHeader(header) {
  if (!header)
    return false;
  const m = SINGLE_RANGE_RE.exec(header.trim());
  return m !== null && !(m[1] === "" && m[2] === "");
}
function resolveRange(rangeHeader, size) {
  if (!rangeHeader || size <= 0)
    return { kind: "none" };
  const m = SINGLE_RANGE_RE.exec(rangeHeader.trim());
  if (!m)
    return { kind: "none" };
  if (m[1] === "" && m[2] === "")
    return { kind: "none" };
  let start = m[1] === "" ? NaN : Number(m[1]);
  let end = m[2] === "" ? NaN : Number(m[2]);
  if (Number.isNaN(start)) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) {
    return { kind: "unsatisfiable", size };
  }
  end = Math.min(end, size - 1);
  return { kind: "satisfiable", start, end, size };
}
function contentRangeHeader(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}
function unsatisfiedRangeHeader(size) {
  return `bytes */${size}`;
}
// __HTTP_RANGE_END__
