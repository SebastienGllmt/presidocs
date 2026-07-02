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
import { createPostMetaIndex, type PostMeta } from "./postMeta.ts";
import {
  createPostVersionIndex,
  type PostVersionRecord,
} from "./postVersions.ts";
import { withNoindexOffCanonicalHost, withSecurityHeaders } from "./securityHeaders.ts";
import { problem } from "../shared/problemDetails.ts";
import {
  HASHED_AUDIO_RE,
  stableEpisodePath,
  stableEpisodeSlug,
} from "../shared/stableAudio.ts";
import { isContentHashedAsset } from "../shared/manifestFile.ts";
// Routing (the API route table) and asset/codegen serving were split out of
// this file — see server/workerRoutes.ts and server/workerAssets.ts. This file
// keeps the entry factory + the fetch orchestrator that dispatches between them.
import { handleApi } from "./workerRoutes.ts";
import {
  applyRangeSupport,
  fetchAudioBytes,
  feedAssetCorsOrigin,
  serveStableEpisode,
  staticAssetContentTypeOverride,
} from "./workerAssets.ts";

// Re-export the two pure asset-classification helpers so the frozen public
// surface (server/createWorker.test.ts imports them from here, as may external
// callers) keeps resolving them from createWorker.ts after the workerAssets.ts
// split. Implementations moved verbatim; names/signatures are frozen.
export { feedAssetCorsOrigin, staticAssetContentTypeOverride } from "./workerAssets.ts";

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
  // server/securityHeaders.ts:withNoindexOffCanonicalHost. Optional/null →
  // no noindex anywhere (a SITE_URL-less build has no canonical to defend).
  siteHost?: string | null;
  // Private (capability-URL) blog (SITE_PRIVATE from .generated/postMeta.ts,
  // baked from BLOG_PRIVATE at build): EVERY response carries
  // `X-Robots-Tag: noindex`, canonical host included. Optional → public.
  sitePrivate?: boolean;
};

export function createWorkerHandler(content: WorkerContent) {
  // Built once at module load — the maps are static for the lifetime of the
  // Worker (regenerated only when a new build is deployed).
  const postMetaIndex = createPostMetaIndex(content.postAuthors);
  const postVersionsIndex = createPostVersionIndex(content.postVersions);

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
      try {
        const apiResponse = handleApi(req, env, postMetaIndex, postVersionsIndex);
        if (apiResponse !== null) {
          return noindex(withSecurityHeaders(await apiResponse, { private: true }));
        }

        // --- Stable shareable episode URL (resolves to the hashed asset). ---
        const stableSlug = stableEpisodeSlug(new URL(req.url).pathname);
        if (stableSlug !== null) {
          const episode = await serveStableEpisode(req, env, stableSlug, content.episodeAudio);
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
      } catch (err) {
        // Global error boundary: any unhandled throw from a route handler or
        // asset path returns RFC 9457 problem+json (never Cloudflare's default
        // HTML error page), keeping the API contract that every egress is a
        // properly-headed JSON error. Private posture: no caching, CORP-guarded.
        console.error("Unhandled error in Worker fetch:", err);
        return noindex(
          withSecurityHeaders(
            problem(StatusCodes.INTERNAL_SERVER_ERROR, "about:blank"),
            { private: true },
          ),
        );
      }
    },
  };
}
