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
import { StatusCodes } from "http-status-codes";
import type { RateLimit } from "@cloudflare/workers-types";
import type { Session } from "../auth/session.ts";
import { isPostAuthor, type PostMetaIndex } from "../postMeta.ts";
import {
  problem,
  RATE_LIMIT_WINDOW_SECONDS,
  type ProblemSlug,
} from "../../shared/problemDetails.ts";
import { CommentsQuery, zodBadRequest } from "../requestSchemas.ts";
import type {
  ChangeListEntry,
  CommentChangeStore,
} from "./store.ts";

// Per-change upload byte cap. Automerge changes are typically a few
// hundred bytes after compression; 8 KB is generous for any single
// op (including unusually-long replies up to the client's 5000-char
// UX cap).
export const MAX_CHANGE_BYTES = 8 * 1024;

export type CommentsDeps = {
  store: CommentChangeStore;
  postMeta: PostMetaIndex;
  // Official Workers Rate Limiting binding (`env.RATE_LIMITER`), or null in dev
  // (no limiting locally) — the same `RateLimit` type `server/env.ts` declares,
  // instead of a local re-declaration of the identical shape.
  rateLimiter: RateLimit | null;
};

function unauthorized(): Response {
  return problem(StatusCodes.UNAUTHORIZED, "auth/unauthenticated");
}
function forbidden(): Response {
  return problem(StatusCodes.FORBIDDEN, "auth/forbidden");
}
function badRequest(
  slug: Extract<ProblemSlug, `request/${string}`>,
  detail: string,
  extensions?: Record<string, unknown>,
): Response {
  return problem(StatusCodes.BAD_REQUEST, slug, detail, extensions);
}
function methodNotAllowed(): Response {
  return problem(StatusCodes.METHOD_NOT_ALLOWED, "about:blank");
}
function notFound(): Response {
  return problem(StatusCodes.NOT_FOUND, "about:blank");
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
  const session = await getSessionFromRequest(req);
  if (!session) return unauthorized();

  const url = new URL(req.url);
  const parsed = CommentsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return zodBadRequest(parsed.error);
  const { post, user, change } = parsed.data;

  // No `user` → list users (author only).
  if (user === undefined) {
    if (req.method !== "GET") return methodNotAllowed();
    if (!isPostAuthor(session, deps.postMeta.get(post))) return forbidden();
    const users = await deps.store.listUsers(post);
    return Response.json(users, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  // `user` but no `change` → list change hashes for that user.
  if (change === undefined) {
    if (req.method !== "GET") return methodNotAllowed();
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
      return methodNotAllowed();
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
  if (!bytes) return notFound();
  return new Response(bytes as BodyInit, {
    status: StatusCodes.OK,
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
    return new Response(null, { status: StatusCodes.OK });
  }

  // Rate limiting targets external commenters only. The post author is the
  // trusted owner of the blog (and the sole writer of resolutions); throttling
  // their own writes protects nothing and breaks legitimate bulk work (e.g.
  // resolving a backlog of threads). The threat the limiter exists for — a
  // logged-in *commenter* spamming PUTs to force-fire author pushes (see
  // methodology → Hardening / Push) — is unchanged, since non-authors are still
  // limited. The author writes only to their own folder (enforced above), so
  // exempting them here can't be abused to write on someone else's behalf.
  if (deps.rateLimiter && !isPostAuthor(session, deps.postMeta.get(post))) {
    const { success } = await deps.rateLimiter.limit({ key: session.userId });
    if (!success) {
      return problem(StatusCodes.TOO_MANY_REQUESTS, "rate-limit/exceeded", undefined, {
        retryAfter: RATE_LIMIT_WINDOW_SECONDS,
      });
    }
  }

  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_CHANGE_BYTES) {
    return problem(StatusCodes.REQUEST_TOO_LONG, "comments/change-too-large", undefined, {
      maxBytes: MAX_CHANGE_BYTES,
      actualBytes: body.byteLength,
    });
  }
  if (body.byteLength === 0) {
    return badRequest("request/empty-body", "request body is required");
  }

  await deps.store.putChange(post, user, changeHash, new Uint8Array(body));
  return new Response(null, { status: StatusCodes.OK });
}
