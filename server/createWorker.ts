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
import { withSecurityHeaders } from "../shared/securityHeaders.ts";
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
  ifNoneMatchSatisfied,
  rangeHonored,
  stableAudioHeaders,
  stableEpisodeSlug,
} from "../shared/stableAudio.ts";
import { isSha256Hex, reprDigestSha256 } from "../shared/audioDigest.ts";

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
  // hash, no `immutable`) — see shared/stableAudio.ts and proposals/32. Returns
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
    // so a manual save isn't `episode.mp3` for every post (proposals/34 §1).
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

    // Resolve the stable name to the live hashed asset and fetch it whole (the
    // ASSETS binding ignores Range — applyRangeSupport slices below).
    const assetUrl = new URL(audioPath, req.url);
    // @ts-expect-error - ASSETS.fetch takes the same Request shape; the runtime and DOM Request types don't unify (mirrors the fall-through below).
    const asset: Response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
    if (asset.status !== 200) return null; // map points at a swept/missing file

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
      const apiResponse = handleApi(req, env);
      if (apiResponse !== null) {
        return withSecurityHeaders(await apiResponse, { private: true });
      }

      // --- Stable shareable episode URL (resolves to the hashed asset). ---
      const stableSlug = stableEpisodeSlug(new URL(req.url).pathname);
      if (stableSlug !== null) {
        const episode = await serveStableEpisode(req, env, stableSlug);
        if (episode !== null) return withSecurityHeaders(episode);
        // Unknown slug / missing asset → fall through to the static 404.
      }

      // --- Static assets fall-through. The Workers Static Assets binding
      //     handles caching headers and 404s for us. Still wrapped so the
      //     article HTML carries the document CSP. ---
      // @ts-expect-error - ASSETS.fetch takes the same Request shape but
      //     types between the runtime Request and DOM Request don't unify.
      const assetResponse: Response = await env.ASSETS.fetch(req);

      // Some static assets need an explicit Content-Type the binding's
      // extension default doesn't reliably give us (feeds, .vtt transcripts);
      // see staticAssetContentTypeOverride. Don't depend on the binding default.
      const path = new URL(req.url).pathname;
      const overrideCt = staticAssetContentTypeOverride(path);
      if (overrideCt && assetResponse.status === 200) {
        const headers = new Headers(assetResponse.headers);
        headers.set("Content-Type", overrideCt);
        return withSecurityHeaders(
          new Response(assetResponse.body, {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers,
          }),
        );
      }

      return withSecurityHeaders(await applyRangeSupport(req, assetResponse));
    },
  };
}
