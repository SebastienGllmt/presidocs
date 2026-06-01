// HTTP routes for the per-post resolution blobs.
//
// One mutable key per resolved thread:
//   GET    /resolutions?post=X                 — list resolved threadIds
//   GET    /resolutions?post=X&thread=T        — fetch one resolution body
//   PUT    /resolutions?post=X&thread=T        — write/overwrite one (author only)
//
// Visibility model (different from /comments):
//   - LIST + GET: any logged-in user. The threadIds are opaque random
//     strings; without the matching CRDT thread (which lives only in
//     its commenter's private blob) they're meaningless to other
//     readers. Originating commenters DO recognise their own threads,
//     and the snapshot layer filters those out as resolved.
//   - PUT: post author only (verified via the same email-based check
//     used by the author-aggregator endpoint).
//
// The body is opaque to the server — a small JSON envelope authored
// by the client. We cap size, rate-limit, and validate the
// presence-of-fields client-side.

import { getSessionFromRequest } from "../auth/routes.ts";
import { isPostAuthor, type PostMetaIndex } from "../postMeta.ts";
import {
  problem,
  RATE_LIMIT_WINDOW_SECONDS,
  type ProblemSlug,
} from "../../shared/problemDetails.ts";
import type { CommentChangeStore } from "./store.ts";
import type { RateLimiter } from "./routes.ts";

// Per-resolution upload byte cap. Resolution envelopes contain a
// threadId, a timestamp, a resolverId, and a display name —
// comfortably under 1 KB. Cap is generous but tight enough to refuse
// arbitrary blobs.
export const MAX_RESOLUTION_BYTES = 2 * 1024;

export type ResolutionsDeps = {
  store: CommentChangeStore;
  postMeta: PostMetaIndex;
  rateLimiter: RateLimiter | null;
};

function unauthorized(): Response {
  return problem(401, "auth/unauthenticated");
}
function forbidden(): Response {
  return problem(403, "auth/forbidden");
}
function badRequest(
  slug: Extract<ProblemSlug, `request/${string}`>,
  detail: string,
  extensions?: Record<string, unknown>,
): Response {
  return problem(400, slug, detail, extensions);
}
function methodNotAllowed(): Response {
  return problem(405, "about:blank");
}
function notFound(): Response {
  return problem(404, "about:blank");
}

export async function handleResolutionsRequest(
  req: Request,
  deps: ResolutionsDeps,
): Promise<Response> {
  const session = await getSessionFromRequest(req);
  if (!session) return unauthorized();

  const url = new URL(req.url);
  const post = url.searchParams.get("post");
  const thread = url.searchParams.get("thread");
  if (!post) {
    return badRequest("request/missing-parameter", "missing 'post' query parameter", {
      param: "post",
    });
  }

  // LIST: any logged-in user.
  if (thread === null) {
    if (req.method !== "GET") return methodNotAllowed();
    const entries = await deps.store.listResolutions(post);
    return Response.json(entries, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  switch (req.method) {
    case "GET": {
      const bytes = await deps.store.getResolution(post, thread);
      if (!bytes) return notFound();
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Resolutions are mutable — no immutable cache. Short
          // private cache is enough that a quick re-poll doesn't
          // round-trip again.
          "Cache-Control": "private, max-age=10",
        },
      });
    }
    case "PUT": {
      if (!isPostAuthor(session, deps.postMeta.get(post))) {
        return forbidden();
      }
      if (deps.rateLimiter) {
        const { success } = await deps.rateLimiter.limit({
          key: session.userId,
        });
        if (!success) {
          return problem(429, "rate-limit/exceeded", undefined, {
            retryAfter: RATE_LIMIT_WINDOW_SECONDS,
          });
        }
      }
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_RESOLUTION_BYTES) {
        return problem(413, "resolutions/resolution-too-large", undefined, {
          maxBytes: MAX_RESOLUTION_BYTES,
          actualBytes: body.byteLength,
        });
      }
      if (body.byteLength === 0) {
        return badRequest("request/empty-body", "request body is required");
      }
      await deps.store.putResolution(post, thread, new Uint8Array(body));
      return new Response(null, { status: 200 });
    }
    default:
      return methodNotAllowed();
  }
}
