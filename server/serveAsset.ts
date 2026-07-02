// The single owner of the ETag/Range/206/416/If-Range/304 orchestration that
// both createWorker.ts (prod Worker) and createDevServer.ts (Bun dev server)
// serve. Each caller keeps its runtime-specific plumbing (byte sources, path
// resolution, cache-posture decisions) and passes it in as DATA — this module
// has no `Bun.*`, no `env.*`, and no `isDev` fork.
//
// methodology.md → "Dev server HTTP range support" / "Stable shareable episode
// URL" / "Serving generated audio".

import { StatusCodes } from "http-status-codes";
import {
  contentRangeHeader,
  resolveRange,
  unsatisfiedRangeHeader,
} from "../shared/httpRange.ts";
import {
  episodeDownloadName,
  ifNoneMatchSatisfied,
  rangeHonored,
  stableAudioHeaders,
} from "../shared/stableAudio.ts";
import { isSha256Hex, reprDigestSha256 } from "../shared/audioDigest.ts";
import { problem } from "../shared/problemDetails.ts";

/** Byte source for one selected representation. Callers adapt their runtime:
 *  dev wraps a Bun.file (lazy slice), prod wraps a buffered Uint8Array. */
export type AssetSource = {
  /** Representation size in bytes (the RangeOutcome math runs against this). */
  size: number;
  /** Bytes [start, end] INCLUSIVE (mirrors shared/httpRange RangeOutcome). */
  slice(start: number, end: number): BodyInit;
  /** The whole representation (streaming where the runtime allows). */
  whole(): BodyInit;
};

/** How a request `If-Range` header is treated:
 *  - "strong-etag": honor Range only on an exact strong match of `etag`
 *    (rangeHonored) — the stable-episode posture in BOTH servers. etag null
 *    (legacy un-hashed track) ⇒ any If-Range mismatches ⇒ full 200.
 *  - "ignore": honor Range regardless. The posture for content-hashed and
 *    other assets in BOTH servers today (the upstream validator is unknown
 *    here and hashed bytes cannot change under their URL). NOT a default —
 *    every caller states it. */
export type IfRangePolicy =
  | { kind: "strong-etag"; etag: string | null }
  | { kind: "ignore" };

export type ServeAssetOptions = {
  method: string; // req.method — HEAD suppresses Range handling
  requestHeaders: Headers; // Range / If-Range are read from here
  /** Policy headers carried on EVERY outcome (200/206/416): Cache-Control,
   *  Content-Type (or none — Bun infers from a Blob body), ETag,
   *  Accept-Ranges, Content-Disposition, Repr-Digest, CDN-Cache-Control,
   *  Link. The module adds only Content-Range/Content-Length. */
  headers: HeadersInit;
  ifRange: IfRangePolicy;
};

/** Range/206/416/HEAD orchestration for an already-resolved asset.
 *  Does NOT evaluate If-None-Match — call conditionalNotModified() first
 *  (kept separate so prod can 304 BEFORE fetching R2 bytes). Pure:
 *  (source, options) → Response; no IO. */
export function serveAsset(source: AssetSource, opts: ServeAssetOptions): Response {
  const { method, requestHeaders, headers, ifRange } = opts;

  // Step 1: effective range. HEAD suppresses Range (→ full bodied 200 that the
  // runtime strips while keeping Content-Length, RFC 9110 §9.3.2). An If-Range
  // mismatch under the strong-etag policy serves the full current
  // representation (so a mid-seek client can't stitch two versions). The
  // "ignore" policy honors Range regardless of any If-Range (immutable bytes).
  let effectiveRange: string | null;
  if (method === "HEAD") {
    effectiveRange = null;
  } else if (
    ifRange.kind === "strong-etag" &&
    !rangeHonored(requestHeaders.get("If-Range"), ifRange.etag)
  ) {
    effectiveRange = null;
  } else {
    effectiveRange = requestHeaders.get("Range");
  }

  const outcome = resolveRange(effectiveRange, source.size);

  if (outcome.kind === "none") {
    const h = new Headers(headers);
    h.set("Content-Length", String(source.size));
    return new Response(source.whole(), {
      status: StatusCodes.OK,
      statusText: "OK",
      headers: h,
    });
  }

  if (outcome.kind === "satisfiable") {
    const { start, end, size } = outcome;
    const h = new Headers(headers);
    h.set("Content-Range", contentRangeHeader(start, end, size));
    h.set("Content-Length", String(end - start + 1));
    return new Response(source.slice(start, end), {
      status: StatusCodes.PARTIAL_CONTENT,
      statusText: "Partial Content",
      headers: h,
    });
  }

  // unsatisfiable → 416. D1 reconciled shape: RFC 9457 problem+json body (prod's
  // everywhere-contract) PLUS the policy headers merged on (dev's RFC-friendlier
  // Accept-Ranges/ETag/CC survival), skipping Content-Type/Content-Length which
  // the problem body owns. Content-Range carries the selected size (RFC 9110
  // §15.5.17).
  const res = problem(StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE, "about:blank");
  for (const [k, v] of new Headers(headers)) {
    const lower = k.toLowerCase();
    if (lower === "content-type" || lower === "content-length") continue;
    res.headers.set(k, v);
  }
  res.headers.set("Content-Range", unsatisfiedRangeHeader(outcome.size));
  return res;
}

/** The If-None-Match → 304 short-circuit. Returns the 304 (body null,
 *  `headers` echoed per RFC 9110 §15.4.5) or null to proceed. Null etag ⇒
 *  always null. Safe to call unconditionally. */
export function conditionalNotModified(
  requestHeaders: Headers,
  etag: string | null,
  headers: HeadersInit,
): Response | null {
  if (!ifNoneMatchSatisfied(requestHeaders.get("If-None-Match"), etag)) return null;
  return new Response(null, {
    status: StatusCodes.NOT_MODIFIED,
    headers: new Headers(headers),
  });
}

/** The stable-episode header contract, shared verbatim by both servers:
 *  stableAudioHeaders(etag, episodeDownloadName(slug, ext)) plus `Repr-Digest`
 *  when `digest` is sha-256 hex (RFC 9530). Returns a plain record so callers
 *  can spread/merge (dev adds Link; prod merges over the upstream asset headers
 *  and deletes Last-Modified). */
export function stableEpisodeResponseHeaders(opts: {
  etag: string | null;
  slug: string;
  ext: string; // with or without leading dot
  digest?: string | null;
}): Record<string, string> {
  const headers = stableAudioHeaders(
    opts.etag,
    episodeDownloadName(opts.slug, opts.ext),
  );
  if (opts.digest && isSha256Hex(opts.digest)) {
    headers["Repr-Digest"] = reprDigestSha256(opts.digest);
  }
  return headers;
}
