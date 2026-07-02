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
import { StatusCodes } from "http-status-codes";
import { isPostAuthor, type PostMetaIndex } from "../postMeta.ts";
import { problem } from "../../shared/problemDetails.ts";
import { ResolutionsQuery, zodBadRequest } from "../requestSchemas.ts";
import type { CommentChangeStore } from "./store.ts";

// Per-resolution upload byte cap. Resolution envelopes contain a
// threadId, a timestamp, a resolverId, and a display name —
// comfortably under 1 KB. Cap is generous but tight enough to refuse
// arbitrary blobs.
export const MAX_RESOLUTION_BYTES = 2 * 1024;

export type ResolutionsDeps = {
  store: CommentChangeStore;
  postMeta: PostMetaIndex;
};

export async function handleResolutionsRequest(
  req: Request,
  deps: ResolutionsDeps,
): Promise<Response> {
  const session = await getSessionFromRequest(req);
  if (!session) return problem(StatusCodes.UNAUTHORIZED, "auth/unauthenticated");

  const url = new URL(req.url);
  const parsed = ResolutionsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return zodBadRequest(parsed.error);
  const { post, thread } = parsed.data;

  // LIST: any logged-in user.
  if (thread === undefined) {
    if (req.method !== "GET") return problem(StatusCodes.METHOD_NOT_ALLOWED, "about:blank");
    const entries = await deps.store.listResolutions(post);
    return Response.json(entries, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  switch (req.method) {
    case "GET": {
      const bytes = await deps.store.getResolution(post, thread);
      if (!bytes) return problem(StatusCodes.NOT_FOUND, "about:blank");
      return new Response(bytes as BodyInit, {
        status: StatusCodes.OK,
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
      // PUT is post-author-only (the hard gate below). The author is the
      // trusted blog owner, so resolution writes are deliberately NOT
      // rate-limited — the limiter exists to throttle external commenters on
      // /comments, and the only identity that could ever reach here is the
      // author themselves. See server/comments/routes.ts and methodology →
      // Hardening.
      if (!isPostAuthor(session, deps.postMeta.get(post))) {
        return problem(StatusCodes.FORBIDDEN, "auth/forbidden");
      }
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_RESOLUTION_BYTES) {
        return problem(StatusCodes.REQUEST_TOO_LONG, "resolutions/resolution-too-large", undefined, {
          maxBytes: MAX_RESOLUTION_BYTES,
          actualBytes: body.byteLength,
        });
      }
      if (body.byteLength === 0) {
        return problem(StatusCodes.BAD_REQUEST, "request/empty-body", "request body is required");
      }
      await deps.store.putResolution(post, thread, new Uint8Array(body));
      return new Response(null, { status: StatusCodes.OK });
    }
    default:
      return problem(StatusCodes.METHOD_NOT_ALLOWED, "about:blank");
  }
}
