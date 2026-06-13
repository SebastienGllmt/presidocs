// Worker bindings exposed via the `env` argument to `fetch`. Secrets
// (SESSION_SECRET, *_OAUTH_*) are mapped into `process.env` by
// `nodejs_compat`, so route code that reads them via `process.env.*`
// works unchanged in both Bun dev and Workers prod. Only the *bindings*
// (R2, rate limiter, assets fetcher) and non-secret vars need to be
// threaded through this object.

import type {
  AnalyticsEngineDataset,
  R2Bucket,
  Fetcher,
  RateLimit,
} from "@cloudflare/workers-types";

export type Env = {
  // R2 bucket holding per-(post,user) Automerge comment blobs at
  // `comments/<postPath>/<userId>.amrg`. Bucket is private; access
  // gated entirely in `server/comments/routes.ts`.
  COMMENTS: R2Bucket;

  // Workers Rate Limiting API binding. Configured with a per-period
  // limit in wrangler.toml; we key it by `userId` so authenticated
  // floods are caught at the source.
  RATE_LIMITER: RateLimit;

  // Workers Rate Limiting API binding for the analytics beacon route.
  // Keyed on edge IP. A separate limiter from RATE_LIMITER so the
  // anonymous beacon traffic (potentially fired from every page load)
  // doesn't share a budget with the authenticated comment writes.
  // Optional — absent means no rate limiting on /_a (acceptable in dev
  // and for content repos that haven't added the binding yet).
  ANALYTICS_RATE_LIMITER?: RateLimit;

  // Static assets binding — the built `dist/` directory from
  // `bun run build`. The Worker `fetch` handler falls through to this
  // for any request that doesn't match an API route.
  ASSETS: Fetcher;

  // R2 bucket holding the full narration tracks (`generated/<slug>/full.<hash>.<ext>`).
  // Served by the Worker instead of the `[assets]` bundle because a long track can
  // exceed Cloudflare's hard 25 MiB per-static-asset limit; R2 has no such cap.
  // Optional: a content repo without the binding (its tracks all under the cap)
  // falls back to the ASSETS path — see `createWorker.ts` `fetchAudioBytes`.
  AUDIO?: R2Bucket;

  // Cloudflare Analytics Engine dataset for engagement events
  // (page_view, narration_play, narration_quartile). Write-only from
  // the Worker via `server/analyticsRoute.ts`; queried by the operator
  // through Cloudflare's GraphQL/SQL endpoint. Anonymous: no userId,
  // no IP retention — see methodology.md → "Engagement analytics".
  // Optional so a content repo that hasn't wired the binding yet still
  // deploys; an absent binding turns the analytics route into a no-op.
  ANALYTICS?: AnalyticsEngineDataset;
};
