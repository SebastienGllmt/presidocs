// Engine factory for the production Cloudflare Worker. The route wiring used
// to live inline in `worker.ts`; it's factored here so every content repo
// (presidocs itself, personal-blog, …) keeps only a thin `worker.ts` that
// imports its own build-time post maps and calls `createWorkerHandler`.
//
// The handler mirrors the dev server's route table (see createDevServer.ts) so
// dev and prod resolve the same URLs the same way. Static assets (the bundled
// article + JS + audio) are served via the `ASSETS` binding; anything that
// doesn't match an API route falls through to it.
//
// Bindings live in the content repo's `wrangler.toml`. Secrets (`SESSION_SECRET`,
// the OAuth `*_CLIENT_*` pairs) are managed via `wrangler secret put …` and
// exposed through `process.env` by the `nodejs_compat` flag, so the auth code
// in `server/auth/` reads them via `process.env.*` unchanged — same code path
// as dev.

import type { ExecutionContext } from "@cloudflare/workers-types";
import { StatusCodes } from "http-status-codes";
import type { Env } from "./env.ts";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./auth/routes.ts";
import { handleCommentsRequest } from "./comments/routes.ts";
import { handleResolutionsRequest } from "./comments/resolutionsRoutes.ts";
import { r2Adapter } from "./comments/r2Adapter.ts";
import { createPostMetaIndex, type PostMeta } from "./postMeta.ts";
import {
  createPostVersionIndex,
  type PostVersionRecord,
} from "./postVersions.ts";
import { handlePostVersionRequest } from "./postVersionsRoute.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { handleAnalyticsRequest } from "./analyticsRoute.ts";
import { withNoindexOffCanonicalHost, withSecurityHeaders } from "../shared/securityHeaders.ts";
import {
  contentRangeHeader,
  isResolvableRangeHeader,
  resolveRange,
  unsatisfiedRangeHeader,
} from "../shared/httpRange.ts";
import { problem } from "../shared/problemDetails.ts";
import {
  audioEtag,
  episodeDownloadName,
  HASHED_AUDIO_RE,
  ifNoneMatchSatisfied,
  rangeHonored,
  stableAudioHeaders,
  stableEpisodePath,
  stableEpisodeSlug,
} from "../shared/stableAudio.ts";
import { isSha256Hex, reprDigestSha256 } from "../shared/audioDigest.ts";
import { isContentHashedAsset } from "../shared/manifestFile.ts";

// The two build-time maps, supplied by the content repo's `worker.ts` from its
// own `.generated/` directory. Structural types (not the engine's `PostMeta` /
// `PostVersionRecord` imports) so the generated files stay self-contained and
// portable across content repos — they're checked structurally here.
export type WorkerContent = {
  postAuthors: Record<string, PostMeta>;
  postVersions: Record<string, PostVersionRecord>;
  // Slug → { current content-addressed audio URL, full SHA-256 hex }, emitted by
  // generate/episode-audio.ts. Resolves the stable shareable URL
  // `/generated/<slug>/episode.<ext>` and supplies the `Repr-Digest` (RFC 9530).
  // Optional so existing content repos that don't supply it keep building —
  // those just don't serve the stable URL.
  episodeAudio?: Record<string, { audio: string; digest?: string }>;
  // Canonical host (SITE_HOST from .generated/postMeta.ts, baked from
  // SITE_URL at build). When supplied, responses served from any OTHER host
  // (a preview/staging deploy) carry `X-Robots-Tag: noindex` — see
  // shared/securityHeaders.ts:withNoindexOffCanonicalHost. Optional/null →
  // no noindex anywhere (a SITE_URL-less build has no canonical to defend).
  siteHost?: string | null;
  // Private (capability-URL) blog (SITE_PRIVATE from .generated/postMeta.ts,
  // baked from BLOG_PRIVATE at build): EVERY response carries
  // `X-Robots-Tag: noindex`, canonical host included. Optional → public.
  sitePrivate?: boolean;
};

// Add HTTP Range support to a Static Assets response.
//
// `env.ASSETS.fetch()` IGNORES the `Range` request header: it always returns
// the whole file with `200 OK` and no `Accept-Ranges` (verified against a
// live deploy). For a small JS/CSS/HTML asset that's harmless, but for the
// narration track (a ~20 MB / 40-min MP3) it breaks seeking: the browser's
// media element can only seek precisely into a region it can fetch by byte
// range, so without `206`/`Content-Range` a jump to a not-yet-downloaded
// offset lands seconds away — mid-way through a *different* narration segment
// (and reports that wrong position back, so the on-screen clock agrees with
// it). It "sometimes works" only because a seek inside the already-buffered
// prefix doesn't need a range request. The dev server (createDevServer.ts)
// already serves `206` itself; this brings prod to parity.
//
// We satisfy the range by buffering the (cached, fast-to-read) asset and
// slicing it. That re-reads the whole asset per range request, which is fine
// at audio sizes and only happens when the client actually sends `Range`;
// non-range requests pass straight through (we only add `Accept-Ranges` so
// the media element knows it *may* seek). Range parsing lives in
// shared/httpRange.ts, shared with the dev path.
async function applyRangeSupport(req: Request, res: Response): Promise<Response> {
  // Only meaningful for a successful, bodied GET. ASSETS returns 200 for hits.
  if (res.status !== 200 || (req.method !== "GET" && req.method !== "HEAD")) {
    return res;
  }
  const range = req.headers.get("Range");
  if (!range || req.method === "HEAD") {
    // Advertise range capability; don't buffer when there's nothing to slice.
    const headers = new Headers(res.headers);
    headers.set("Accept-Ranges", "bytes");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  // Skip buffering if the header is unparseable — same posture as before the
  // shared-parser refactor: a request we can't slice gets the original 200
  // back, body untouched.
  if (!isResolvableRangeHeader(range)) return res;

  const buf = new Uint8Array(await res.arrayBuffer());
  const outcome = resolveRange(range, buf.byteLength);
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");

  if (outcome.kind === "none") {
    // Zero-size asset that nonetheless had a parseable Range — match the
    // pre-refactor "let the full 200 stand" branch.
    return new Response(buf, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
  if (outcome.kind === "unsatisfiable") {
    // Per RFC 9110 §15.5.17, the 416 SHOULD carry Content-Range with
    // the selected representation's size. The body is `about:blank`
    // (problem details §4: generic status-code-only).
    const res = problem(StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE, "about:blank");
    res.headers.set("Content-Range", unsatisfiedRangeHeader(outcome.size));
    return res;
  }
  const { start, end, size } = outcome;
  headers.set("Content-Range", contentRangeHeader(start, end, size));
  headers.set("Content-Length", String(end - start + 1));
  return new Response(buf.subarray(start, end + 1), {
    status: StatusCodes.PARTIAL_CONTENT,
    statusText: "Partial Content",
    headers,
  });
}

// Fetch the bytes for an audio path from R2 (`env.AUDIO`) when bound, else the
// static-asset bundle. R2 is authoritative when bound: a long full track can
// exceed Cloudflare's hard 25 MiB per-static-asset cap, so full narration
// tracks live in R2 and no longer ship to dist/ (uploaded by
// generate/upload-audio-r2.ts at deploy). A content repo WITHOUT the binding
// (its tracks all under the cap) transparently falls back to the pre-R2 ASSETS
// path. Returns a 200 Response (body + strong ETag + Content-Length + audio
// Content-Type) or a non-200 the caller treats as "missing/swept".
//
// The body is returned WHOLE (R2's native Range isn't used here) so the tested
// `applyRangeSupport` path — If-Range handling, 206 shaping, the shared range
// parser — is reused unchanged; this matches the prior ASSETS behavior, which
// also returned the whole body and sliced. (Native R2 `get(key,{range})` is a
// future efficiency lever, not a correctness one.)
async function fetchAudioBytes(env: Env, audioPath: string, baseUrl: string): Promise<Response> {
  if (env.AUDIO) {
    const obj = await env.AUDIO.get(audioPath.replace(/^\/+/, ""));
    if (!obj) return new Response(null, { status: StatusCodes.NOT_FOUND });
    const headers = new Headers();
    // All delivered tracks are mono MP3 (audio-pipeline deliveryExt). Set the
    // type directly rather than round-tripping R2 httpMetadata — fewer moving
    // parts, and it can't drift from whatever the upload happened to tag.
    headers.set("Content-Type", "audio/mpeg");
    headers.set("ETag", obj.httpEtag); // R2 strong validator (already quoted)
    // R2 gives the exact size — set Content-Length so HEAD carries it (RFC 9110
    // §9.3.2) and the non-range GET advertises length; applyRangeSupport sets
    // its own on a 206.
    headers.set("Content-Length", String(obj.size));
    // @ts-expect-error - R2's body is the workers-runtime ReadableStream; the DOM
    // Response constructor's BodyInit doesn't unify with it (same object at runtime).
    return new Response(obj.body, { status: StatusCodes.OK, statusText: "OK", headers });
  }
  // No AUDIO binding → serve from the asset bundle (the pre-R2 path).
  const assetUrl = new URL(audioPath, baseUrl);
  // @ts-expect-error - ASSETS.fetch takes the same Request shape; runtime/DOM Request types don't unify.
  return env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
}

// Content-Type the Static Assets binding's extension default doesn't reliably
// give us. Returns the MIME to force, or null to leave the asset response
// untouched. Pure + exported so the routing decision is unit-testable.
//  - .xml feeds → the feed MIME types strict validators sniff for.
//  - .vtt transcripts → text/vtt, so a <podcast:transcript type="text/vtt">
//    target serves as a caption file, not octet-stream/plain (proposals/39).
export function staticAssetContentTypeOverride(pathname: string): string | null {
  if (pathname === "/feed.xml") return "application/atom+xml; charset=utf-8";
  if (pathname === "/podcast.xml") return "application/rss+xml; charset=utf-8";
  if (pathname.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  //  - .mp4/.webm social-media video (methodology.md → "Video export"). Range support is generic
  //    (applyRangeSupport below), so scrubbing works once the MIME is correct.
  if (pathname.endsWith(".mp4")) return "video/mp4";
  if (pathname.endsWith(".webm")) return "video/webm";
  //  - figure source: `/posts/<slug>/figures/<module>.ts` — force
  //    text/plain so an agent (or browser) following the Markdown twin's [source]
  //    link reads the TypeScript as text, not the `video/mp2t` an `.ts` extension
  //    otherwise sniffs to. Scoped to the figures dir; figure source is the only
  //    `.ts` served. Matches the dev route (createDevServer.ts serveFigureSource).
  if (pathname.endsWith(".ts") && pathname.includes("/figures/")) return "text/plain; charset=utf-8";
  //  - the blog's own license: copy-static ships LICENSE.md to the
  //    extension-less dist/license, which the binding would otherwise serve as
  //    octet-stream (a download). Force text/plain so the footer "License" link
  //    renders the terms in the browser. Mirrors the dev route in createDevServer.ts.
  if (pathname === "/license") return "text/plain; charset=utf-8";
  return null;
}

// The Podcast Namespace's "web app friendliness" guidance requires that the
// public feed artifacts a *browser-based* podcast player fetches cross-origin
// are CORS-readable: the feeds themselves and the <podcast:chapters> /
// <podcast:transcript> targets. Without `Access-Control-Allow-Origin`, the
// same-origin policy blocks those reads and chapters/captions silently fail to
// load in that whole class of client. Returns the ACAO value to set, or null
// to leave the response untouched.
//
// SCOPED DELIBERATELY to static, public, non-sensitive feed artifacts. It must
// NEVER match an API/identity route (`/comments`, `/auth/*`, `/post-version`,
// `/_a`, `/openapi.json`) — those are handled before the asset fall-through and
// stay same-origin (Cross-Origin-Resource-Policy). Manifests and audio are also
// excluded: only `/chapters.json` (not any `*.json`) and `.vtt` match.
export function feedAssetCorsOrigin(pathname: string): string | null {
  if (
    pathname === "/feed.xml" ||
    pathname === "/podcast.xml" ||
    pathname.endsWith("/chapters.json") ||
    pathname.endsWith(".vtt")
  ) {
    return "*";
  }
  return null;
}

export function createWorkerHandler(content: WorkerContent) {
  // Built once at module load — the maps are static for the lifetime of the
  // Worker (regenerated only when a new build is deployed).
  const postMetaIndex = createPostMetaIndex(content.postAuthors);
  const postVersionsIndex = createPostVersionIndex(content.postVersions);

  // Match an API route and run its handler. Returns null when the request is
  // not an API route, so the caller falls through to static assets. These are
  // the "private" (non-asset) responses that also get CORP.
  function handleApi(
    req: Request,
    env: Env,
  ): Promise<Response> | Response | null {
    const path = new URL(req.url).pathname;

    // --- Auth routes (handlers are runtime-agnostic). ---
    if (path === "/auth/google") return startGoogleAuth(req);
    if (path === "/auth/google/callback") return googleCallback(req);
    if (path === "/auth/microsoft") return startMicrosoftAuth(req);
    if (path === "/auth/microsoft/callback") return microsoftCallback(req);
    if (path === "/auth/me") return whoami(req);
    if (path === "/auth/logout" && req.method === "POST") return logout(req);

    // --- OpenAPI 3.1 document for the gated API (public — schema, not data). ---
    if (path === "/openapi.json") return Response.json(buildOpenApiDocument());

    // --- Comments R2 proxy. ---
    if (path === "/comments") {
      return handleCommentsRequest(req, {
        store: r2Adapter(env.COMMENTS),
        postMeta: postMetaIndex,
        rateLimiter: env.RATE_LIMITER,
      });
    }
    if (path === "/resolutions") {
      return handleResolutionsRequest(req, {
        store: r2Adapter(env.COMMENTS),
        postMeta: postMetaIndex,
      });
    }
    if (path === "/post-version") {
      return handlePostVersionRequest(req, {
        postVersions: postVersionsIndex,
        postMeta: postMetaIndex,
      });
    }

    // Engagement-analytics sink. POST-only; the handler 204s any other method.
    // Anonymous, no session check, no R2 access — see server/analyticsRoute.ts.
    if (path === "/_a") {
      return handleAnalyticsRequest(req, {
        sink: env.ANALYTICS ?? null,
        postMeta: postMetaIndex,
        rateLimiter: env.ANALYTICS_RATE_LIMITER ?? null,
      });
    }

    return null;
  }

  // Serve the STABLE shareable episode URL `/generated/<slug>/episode.<ext>` by
  // resolving it to the current content-addressed asset via the build-time map,
  // then serving those bytes with a revalidating policy (strong ETag = content
  // hash, no `immutable`) — see shared/stableAudio.ts and methodology.md →
  // Stable shareable episode URL. Returns
  // null when the slug is unknown or the mapped asset is missing, so the caller
  // falls through to the static-asset 404. The in-page player and feeds still
  // hit the hashed URL directly; only copied/feed links use this route.
  async function serveStableEpisode(
    req: Request,
    env: Env,
    slug: string,
  ): Promise<Response | null> {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const entry = content.episodeAudio?.[slug];
    if (!entry) return null;
    const audioPath = entry.audio;

    const etag = audioEtag(audioPath);
    // Per-post download name (`<slug>.<ext>`) for the inline Content-Disposition,
    // so a manual save isn't `episode.mp3` for every post (methodology.md →
  // Stable shareable episode URL).
    const downloadName = episodeDownloadName(slug, audioPath.split(".").pop() ?? "mp3");
    // RFC 9530 representation digest (range-independent) — valid on 200/206/304.
    const reprDigest =
      entry.digest && isSha256Hex(entry.digest) ? reprDigestSha256(entry.digest) : null;
    const withDigest = (h: Headers): Headers => {
      if (reprDigest) h.set("Repr-Digest", reprDigest);
      return h;
    };

    // Conditional GET: a matching validator short-circuits to 304 (RFC 9110
    // §15.4.5 — echo the cache-affecting headers a 200 would carry).
    if (ifNoneMatchSatisfied(req.headers.get("If-None-Match"), etag)) {
      return new Response(null, {
        status: StatusCodes.NOT_MODIFIED,
        headers: withDigest(new Headers(stableAudioHeaders(etag, downloadName))),
      });
    }

    // Resolve the stable name to the live track bytes — from R2 when bound, else
    // the asset bundle (fetchAudioBytes). The source returns the whole body and
    // ignores Range; applyRangeSupport slices below.
    const asset = await fetchAudioBytes(env, audioPath, req.url);
    if (asset.status !== 200) return null; // map points at a swept/missing object

    // Our validator + cache policy REPLACE whatever the binding emitted; we
    // validate on the strong content-hash ETag only.
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(stableAudioHeaders(etag, downloadName))) {
      headers.set(k, v);
    }
    headers.delete("Last-Modified");
    withDigest(headers); // Repr-Digest rides onto 200/206 (and HEAD via the runtime)

    const full = new Response(asset.body, {
      status: StatusCodes.OK,
      statusText: "OK",
      headers,
    });

    // HEAD flows through too: applyRangeSupport returns the bodied 200 (it
    // special-cases HEAD), and the runtime strips the body while KEEPING
    // Content-Length. (Returning `Response(null, …)` here would make the
    // runtime drop Content-Length — RFC 9110 §9.3.2 wants HEAD to carry it.)

    // Honor Range, but drop it on an If-Range mismatch (→ full 200) so a client
    // mid-seek can't stitch bytes across a regeneration. The strong ETag rides
    // onto the 206 via applyRangeSupport, which lets caches combine ranges only
    // within one version (RFC 9110 §13.1.5 / §15.3.7, RFC 9111 §3.4).
    if (!rangeHonored(req.headers.get("If-Range"), etag)) return full;
    return applyRangeSupport(req, full);
  }

  return {
    async fetch(
      req: Request,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      // Every egress wraps in noindex-off-canonical-host (a data-keyed no-op
      // on the canonical host / without a baked SITE_HOST).
      const noindex = (res: Response): Response =>
        withNoindexOffCanonicalHost(req, res, content.siteHost, content.sitePrivate ?? false);

      const apiResponse = handleApi(req, env);
      if (apiResponse !== null) {
        return noindex(withSecurityHeaders(await apiResponse, { private: true }));
      }

      // --- Stable shareable episode URL (resolves to the hashed asset). ---
      const stableSlug = stableEpisodeSlug(new URL(req.url).pathname);
      if (stableSlug !== null) {
        const episode = await serveStableEpisode(req, env, stableSlug);
        if (episode !== null) return noindex(withSecurityHeaders(episode));
        // Unknown slug / missing asset → fall through to the static 404.
      }

      // --- Static assets fall-through. The Workers Static Assets binding
      //     handles caching headers and 404s for us. Still wrapped so the
      //     article HTML carries the document CSP. ---
      const path = new URL(req.url).pathname;
      // Content-hashed full narration tracks are served from R2 (env.AUDIO) when
      // bound — they no longer ship to dist/ because a long track can exceed
      // Cloudflare's 25 MiB static-asset cap. Everything else
      // (HTML, JS, CSS, fonts, manifests, captions, feeds) stays on the ASSETS
      // bundle, and the immutable/range/Link handling below is identical either
      // way. Without the binding, fetchAudioBytes itself falls back to ASSETS,
      // so this is a transparent no-op for repos under the cap.
      let assetResponse: Response;
      if (env.AUDIO && HASHED_AUDIO_RE.test(path)) {
        assetResponse = await fetchAudioBytes(env, path, req.url);
      } else {
        // @ts-expect-error - ASSETS.fetch takes the same Request shape but
        //     types between the runtime Request and DOM Request don't unify.
        assetResponse = await env.ASSETS.fetch(req);
      }

      // Some static assets need an explicit Content-Type the binding's
      // extension default doesn't reliably give us (feeds, .vtt transcripts);
      // see staticAssetContentTypeOverride. Don't depend on the binding default.
      const overrideCt = staticAssetContentTypeOverride(path);
      // Public feed sidecars get ACAO so browser-based podcast players can
      // fetch them cross-origin (feedAssetCorsOrigin is scoped to those paths
      // only; API/identity responses returned above never reach here).
      const corsOrigin = feedAssetCorsOrigin(path);
      const withCors = (res: Response): Response => {
        if (corsOrigin) res.headers.set("Access-Control-Allow-Origin", corsOrigin);
        return res;
      };
      if (overrideCt && assetResponse.status === 200) {
        const headers = new Headers(assetResponse.headers);
        headers.set("Content-Type", overrideCt);
        return noindex(
          withCors(
            withSecurityHeaders(
              new Response(assetResponse.body, {
                status: assetResponse.status,
                statusText: assetResponse.statusText,
                headers,
              }),
            ),
          ),
        );
      }

      // Content-hashed assets are safe to cache forever: the hash in the name
      // means the bytes can't change under this URL, so a cache need never
      // revalidate. The Static Assets binding serves them as the bare
      // `max-age=0, must-revalidate` default, and `_headers` CAN'T fix that here
      // — under `run_worker_first` it isn't applied to Worker responses (Cloudflare
      // docs), and every asset is a Worker response. So we set `immutable` in code,
      // gated on the hash token in the name (isContentHashedAsset) — which can
      // only ever match a content-addressed URL, never a mutable one (the stable
      // `episode.<ext>` is served above; a bare manifest.json / chapters.json /
      // feeds / sw.js / HTML all lack a hash and keep revalidating). Set on a fresh
      // Response so the policy survives every branch of applyRangeSupport (incl. a
      // 206). See methodology → Serving generated audio.
      let served = assetResponse;
      const basename = path.split("/").pop() ?? "";
      // `/fonts/` ships stable (un-hashed) names but the faces change so
      // rarely that the trade is accepted: returning readers skip the
      // per-face conditional GET, and a (rare) font change waits out the
      // cache or rides a renamed file (proposal 52 §4 — the header-scoped
      // variant; content-hashing the names was rejected there).
      const immutable =
        isContentHashedAsset(basename) || (path.startsWith("/fonts/") && basename.length > 0);
      if (assetResponse.status === 200 && immutable) {
        const headers = new Headers(assetResponse.headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        served = new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers,
        });
      }
      const res = withCors(withSecurityHeaders(await applyRangeSupport(req, served)));
      // The hashed audio representation names its stable URL as canonical
      // (RFC 8288 + RFC 6596) — the HTTP-layer face of the
      // resource-vs-representation split (proposal 51 §3). Path-relative URI:
      // RFC 8288 resolves it against the request URI.
      if (res.status < 400 && HASHED_AUDIO_RE.test(path)) {
        res.headers.set("Link", `<${stableEpisodePath(path)}>; rel="canonical"`);
      }
      return noindex(res);
    },
  };
}
