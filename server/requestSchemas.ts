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
// The OpenAPI 3.1 document derived from these schemas (via
// @asteasolutions/zod-to-openapi) lives in `server/openapi.ts`; see
// methodology.md → HTTP error responses.

import { z } from "zod";
import { StatusCodes } from "http-status-codes";
import { problem } from "../shared/problemDetails.ts";
import {
  ChangeHash,
  ChangeOrigin,
  PostPath,
  ThreadId,
  UserId,
} from "../shared/commentSchemas.ts";

// The field primitives now live in shared/commentSchemas.ts so the request
// (query) side and the response/body side share one definition. The query
// *objects* below — which are server-only — compose them. `PostParam` is kept
// as a local alias for `PostPath` so this module's vocabulary ("the post query
// param") reads naturally at the composition sites.
export { ChangeHash, ThreadId, UserId } from "../shared/commentSchemas.ts";
export const PostParam = PostPath;

// GET /comments?post[&user[&change]] — presence of user/change selects the
// shape (list users / list changes / get-or-put one change), so both are
// optional and the handler dispatches on `=== undefined`. `origin` is
// PUT-only provenance the writer may declare (today: the seeding CLI
// stamping blobs it copies into the dev store); it rides into the store's
// metadata and back out in LIST entries. Writer-declared and validated for
// shape only — it's debugging provenance, never an authorization input.
export const CommentsQuery = z.object({
  post: PostParam,
  user: UserId.optional(),
  change: ChangeHash.optional(),
  origin: ChangeOrigin.optional(),
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
