// Asset/codegen-serving plumbing for the production Cloudflare Worker, split out
// of createWorker.ts (the routing/orchestration entry factory imports these).
// This is the prod side of the dev↔prod serving parity: the range-support
// wrapper over the `ASSETS` binding, the R2/asset audio byte fetcher, the
// content-type / CORS overrides the binding's extension default can't give, and
// the stable-episode resolver. The ETag/Range/206/416/If-Range/304 machinery
// itself lives in server/serveAsset.ts (the shared owner); this module owns only
// the Worker-runtime plumbing that feeds bytes into it.
//
// methodology.md → "Serving generated audio" / "Stable shareable episode URL" /
// "Dev server HTTP range support" (prod parity half).

import { StatusCodes } from "http-status-codes";
import type { Env } from "./env.ts";
import { isResolvableRangeHeader } from "../shared/httpRange.ts";
import { audioEtag } from "../shared/stableAudio.ts";
import {
  conditionalNotModified,
  serveAsset,
  stableEpisodeResponseHeaders,
  type IfRangePolicy,
} from "./serveAsset.ts";

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
export async function applyRangeSupport(
  req: Request,
  res: Response,
  ifRange: IfRangePolicy = { kind: "ignore" },
): Promise<Response> {
  // Only meaningful for a successful, bodied GET; non-200 (binding 304/404)
  // passes through untouched. ASSETS returns 200 for hits.
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
  // D2 preserved: an unparseable Range gets the original 200 back, unbuffered —
  // same posture as before the shared-parser refactor.
  if (!isResolvableRangeHeader(range)) return res;

  // Satisfy the range by buffering the (cached, fast-to-read) asset and handing
  // it to the shared serving engine, which owns 206/416/If-Range shaping. The
  // 416 gains policy headers here (D1) vs the old fresh-Response 416.
  const buf = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  return serveAsset(
    {
      size: buf.byteLength,
      slice: (s, e) => buf.subarray(s, e + 1),
      whole: () => buf,
    },
    { method: req.method, requestHeaders: req.headers, headers, ifRange },
  );
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
export async function fetchAudioBytes(env: Env, audioPath: string, baseUrl: string): Promise<Response> {
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

// Serve the STABLE shareable episode URL `/generated/<slug>/episode.<ext>` by
// resolving it to the current content-addressed asset via the build-time map,
// then serving those bytes with a revalidating policy (strong ETag = content
// hash, no `immutable`) — see shared/stableAudio.ts and methodology.md →
// Stable shareable episode URL. Returns
// null when the slug is unknown or the mapped asset is missing, so the caller
// falls through to the static-asset 404. The in-page player and feeds still
// hit the hashed URL directly; only copied/feed links use this route.
//
// The `episodeAudio` build-time map is threaded in by the entry factory (it's a
// field on `WorkerContent`) so this resolver stays free of the factory closure.
export async function serveStableEpisode(
  req: Request,
  env: Env,
  slug: string,
  episodeAudio: Record<string, { audio: string; digest?: string }> | undefined,
): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const entry = episodeAudio?.[slug];
  if (!entry) return null;
  const audioPath = entry.audio;

  const etag = audioEtag(audioPath);
  // The stable-episode header contract (strong ETag + no-cache +
  // CDN-Cache-Control + inline per-post Content-Disposition + Repr-Digest),
  // shared verbatim with the dev server. See server/serveAsset.ts.
  const policy = stableEpisodeResponseHeaders({
    etag,
    slug,
    ext: audioPath.split(".").pop() ?? "mp3",
    digest: entry.digest,
  });

  // Conditional GET short-circuits to 304 BEFORE the R2/ASSETS read (RFC 9110
  // §15.4.5 — echo the cache-affecting headers a 200 would carry). Keeping
  // this out of serveAsset preserves prod's fetch-avoidance cost model.
  const notMod = conditionalNotModified(req.headers, etag, policy);
  if (notMod) return notMod;

  // Resolve the stable name to the live track bytes — from R2 when bound, else
  // the asset bundle (fetchAudioBytes). The source returns the whole body and
  // ignores Range; applyRangeSupport slices below.
  const asset = await fetchAudioBytes(env, audioPath, req.url);
  if (asset.status !== 200) return null; // map points at a swept/missing object

  // Our validator + cache policy REPLACE whatever the binding emitted; we
  // validate on the strong content-hash ETag only.
  const headers = new Headers(asset.headers);
  for (const [k, v] of Object.entries(policy)) headers.set(k, v);
  headers.delete("Last-Modified");

  const full = new Response(asset.body, {
    status: StatusCodes.OK,
    statusText: "OK",
    headers,
  });

  // HEAD flows through too: applyRangeSupport returns the bodied 200 (it
  // special-cases HEAD), and the runtime strips the body while KEEPING
  // Content-Length. (Returning `Response(null, …)` here would make the
  // runtime drop Content-Length — RFC 9110 §9.3.2 wants HEAD to carry it.)

  // If-Range now lives inside serveAsset (strong-etag policy): a mismatch
  // serves the full 200; a match lets the range through. The strong ETag
  // rides onto the 206 so caches combine ranges only within one version (RFC
  // 9110 §13.1.5 / §15.3.7, RFC 9111 §3.4).
  return applyRangeSupport(req, full, { kind: "strong-etag", etag });
}
