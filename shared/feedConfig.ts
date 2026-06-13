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

import { z } from "zod";
import { envFlag, trimmedOr, trimmedOrNull } from "./envSchemas.ts";
import { resolveLicenseConfig } from "./licenseConfig.ts";

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
   * `<podcast:license>` for the audio/episodes. An identifier from the Podcast
   * Namespace license list (e.g. `CC-BY-4.0`) for a well-known public license,
   * or a free-form abbreviation for a custom one. Null → omit the tag.
   *
   * INHERITS `CONTENT_LICENSE` when `PODCAST_LICENSE` is unset: the narrated
   * audio is a rendition of the prose, so the content license is the right
   * default for it (see shared/licenseConfig.ts / proposal 59). An explicit
   * `PODCAST_LICENSE` still wins for an author who licenses audio differently;
   * with neither set, it stays null.
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
   * and websub-ping.ts pings it), not just the project homepage. Pick a hub
   * that accepts a publish for a topic nobody has subscribed to yet (some
   * reject it). Recommended public hubs: https://pubsubhubbub.superfeedr.com
   * or Google's long-running https://pubsubhubbub.appspot.com/.
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

// One schema for the feed env surface, built from the shared idiom helpers.
// `SITE_URL` is normalized (trim + strip trailing slashes) here; the https
// deployment policy stays a post-parse semantic guard in `resolveFeedConfig`
// (it throws with a specific message — zod doesn't simplify a guard, it just
// relocates the value). The two booleans pin their exact token rules via
// `envFlag` (`PODCAST_EXPLICIT` true only for "true"; `PODCAST_LOCKED` false
// only for "no", default true).
const FeedEnv = z.object({
  SITE_URL: z
    .string()
    .default("")
    .transform((v) => v.trim().replace(/\/+$/, "")),
  FEED_LANGUAGE: trimmedOr("en-US"),
  PODCAST_CATEGORY: trimmedOr("Technology"),
  PODCAST_EXPLICIT: envFlag({ truthy: ["true"] }),
  PODCAST_OWNER_EMAIL: trimmedOrNull,
  WEBSUB_HUB: trimmedOrNull,
  PODCAST_LOCKED: envFlag({ falsy: ["no"] }),
  PODCAST_LICENSE: trimmedOrNull,
  PODCAST_LICENSE_URL: trimmedOrNull,
});

export function resolveFeedConfig(env: Record<string, string | undefined> = process.env): FeedConfig {
  const e = FeedEnv.parse(env);
  const raw = e.SITE_URL;
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
  // Podcast license inherits the content license when not set explicitly (the
  // audio is a rendition of the prose). An explicit PODCAST_LICENSE keeps its
  // own (optional) URL; an inherited one carries the content license's resolved
  // URL so a custom inherited identifier still satisfies the spec's url rule.
  const license = resolveLicenseConfig(env);
  const podcastLicense = e.PODCAST_LICENSE ?? license.content?.id ?? null;
  const podcastLicenseUrl = e.PODCAST_LICENSE
    ? e.PODCAST_LICENSE_URL
    : (license.content?.url ?? null);
  return {
    baseUrl: raw || null,
    language: e.FEED_LANGUAGE,
    category: e.PODCAST_CATEGORY,
    explicit: e.PODCAST_EXPLICIT,
    ownerEmail: e.PODCAST_OWNER_EMAIL,
    hubUrl: e.WEBSUB_HUB,
    locked: e.PODCAST_LOCKED,
    license: podcastLicense,
    licenseUrl: podcastLicenseUrl,
  };
}
