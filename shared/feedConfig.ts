// Resolved configuration for the Atom + Podcast RSS feeds (generate/feeds.ts).
//
// The engine stays content-agnostic: the site TITLE and DESCRIPTION are read
// from the blog's own landing `index.html` at build time (not hardcoded here),
// and the per-post AUTHOR comes from the same public profile the byline uses
// (shared/authorProfile.ts) — so this config holds only the genuinely
// deploy-level knobs, all env-driven with sensible defaults.
//
// `SITE_URL` is the single canonical-origin var (shared with the structured-data
// inject — see generate/strip-served-html.ts); feeds need absolute URLs for
// every link/enclosure, so with no SITE_URL the feed step is skipped entirely
// (same fail-silent posture as the structured-data and analytics injects).
//
// Podcast owner email is OPT-IN (`PODCAST_OWNER_EMAIL`), never auto-pulled from
// `<meta name="author-email">`: that address is deliberately kept off every
// public surface (see "Per-post author metadata"), and a podcast feed is exactly
// such a surface. Apple Podcasts *directory submission* requires an owner email,
// so an author who wants to list there sets the var explicitly; otherwise the
// feed omits it and still works in every podcast app that auto-discovers it.

export type FeedConfig = {
  /** Canonical origin, no trailing slash. Null → feeds are skipped. */
  baseUrl: string | null;
  language: string;
  category: string;
  explicit: boolean;
  /** Opt-in podcast owner contact (Apple directory submission). */
  ownerEmail: string | null;
};

export function resolveFeedConfig(env: Record<string, string | undefined> = process.env): FeedConfig {
  const raw = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  return {
    baseUrl: raw || null,
    language: (env.FEED_LANGUAGE ?? "").trim() || "en-US",
    category: (env.PODCAST_CATEGORY ?? "").trim() || "Technology",
    explicit: (env.PODCAST_EXPLICIT ?? "").trim().toLowerCase() === "true",
    ownerEmail: (env.PODCAST_OWNER_EMAIL ?? "").trim() || null,
  };
}
