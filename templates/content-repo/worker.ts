// Cloudflare Worker entry for my-blog. Thin wrapper over the engine's
// worker factory (in the `presidocs` package). Supplies this blog's build-time
// post maps from `.generated/` (produced by `bun run build`).

import { createWorkerHandler } from "presidocs/server/createWorker.ts";
import { POST_AUTHORS, SITE_HOST, SITE_PRIVATE } from "./.generated/postMeta.ts";
import { POST_VERSIONS } from "./.generated/postVersions.ts";
import { EPISODE_AUDIO } from "./.generated/episodeAudio.ts";

export default createWorkerHandler({
  postAuthors: POST_AUTHORS,
  postVersions: POST_VERSIONS,
  siteHost: SITE_HOST,
  sitePrivate: SITE_PRIVATE,
  episodeAudio: EPISODE_AUDIO,
});
