// Route handler for /post-version. Returns the current hash to any
// logged-in user (the commenter banner needs it to compare against
// localStorage); the full history is included only when the session
// is the post's author.
//
// Visibility model:
//   - currentHash: all logged-in users
//   - history: post author only
// Anonymous requests are rejected. The version concept is post-
// scoped, and we already require login to comment, so gating on
// session keeps a parallel "version-tracking pixel" from being
// scraped by drive-bys.

import { getSessionFromRequest } from "./auth/routes.ts";
import { isPostAuthor, type PostMetaIndex } from "./postMeta.ts";
import type { PostVersionIndex } from "./postVersions.ts";

export type PostVersionDeps = {
  postVersions: PostVersionIndex;
  postMeta: PostMetaIndex;
};

export async function handlePostVersionRequest(
  req: Request,
  deps: PostVersionDeps,
): Promise<Response> {
  const session = getSessionFromRequest(req);
  if (!session) return new Response("unauthorized", { status: 401 });

  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const post = url.searchParams.get("post");
  if (!post) return new Response("missing 'post'", { status: 400 });

  const record = deps.postVersions.get(post);
  if (!record) return new Response("not found", { status: 404 });

  // Server-computed `isAuthor` for the current session. Authoritative
  // — the client can't be trusted to know this (the source-only
  // <meta name="author-email"> tag is stripped from served HTML in
  // prod, so DOM-based detection fails in deployed builds). Every
  // author-only client surface (aggregator, resolve-foreign-thread,
  // version history) reads this flag instead.
  const isAuthor = isPostAuthor(session, deps.postMeta.get(post));

  const body: {
    currentHash: string;
    isAuthor: boolean;
    history?: typeof record.history;
  } = {
    currentHash: record.currentHash,
    isAuthor,
  };
  if (isAuthor) body.history = record.history;

  return Response.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
