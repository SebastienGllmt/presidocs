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
import { handleResolutionsRequest } from "./server/comments/resolutionsRoutes.ts";
import { r2Adapter } from "./server/comments/r2Adapter.ts";
import { createPostMetaIndex } from "./server/postMeta.ts";
import { POST_AUTHORS } from "./server/postMeta.generated.ts";
import { createPostVersionIndex } from "./server/postVersions.ts";
import { POST_VERSIONS } from "./server/postVersions.generated.ts";
import { handlePostVersionRequest } from "./server/postVersionsRoute.ts";
import { withSecurityHeaders } from "./shared/securityHeaders.ts";

// Built once at module load — the map is static for the lifetime of
// the Worker (regenerated only when a new build is deployed).
const postMetaIndex = createPostMetaIndex(POST_AUTHORS);
const postVersionsIndex = createPostVersionIndex(POST_VERSIONS);

// Match an API route and run its handler. Returns null when the request
// is not an API route, so the caller falls through to static assets.
// These are the "private" (non-asset) responses that also get CORP.
function handleApi(req: Request, env: Env): Promise<Response> | Response | null {
  const path = new URL(req.url).pathname;

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
  if (path === "/resolutions") {
    return handleResolutionsRequest(req, {
      store: r2Adapter(env.COMMENTS),
      postMeta: postMetaIndex,
      rateLimiter: env.RATE_LIMITER,
    });
  }
  if (path === "/post-version") {
    return handlePostVersionRequest(req, {
      postVersions: postVersionsIndex,
      postMeta: postMetaIndex,
    });
  }

  return null;
}

export default {
  async fetch(
    req: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const apiResponse = handleApi(req, env);
    if (apiResponse !== null) {
      return withSecurityHeaders(await apiResponse, { private: true });
    }

    // --- Static assets fall-through. The Workers Static Assets binding
    //     handles caching headers and 404s for us. Still wrapped so the
    //     article HTML carries the document CSP. ---
    // @ts-expect-error - ASSETS.fetch takes the same Request shape but
    //     types between the runtime Request and DOM Request don't unify.
    const assetResponse: Response = await env.ASSETS.fetch(req);
    return withSecurityHeaders(assetResponse);
  },
};
