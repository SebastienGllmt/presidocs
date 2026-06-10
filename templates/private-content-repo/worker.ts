// Cloudflare Worker entry for my-private-blog. Thin wrapper over the engine's
// worker factory (in the `presidocs` package). Supplies this blog's build-time
// post maps from `.generated/` (produced by `bun run build`). SITE_PRIVATE is
// baked true here (BLOG_PRIVATE=1 at build), so the Worker noindexes every
// response — see engine methodology.md → Private blogs.

import { createWorkerHandler } from "presidocs/server/createWorker.ts";
import { POST_AUTHORS, SITE_HOST, SITE_PRIVATE } from "./.generated/postMeta.ts";
import { POST_VERSIONS } from "./.generated/postVersions.ts";

export default createWorkerHandler({
  postAuthors: POST_AUTHORS,
  postVersions: POST_VERSIONS,
  siteHost: SITE_HOST,
  sitePrivate: SITE_PRIVATE,
});
