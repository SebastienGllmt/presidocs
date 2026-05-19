// Cloudflare Worker entry point for production. Mirrors the route table
// in `index.ts` (the Bun dev server) so dev and prod resolve the same
// URLs the same way. Static assets (the bundled article + JS + audio)
// are served via the `ASSETS` binding; anything that doesn't match an
// API route falls through to it.
//
// Bindings live in `wrangler.toml`. Secrets (`SESSION_SECRET`, the
// OAuth `*_CLIENT_*` pairs) are managed via `wrangler secret put …`
// and exposed through `process.env` by the `nodejs_compat` flag, so the
// auth code in `server/auth/` reads them via `process.env.*` unchanged
// — same code path as dev.

import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./server/env.ts";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./server/auth/routes.ts";
import { handleCommentsRequest } from "./server/comments/routes.ts";
import { r2Adapter } from "./server/comments/r2Adapter.ts";
import { createPostMetaIndex } from "./server/postMeta.ts";
import { POST_AUTHORS } from "./server/postMeta.generated.ts";

// Built once at module load — the map is static for the lifetime of
// the Worker (regenerated only when a new build is deployed).
const postMetaIndex = createPostMetaIndex(POST_AUTHORS);

export default {
  async fetch(
    req: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Auth routes (handlers are runtime-agnostic; see Deploy
    //     architecture in methodology.md). ---
    if (path === "/auth/google") return startGoogleAuth(req);
    if (path === "/auth/google/callback") return googleCallback(req);
    if (path === "/auth/microsoft") return startMicrosoftAuth(req);
    if (path === "/auth/microsoft/callback") return microsoftCallback(req);
    if (path === "/auth/me") return whoami(req);
    if (path === "/auth/logout" && req.method === "POST") return logout(req);

    // --- Comments R2 proxy. ---
    if (path === "/comments") {
      return handleCommentsRequest(req, {
        store: r2Adapter(env.COMMENTS),
        postMeta: postMetaIndex,
        rateLimiter: env.RATE_LIMITER,
      });
    }

    // --- Static assets fall-through. The Workers Static Assets binding
    //     handles caching headers and 404s for us. ---
    // @ts-expect-error - ASSETS.fetch takes the same Request shape but
    //     types between the runtime Request and DOM Request don't unify.
    return env.ASSETS.fetch(req);
  },
};
