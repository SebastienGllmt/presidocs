// Stable, shareable episode-audio URL — the spec-grounded counterpart to the
// content-addressed `full.<hash>.mp3` scheme.
//
// Background (see proposals/32-stable-shareable-audio-url.md): the player and
// the bundle use content-addressed URLs so a cache can never serve stale bytes
// (new bytes ⇒ new URL). But a URL someone COPIES (the "Copy episode audio"
// button) or that we embed in a podcast `<enclosure>` can never be rewritten
// once it's in a clipboard or a cached feed — so for those surfaces we expose a
// STABLE name, `/generated/<slug>/episode.<ext>`, and move cache-busting off
// "URL identity" and onto HTTP validation (a strong ETag = the content hash).
//
// This module holds the runtime-agnostic helpers shared by both servers so dev
// (createDevServer.ts, Bun) and prod (createWorker.ts, Workers) resolve the
// stable URL and compute the SAME headers — the house rule that dev mirrors
// prod. The pieces that differ (how each runtime locates the current hashed
// file: dev globs the dir, prod reads the build-time map) live in each server.
//
// Cache policy rationale (RFCs verified against specs/ mirror, cited in §7/§9
// of the proposal):
//   - strong `ETag` = the 16-hex content hash (RFC 9110 §8.8.1): unchanged ⇒
//     cheap 304, changed ⇒ 200 with new bytes. Strong (no `W/`) so it can also
//     validate `If-Range` and let a cache combine ranges (RFC 9111 §3.4).
//   - `Cache-Control: no-cache` to the browser (RFC 9111 §5.2.2.4 — store but
//     always revalidate; NOT don't-store).
//   - `CDN-Cache-Control: max-age + stale-while-revalidate` to the CDN tier
//     (RFC 9213 + RFC 5861): heavy edge offload with bounded staleness.
//   - deliberately NO `immutable` (that's RFC 8246's directive for the
//     versioned hashed path) and NO `must-revalidate` (RFC 9111 §5.2.2.2 would
//     forbid the stale-while-revalidate serving above).

/** Matches a stable episode URL path: `/generated/<slug>/episode.<ext>`. */
export const STABLE_EPISODE_RE = /^\/generated\/([^/]+)\/episode\.[a-z0-9]+$/;

/**
 * Matches the content-addressed audio filename or path
 * (`full.<16 hex>.<ext>`), capturing the hash. Anchored to the basename so it
 * matches both a bare filename and a full URL/path.
 */
export const HASHED_AUDIO_RE = /(?:^|\/)full\.([0-9a-f]{16})\.[a-z0-9]+$/i;

/** The slug from a stable episode path, or null when the path isn't one. */
export function stableEpisodeSlug(path: string): string | null {
  const m = STABLE_EPISODE_RE.exec(path);
  return m ? m[1]! : null;
}

/**
 * The strong ETag for an episode, derived from its content-addressed audio path
 * (`…/full.<hash>.<ext>` → `"<hash>"`). Null for a legacy bare `full.<ext>`
 * with no hash — callers then fall back to whatever validator the asset layer
 * supplies and serve conservatively (never reuse a Range across versions).
 */
export function audioEtag(audioPath: string): string | null {
  const m = HASHED_AUDIO_RE.exec(audioPath);
  return m ? `"${m[1]!.toLowerCase()}"` : null;
}

/**
 * Derive the stable episode path from a content-addressed audio path:
 * `…/full.<hash>.<ext>` (or a legacy `…/full.<ext>`) → `…/episode.<ext>`.
 * Anchored to the trailing filename, so it works on both a bare path and a full
 * URL. Returns the input unchanged when it isn't a recognizable full-track path
 * (so a caller never hands out nothing). The single source of the shareable-URL
 * derivation — used by the copy button (client/subscribe.ts) and the podcast /
 * Atom enclosure (generate/feeds.ts) so both produce identical URLs.
 */
export function stableEpisodePath(audioPath: string): string {
  return audioPath.replace(/\/full(?:\.[0-9a-f]{16})?(\.[a-z0-9]+)$/i, "/episode$1");
}

/** The tiered cache headers for a stable episode response (see file header). */
export function stableAudioHeaders(etag: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-cache",
    "CDN-Cache-Control": "max-age=60, stale-while-revalidate=604800",
    "Accept-Ranges": "bytes",
  };
  if (etag) headers["ETag"] = etag;
  return headers;
}

/**
 * Whether an `If-None-Match` request header is satisfied by our ETag (⇒ 304).
 * `*` matches any current representation; otherwise the weak comparison of
 * RFC 9110 §13.1.2 (ignore a leading `W/`) — fine here since our ETag is strong.
 */
export function ifNoneMatchSatisfied(
  header: string | null,
  etag: string | null,
): boolean {
  if (!header || !etag) return false;
  const tags = header.split(",").map((s) => s.trim());
  if (tags.includes("*")) return true;
  const bare = (t: string) => t.replace(/^W\//, "");
  return tags.some((t) => bare(t) === bare(etag));
}

/**
 * Whether to honor a `Range` request given any `If-Range` header (RFC 9110
 * §13.1.5). No `If-Range` ⇒ honor. With `If-Range`, honor only on an exact
 * STRONG match of our ETag; on any mismatch (or an HTTP-date form we can't
 * validate — we send no `Last-Modified`) ⇒ ignore Range and serve the full
 * current representation, so a client mid-seek can't stitch two versions.
 */
export function rangeHonored(ifRange: string | null, etag: string | null): boolean {
  if (!ifRange) return true;
  if (!etag) return false;
  return ifRange.trim() === etag; // strong comparison: byte-for-byte, no W/
}
