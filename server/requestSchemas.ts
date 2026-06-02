// zod schemas for HTTP request validation — the source of truth for the
// query contract of the comment/resolution/post-version endpoints, replacing
// the per-handler ad-hoc `searchParams.get(...)` + presence checks. A single
// declarative parse per handler routes failures through the existing RFC 9457
// problem() builder via `zodBadRequest`.
//
// Scope is deliberately SHAPE only. Security-bearing checks stay in the
// handlers: the per-method authorization (own-user / post-author), the byte
// caps on PUT bodies, the block-list, and the rate limiter are semantic
// guards, not shape guards, and a schema must not stand in for them.
//
// (Phase 2 — deriving an OpenAPI 3.1 document from these via
// @asteasolutions/zod-to-openapi — is deferred; see proposals/26.)

import { z } from "zod";
import { StatusCodes } from "http-status-codes";
import { problem } from "../shared/problemDetails.ts";

// `post` is an opaque post path/key (e.g. "/posts/foo"); non-empty is the
// only shape rule — the store treats it as an opaque key.
export const PostParam = z.string().min(1);

// Reader identity is "<provider>:<sub>"; providers are exactly google or
// microsoft (see methodology → Reader identity). Validating the prefix also
// keeps a malformed value from ever reaching a content-addressed store key.
export const UserId = z.string().regex(/^(google|microsoft):.+$/);

// Automerge change hash: lowercase hex sha-256, 64 chars. This is used as an
// R2 object key, so pinning the shape is a small hardening win too.
export const ChangeHash = z.string().regex(/^[0-9a-f]{64}$/);

// Thread id is an opaque random string; non-empty is the only shape rule.
export const ThreadId = z.string().min(1);

// GET /comments?post[&user[&change]] — presence of user/change selects the
// shape (list users / list changes / get-or-put one change), so both are
// optional and the handler dispatches on `=== undefined`.
export const CommentsQuery = z.object({
  post: PostParam,
  user: UserId.optional(),
  change: ChangeHash.optional(),
});

// GET/PUT /resolutions?post[&thread]
export const ResolutionsQuery = z.object({
  post: PostParam,
  thread: ThreadId.optional(),
});

// GET /post-version?post
export const PostVersionQuery = z.object({
  post: PostParam,
});

// Render a zod parse failure as the project's uniform RFC 9457
// application/problem+json body. The first issue drives `detail` and the
// `param` extension; the full issue list rides along as a machine-readable
// extension (consumers ignore extensions they don't recognise, §3.2).
export function zodBadRequest(err: z.ZodError): Response {
  const first = err.issues[0];
  const param =
    first && first.path.length > 0 ? first.path.join(".") : undefined;
  return problem(StatusCodes.BAD_REQUEST, "request/invalid-parameter", first?.message, {
    ...(param !== undefined && { param }),
    issues: err.issues.map((i) => ({ path: i.path, code: i.code })),
  });
}
