// OpenAPI 3.1 document derived from the zod schemas. The query schemas in
// `requestSchemas.ts` are the source of truth for the request side and the
// wire shapes in `shared/commentSchemas.ts` for the response/body side; this
// module tags them with component ids, adds path registrations, and emits the
// document served at GET /openapi.json. See methodology.md → HTTP error
// responses for how the schemas underpin both validation and this document.
//
// Uses Zod 4's native `.meta({ id })` for component names, so it needs no
// `extendZodWithOpenApi(z)` global mutation (which would otherwise reach the
// branded schemas in shared/time.ts). The *redirect* auth routes
// (`/auth/<provider>`, `/callback`) stay undocumented — their query parsing is
// semantic (`safeReturnTo` / RFC 6749 guards), not shape. `GET /auth/me`, whose
// response is a stable JSON shape, IS documented (below).

import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { CommentsQuery, ResolutionsQuery, PostVersionQuery } from "./requestSchemas.ts";
import {
  ChangeListEntry,
  CommentUsers,
  PostVersionResponse as PostVersionResponseShape,
  ResolutionEnvelope,
  ResolutionListEntry,
} from "../shared/commentSchemas.ts";
import { IdentityResponse } from "../shared/authSchemas.ts";

// Response component schemas come from the one shared module
// (shared/commentSchemas.ts), so the OpenAPI document and the runtime client
// validators can no longer disagree about a wire shape. `.meta({ id })` (Zod 4 native) names each
// component; we don't mutate the shared schemas in place, we tag local
// `.meta()`-wrapped views of them.
const CommentUsersResponse = CommentUsers.meta({ id: "CommentUsersResponse" });
const CommentChangesResponse = z
  .array(ChangeListEntry)
  .meta({ id: "CommentChangesResponse" });
const ResolutionsListResponse = z
  .array(ResolutionListEntry)
  .meta({ id: "ResolutionsListResponse" });
const ResolutionEnvelopeBody = ResolutionEnvelope.meta({
  id: "ResolutionEnvelope",
});
const PostVersionResponse = PostVersionResponseShape.meta({
  id: "PostVersionResponse",
});
// The public identity projection `GET /auth/me` returns (shared/authSchemas.ts,
// derived from the session claim shape). The logged-out arm is the JSON
// literal `null`, so the response is a union of this and `z.null()`.
const IdentityResponseComponent = IdentityResponse.meta({
  id: "IdentityResponse",
});

// RFC 9457 problem body (shared/problemDetails.ts). Core members documented;
// extensions (param, retryAfter, maxBytes, …) may also appear per §3.2.
const ProblemDetails = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
  })
  .meta({ id: "ProblemDetails" });

// Raw bytes for the octet-stream surfaces (Automerge change blobs).
const OctetStream = z.string().meta({ id: "OctetStream" });

const registry = new OpenAPIRegistry();

function problem(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: ProblemDetails } },
  };
}

registry.registerPath({
  method: "get",
  path: "/comments",
  summary: "List users, list a user's change hashes, or fetch one change.",
  description:
    "Shape is selected by query params: `post` only → array of userIds (post author only); `post`+`user` → that user's change list; `post`+`user`+`change` → the raw change bytes (application/octet-stream).",
  // `origin` is omitted from the GET doc: the runtime schema is shared with
  // PUT (one uniform handler), but the param only means anything on a write.
  request: { query: CommentsQuery.omit({ origin: true }) },
  responses: {
    [StatusCodes.OK]: {
      description:
        "Users list / change list (application/json), or one change's bytes (application/octet-stream).",
      content: {
        "application/json": {
          schema: z.union([CommentUsersResponse, CommentChangesResponse]),
        },
        "application/octet-stream": { schema: OctetStream },
      },
    },
    [StatusCodes.BAD_REQUEST]: problem("Invalid query parameter."),
    [StatusCodes.UNAUTHORIZED]: problem("Not logged in."),
    [StatusCodes.FORBIDDEN]: problem("Not authorized for this user or post."),
    [StatusCodes.NOT_FOUND]: problem("Change not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/comments",
  summary: "Upload one Automerge change (own user only).",
  description:
    "Body is the raw change bytes (application/octet-stream, ≤ 8 KB). Idempotent — a re-PUT of identical bytes succeeds. The optional `origin` declares birth-store provenance (used by the local seeding CLI; rides into store metadata and back out in LIST entries).",
  request: { query: CommentsQuery },
  responses: {
    [StatusCodes.OK]: { description: "Stored (or already present)." },
    [StatusCodes.BAD_REQUEST]: problem("Invalid query parameter or empty body."),
    [StatusCodes.UNAUTHORIZED]: problem("Not logged in."),
    [StatusCodes.FORBIDDEN]: problem("Not the owning user."),
    [StatusCodes.REQUEST_TOO_LONG]: problem("Change exceeds the size limit."),
    [StatusCodes.TOO_MANY_REQUESTS]: problem("Rate limit exceeded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/resolutions",
  summary: "List resolved threadIds, or fetch one resolution envelope.",
  description:
    "`post` only → list of resolved threadIds; `post`+`thread` → that resolution's opaque JSON envelope.",
  request: { query: ResolutionsQuery },
  responses: {
    [StatusCodes.OK]: {
      description: "Resolution list, or one opaque resolution envelope.",
      content: { "application/json": { schema: ResolutionsListResponse } },
    },
    [StatusCodes.UNAUTHORIZED]: problem("Not logged in."),
    [StatusCodes.NOT_FOUND]: problem("Resolution not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/resolutions",
  summary: "Write one resolution envelope (post author only).",
  description:
    "Body is a small JSON resolution envelope (≤ 2 KB). The edge server stores it as opaque bytes; the shape is the client/CLI contract.",
  request: {
    query: ResolutionsQuery,
    body: {
      content: {
        "application/json": { schema: ResolutionEnvelopeBody },
      },
    },
  },
  responses: {
    [StatusCodes.OK]: { description: "Stored." },
    [StatusCodes.BAD_REQUEST]: problem("Invalid query parameter or empty body."),
    [StatusCodes.UNAUTHORIZED]: problem("Not logged in."),
    [StatusCodes.FORBIDDEN]: problem("Not the post author."),
    [StatusCodes.REQUEST_TOO_LONG]: problem("Resolution body exceeds the size limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/post-version",
  summary: "Current post version hash (and history for the author).",
  request: { query: PostVersionQuery },
  responses: {
    [StatusCodes.OK]: {
      description:
        "Current hash + isAuthor; history is included only for the post author.",
      content: { "application/json": { schema: PostVersionResponse } },
    },
    [StatusCodes.UNAUTHORIZED]: problem("Not logged in."),
    [StatusCodes.NOT_FOUND]: problem("Unknown post."),
  },
});

registry.registerPath({
  method: "get",
  path: "/auth/me",
  summary: "The logged-in reader's public identity, or null.",
  description:
    "Returns the public projection of the session (userId, email, emailVerified, name, picture, provider), or the JSON literal `null` when not logged in. `private, no-store` (echoes the user's identity). Authorization is computed elsewhere — this is a UI hint, re-checked server-side on every protected request.",
  responses: {
    [StatusCodes.OK]: {
      description:
        "The identity object, or `null` if the request carries no valid session cookie.",
      content: {
        "application/json": {
          schema: z.union([IdentityResponseComponent, z.null()]),
        },
      },
    },
  },
});

const generate = () =>
  new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "presidocs comments & resolutions API",
      version: "1.0.0",
      description:
        "Gated HTTP API for the comment / resolution / post-version layer, plus `GET /auth/me`. The redirect auth endpoints (`/auth/<provider>`, `/callback`) are not schema-documented — their guards are semantic (`safeReturnTo` / RFC 6749), not shape.",
    },
  });

let cached: ReturnType<typeof generate> | null = null;

// The document is static (built from module-scope registrations), so generate
// it once and reuse.
export function buildOpenApiDocument(): ReturnType<typeof generate> {
  return (cached ??= generate());
}
