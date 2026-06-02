// OpenAPI 3.1 document derived from the zod schemas. The query schemas in
// `requestSchemas.ts` are the source of truth for the request side and the
// wire shapes in `shared/commentSchemas.ts` for the response/body side; this
// module tags them with component ids, adds path registrations, and emits the
// document served at GET /openapi.json. See methodology.md → HTTP error
// responses for how the schemas underpin both validation and this document.
//
// Uses Zod 4's native `.meta({ id })` for component names, so it needs no
// `extendZodWithOpenApi(z)` global mutation (which would otherwise reach the
// branded schemas in shared/time.ts). Auth routes (/auth/*) are intentionally
// not documented yet — their query parsing isn't schematized.

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
  request: { query: CommentsQuery },
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
    "Body is the raw change bytes (application/octet-stream, ≤ 8 KB). Idempotent — a re-PUT of identical bytes succeeds.",
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
    [StatusCodes.TOO_MANY_REQUESTS]: problem("Rate limit exceeded."),
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

const generate = () =>
  new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "presidocs comments & resolutions API",
      version: "1.0.0",
      description:
        "Gated HTTP API for the comment / resolution / post-version layer. Auth endpoints (/auth/*) are not yet schema-documented.",
    },
  });

let cached: ReturnType<typeof generate> | null = null;

// The document is static (built from module-scope registrations), so generate
// it once and reuse.
export function buildOpenApiDocument(): ReturnType<typeof generate> {
  return (cached ??= generate());
}
