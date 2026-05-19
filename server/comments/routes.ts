// HTTP routes for the comment per-change R2 proxy. One endpoint,
// four shapes, dispatched by query-param presence + method:
//
//   GET    /comments?post=X                       — list users (author only)
//   GET    /comments?post=X&user=Y                — list change hashes
//   GET    /comments?post=X&user=Y&change=Z       — fetch one change
//   PUT    /comments?post=X&user=Y&change=Z       — upload one change
//
// Visibility (mirrors methodology.md → Hardening):
//   LIST users          → session present AND session is the post's author
//   LIST changes(Y)     → session present AND (session.userId === Y OR session is author)
//   GET change(Y, *)    → same as LIST changes(Y)
//   PUT change(Y, *)    → session present AND session.userId === Y (and not blocked)
//
// "Session is the post's author" means the session's verified email
// matches the post's `<meta name="author-email">` tag (per-post, see
// server/postMeta.ts).

import { getSessionFromRequest } from "../auth/routes.ts";
import type { Session } from "../auth/session.ts";
import { isPostAuthor, type PostMetaIndex } from "../postMeta.ts";
import type {
  ChangeListEntry,
  CommentChangeStore,
} from "./store.ts";

// Per-change upload byte cap. Automerge changes are typically a few
// hundred bytes after compression; 8 KB is generous for any single
// op (including unusually-long replies up to the client's 5000-char
// UX cap).
export const MAX_CHANGE_BYTES = 8 * 1024;

// Minimal rate-limit binding shape — Workers Rate Limiting API
// matches it; dev passes null (no limiting locally).
export type RateLimiter = {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
};

export type CommentsDeps = {
  store: CommentChangeStore;
  postMeta: PostMetaIndex;
  rateLimiter: RateLimiter | null;
};

function unauthorized(message = "unauthorized"): Response {
  return new Response(message, { status: 401 });
}
function forbidden(message = "forbidden"): Response {
  return new Response(message, { status: 403 });
}
function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

// Author moderation list: comma-separated `<provider>:<sub>` userIds
// whose PUTs are silently dropped. See methodology.md → Hardening.
function isBlockedUser(userId: string): boolean {
  const raw = process.env.BLOCKED_USERS;
  if (!raw) return false;
  for (const entry of raw.split(",")) {
    if (entry.trim() === userId) return true;
  }
  return false;
}

// Main entry — dispatches by method + query params.
export async function handleCommentsRequest(
  req: Request,
  deps: CommentsDeps,
): Promise<Response> {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorized();

  const url = new URL(req.url);
  const post = url.searchParams.get("post");
  const user = url.searchParams.get("user");
  const change = url.searchParams.get("change");
  if (!post) return badRequest("missing 'post' query parameter");

  // No `user` → list users (author only).
  if (user === null) {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!isPostAuthor(session, deps.postMeta.get(post))) return forbidden();
    const users = await deps.store.listUsers(post);
    return Response.json(users, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // `user` but no `change` → list change hashes for that user.
  if (change === null) {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    if (
      session.userId !== user &&
      !isPostAuthor(session, deps.postMeta.get(post))
    ) {
      return forbidden();
    }
    const entries: ChangeListEntry[] = await deps.store.listChanges(post, user);
    return Response.json(entries, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // `user` and `change` → fetch or upload one specific change.
  switch (req.method) {
    case "GET":
      return await handleGetChange(post, user, change, session, deps);
    case "PUT":
      return await handlePutChange(req, post, user, change, session, deps);
    default:
      return new Response("method not allowed", { status: 405 });
  }
}

async function handleGetChange(
  post: string,
  user: string,
  changeHash: string,
  session: Session,
  deps: CommentsDeps,
): Promise<Response> {
  if (
    session.userId !== user &&
    !isPostAuthor(session, deps.postMeta.get(post))
  ) {
    return forbidden();
  }
  const bytes = await deps.store.getChange(post, user, changeHash);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      // Changes are content-addressed and immutable — safe to cache
      // aggressively. The client also caches in localStorage, so this
      // is mostly belt-and-suspenders.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

async function handlePutChange(
  req: Request,
  post: string,
  user: string,
  changeHash: string,
  session: Session,
  deps: CommentsDeps,
): Promise<Response> {
  // PUT is allowed only by the user themselves — content isolation
  // between blobs. The author has no special PUT power; they only
  // ever upload to their own folder.
  if (session.userId !== user) return forbidden();

  // Block-list check: silently accept-but-discard. Attacker gets a
  // success response, no R2 op, no rate-limit budget burned.
  if (isBlockedUser(session.userId)) {
    await req.arrayBuffer();
    return new Response(null, { status: 200 });
  }

  if (deps.rateLimiter) {
    const { success } = await deps.rateLimiter.limit({ key: session.userId });
    if (!success) return new Response("rate limited", { status: 429 });
  }

  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_CHANGE_BYTES) {
    return new Response("change too large", { status: 413 });
  }
  if (body.byteLength === 0) {
    return badRequest("empty body");
  }

  await deps.store.putChange(post, user, changeHash, new Uint8Array(body));
  return new Response(null, { status: 200 });
}
