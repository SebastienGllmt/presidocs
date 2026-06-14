// The blog-level privacy knob (methodology → Private blogs).
//
// `BLOG_PRIVATE=1` (or `true`) in the content repo's `.env` marks the whole
// deploy as a capability-URL blog: posts are reachable only by people given
// the link, so every discovery emitter consults this — the same
// config-as-data pattern the `SITE_URL` gates use, never scattered
// `if (prod)`-style branching. The build-time knob is the source of truth;
// the Worker reads the BAKED form (`SITE_PRIVATE` in the generated
// `postMeta.ts`, threaded as `WorkerContent.sitePrivate`) rather than a
// runtime var, so privacy can't drift between a build and its deploy config.
//
// Suppression happens at each emitter; `generate/audit-private.ts` is the
// allowlist-shaped proof that all of them did (belt and suspenders).

/** True iff this build is a private (capability-URL) blog. */
export function isPrivateBlog(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.BLOG_PRIVATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * The unguessable-slug token contract (methodology → Private blogs): every post filename in
 * a private blog ends `--<token>` where the token is ≥11 base64url chars
 * (≈64 bits — calibrated to ONLINE guessing against the worker, where even
 * 2^64 at a generous 10^6 req/s is ~580k years; `new-post` generates 16 chars
 * ≈ 96 bits). base64url's alphabet contains `-`, so consumers key on the
 * segment after the LAST `--`. `_`-prefixed dev-only posts are exempt — they
 * never deploy (build-html skips them).
 */
export const PRIVATE_SLUG_TOKEN_RE = /--[A-Za-z0-9_-]{11,}$/;

/** Token length `new-post` generates (base64url chars; ~6 bits each). */
export const PRIVATE_SLUG_TOKEN_CHARS = 16;
