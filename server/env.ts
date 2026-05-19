// Worker bindings exposed via the `env` argument to `fetch`. Secrets
// (SESSION_SECRET, *_OAUTH_*) are mapped into `process.env` by
// `nodejs_compat`, so route code that reads them via `process.env.*`
// works unchanged in both Bun dev and Workers prod. Only the *bindings*
// (R2, rate limiter, assets fetcher) and non-secret vars need to be
// threaded through this object.

import type { R2Bucket, Fetcher, RateLimit } from "@cloudflare/workers-types";

export type Env = {
  // R2 bucket holding per-(post,user) Automerge comment blobs at
  // `comments/<postPath>/<userId>.amrg`. Bucket is private; access
  // gated entirely in `server/comments/routes.ts`.
  COMMENTS: R2Bucket;

  // Workers Rate Limiting API binding. Configured with a per-period
  // limit in wrangler.toml; we key it by `userId` so authenticated
  // floods are caught at the source.
  RATE_LIMITER: RateLimit;

  // Static assets binding — the built `dist/` directory from
  // `bun run build`. The Worker `fetch` handler falls through to this
  // for any request that doesn't match an API route.
  ASSETS: Fetcher;
};
