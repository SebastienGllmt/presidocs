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
  /**
   * `<podcast:locked>` value. Defaults to `true` (`yes`) — the feed is
   * single-owner and self-hosted, so the anti-hijack signal that rejects
   * import into another hosting platform is a safe default (flip to migrate).
   * Only an explicit `PODCAST_LOCKED=no` disables it. The `owner` attribute is
   * emitted only when `ownerEmail` is set (reuses the existing opt-in; no new
   * public-surface email).
   */
  locked: boolean;
  /**
   * Opt-in `<podcast:license>` for the audio/episodes. A lower-cased identifier
   * from the Podcast Namespace license list (e.g. `CC-BY-4.0`) for a well-known
   * public license, or a free-form abbreviation for a custom one. Null → omit
   * the tag (no wrong default).
   */
  license: string | null;
  /**
   * URL to the full legal text for `license`. Optional for well-known licenses
   * (clients resolve the identifier), REQUIRED by the spec for custom ones.
   */
  licenseUrl: string | null;
  /**
   * Opt-in WebSub hub URL ([WebSub] — a `<link rel="hub">` the feeds declare so
   * subscribers' tools can get pushed updates instead of polling). Empty → no
   * hub link is emitted and the post-deploy ping is a no-op. Kept env-driven
   * and defaultless on purpose: it names a third-party (or self-hosted) service,
   * so the operator chooses it explicitly rather than the engine baking in a
   * dependency. Must be the hub's POST endpoint (subscribers register with it
   * and websub-ping.ts pings it), not just the project homepage. Recommended
   * public hubs: https://websubhub.com/hub or Google's long-running
   * https://pubsubhubbub.appspot.com/.
   */
  hubUrl: string | null;
};

/** Loopback origins where plain `http:` is fine (local dev, never published). */
function isLoopbackOrigin(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    return (
      h === "localhost" ||
      h.endsWith(".localhost") || // RFC 6761: the whole .localhost TLD is loopback
      /^127(\.\d{1,3}){3}$/.test(h) || // entire 127.0.0.0/8, not just 127.0.0.1
      h === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveFeedConfig(env: Record<string, string | undefined> = process.env): FeedConfig {
  const raw = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  // Deployment policy (not a local-spec MUST): a published feed must use https.
  // `baseUrl` prefixes every <enclosure>/<podcast:source> URL, and a plain-http
  // origin yields http: feed URLs that podcast directories (Apple, Spotify)
  // reject. It also aligns with the Podcasting 2.0 namespace's "hyper-text
  // resource URLs must be https" guidance — but that rule lives in the UPSTREAM
  // namespace intro (podcastindex.org/namespace/1.0), NOT in our tag-subset
  // `specs/PodcastNamespace-spec.md`, so we enforce it as policy here rather than
  // cite the mirror for it. Loopback http is allowed — local dev never publishes.
  if (raw && /^http:\/\//i.test(raw) && !isLoopbackOrigin(raw)) {
    throw new Error(
      `SITE_URL must use https:// for a published build (got "${raw}"): feed ` +
        `enclosure URLs must be https for podcast directories. ` +
        `http://localhost (or any 127.0.0.0/8 / ::1) is allowed for local dev.`,
    );
  }
  return {
    baseUrl: raw || null,
    language: (env.FEED_LANGUAGE ?? "").trim() || "en-US",
    category: (env.PODCAST_CATEGORY ?? "").trim() || "Technology",
    explicit: (env.PODCAST_EXPLICIT ?? "").trim().toLowerCase() === "true",
    ownerEmail: (env.PODCAST_OWNER_EMAIL ?? "").trim() || null,
    hubUrl: (env.WEBSUB_HUB ?? "").trim() || null,
    // Default locked; only an explicit "no" (case-insensitive) opts out.
    locked: (env.PODCAST_LOCKED ?? "").trim().toLowerCase() !== "no",
    license: (env.PODCAST_LICENSE ?? "").trim() || null,
    licenseUrl: (env.PODCAST_LICENSE_URL ?? "").trim() || null,
  };
}
