// The production Worker's API route table, split out of createWorker.ts (the
// entry factory calls handleApi first, then falls through to the asset/codegen
// serving in server/workerAssets.ts). Mirrors the dev server's route table (see
// createDevServer.ts) so dev and prod resolve the same URLs the same way. The
// build-time indexes the handlers close over are threaded in as parameters so
// this table stays free of the factory closure.
//
// methodology.md → the two entry-point factories (server/createWorker.ts).

import type { Env } from "./env.ts";
import {
  startGoogleAuth,
  startMicrosoftAuth,
  googleCallback,
  microsoftCallback,
  whoami,
  logout,
} from "./auth/routes.ts";
import { handleCommentsRequest } from "./comments/routes.ts";
import { handleResolutionsRequest } from "./comments/resolutionsRoutes.ts";
import { r2Adapter } from "./comments/r2Adapter.ts";
import type { PostMetaIndex } from "./postMeta.ts";
import type { PostVersionIndex } from "./postVersions.ts";
import { handlePostVersionRequest } from "./postVersionsRoute.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { handleAnalyticsRequest } from "./analyticsRoute.ts";

// Match an API route and run its handler. Returns null when the request is
// not an API route, so the caller falls through to static assets. These are
// the "private" (non-asset) responses that also get CORP.
export function handleApi(
  req: Request,
  env: Env,
  postMetaIndex: PostMetaIndex,
  postVersionsIndex: PostVersionIndex,
): Promise<Response> | Response | null {
  const path = new URL(req.url).pathname;

  // --- Auth routes (handlers are runtime-agnostic). ---
  if (path === "/auth/google") return startGoogleAuth(req);
  if (path === "/auth/google/callback") return googleCallback(req);
  if (path === "/auth/microsoft") return startMicrosoftAuth(req);
  if (path === "/auth/microsoft/callback") return microsoftCallback(req);
  if (path === "/auth/me") return whoami(req);
  if (path === "/auth/logout" && req.method === "POST") return logout(req);

  // --- OpenAPI 3.1 document for the gated API (public — schema, not data). ---
  if (path === "/openapi.json") return Response.json(buildOpenApiDocument());

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
    });
  }
  if (path === "/post-version") {
    return handlePostVersionRequest(req, {
      postVersions: postVersionsIndex,
      postMeta: postMetaIndex,
    });
  }

  // Engagement-analytics sink. POST-only; the handler 204s any other method.
  // Anonymous, no session check, no R2 access — see server/analyticsRoute.ts.
  if (path === "/_a") {
    return handleAnalyticsRequest(req, {
      sink: env.ANALYTICS ?? null,
      postMeta: postMetaIndex,
      rateLimiter: env.ANALYTICS_RATE_LIMITER ?? null,
    });
  }

  return null;
}
