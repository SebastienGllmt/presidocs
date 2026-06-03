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
// we slice the body and synthesize a 206 with Content-Range. Parse semantics
// mirror shared/httpRange.ts (the single source of truth used by the dev
// server + Worker). The SW can't import TS from `shared/`; this is the same
// logic in plain JS, tighter scope — only `bytes=N-M` / `bytes=N-` / `bytes=-N`,
// plus the suffix-clamp + 416 branch.
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
  const outcome = parseRange(rangeHeader, size);
  if (outcome.kind === "unsatisfiable") {
    return new Response("range not satisfiable", {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${size}`,
      },
    });
  }
  if (outcome.kind === "passthrough") {
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
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

function parseRange(header, size) {
  const m = /^bytes=(\d+)?-(\d+)?$/.exec(header.trim());
  if (!m) return { kind: "unsatisfiable" };
  const a = m[1];
  const b = m[2];
  let start;
  let end;
  if (a !== undefined && b !== undefined) {
    start = parseInt(a, 10);
    end = parseInt(b, 10);
    if (start > end) return { kind: "unsatisfiable" };
  } else if (a !== undefined) {
    start = parseInt(a, 10);
    end = size - 1;
  } else if (b !== undefined) {
    const suffix = parseInt(b, 10);
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    return { kind: "unsatisfiable" };
  }
  if (start >= size) return { kind: "unsatisfiable" };
  end = Math.min(end, size - 1);
  return { kind: "satisfiable", start, end };
}
