// Content-addressed naming for the narration manifest.
//
// The manifest is written as `manifest.<hash>.json` (the first 16 hex of a
// sha256 over its narration-bearing fields), mirroring the `full.<hash>.mp3`
// scheme in generate.ts. A content-addressed URL is the only thing that
// survives EVERY cache layer in the path: the browser's media cache, the
// service worker's cache-first store (client/sw.js), and the Cloudflare edge
// all ignore plain revalidation for these surfaces. Served at a STABLE url, a
// manifest gets pinned to whatever version a cache saw first; because the
// manifest is the index the player reads to discover the current
// `full.<hash>.mp3` URL, a stale copy points the <audio> element at a
// swept hash → `NotSupportedError` on play. Hashing the filename makes the
// URL change whenever the narration changes, so the stale copy is simply never
// requested again.
//
// Writer: generate.ts. URL rewrite for the served HTML: strip-served-html.ts.
// Dev fallback (bare `manifest.json` request → hashed file): createDevServer.ts.

import { readdir } from "node:fs/promises";

/** Matches a content-addressed manifest filename (`manifest.<16 hex>.json`). */
export const MANIFEST_HASHED_RE = /^manifest\.[0-9a-f]{16}\.json$/;

/** Matches a content-addressed full-track audio filename (`full.<16 hex>.<ext>`). */
export const FULL_AUDIO_HASHED_RE = /^full\.[0-9a-f]{16}\.[a-z0-9]+$/i;

/** Matches a content-addressed social-media video filename (`video.<16 hex>.mp4|webm`). */
export const VIDEO_HASHED_RE = /^video\.[0-9a-f]{16}\.(mp4|webm)$/;

export function manifestFileName(hash: string): string {
  return `manifest.${hash}.json`;
}

/**
 * Resolve the current full-track audio filename inside a post's generated
 * directory — the live `full.<hash>.<ext>` that the STABLE `episode.<ext>` URL
 * maps to (see shared/stableAudio.ts). Optionally constrained to an extension
 * (e.g. `.mp3`). Falls back to a legacy bare `full.<ext>`; null when absent.
 *
 * The build ships exactly one hashed track per post (copy-static.ts mirrors
 * `generated/` and sweeps superseded hashes), so the choice is unambiguous in
 * prod; if several coexist mid-regenerate in dev, pick deterministically.
 */
export async function findFullAudioName(
  dir: string,
  ext?: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const wantExt = ext ? ext.toLowerCase() : null;
  const hashed = entries
    .filter(
      (f) =>
        FULL_AUDIO_HASHED_RE.test(f) &&
        (!wantExt || f.toLowerCase().endsWith(wantExt)),
    )
    .sort();
  if (hashed.length > 0) return hashed[hashed.length - 1]!;
  const bare = entries.find(
    (f) =>
      /^full\.[a-z0-9]+$/i.test(f) && (!wantExt || f.toLowerCase().endsWith(wantExt)),
  );
  return bare ?? null;
}

/**
 * Resolve the manifest filename inside a post's generated directory. Returns the
 * content-addressed `manifest.<hash>.json` when present; falls back to a legacy
 * bare `manifest.json` (a dir generated before this scheme landed); or null when
 * the post has no manifest at all.
 */
export async function findManifestName(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const hashed = entries.find((f) => MANIFEST_HASHED_RE.test(f));
  if (hashed) return hashed;
  return entries.includes("manifest.json") ? "manifest.json" : null;
}
