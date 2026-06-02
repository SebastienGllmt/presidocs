// OpenAPI 3.1 document derived from the zod request schemas (proposal 26
// Phase 2). The query schemas in `requestSchemas.ts` are the source of truth
// for the request side; this module adds response component schemas + path
// registrations and emits the document served at GET /openapi.json.
//
// Uses Zod 4's native `.meta({ id })` for component names, so it needs no
// `extendZodWithOpenApi(z)` global mutation (which would otherwise reach the
// branded schemas in shared/time.ts). Auth routes (/auth/*) are intentionally
// not documented yet — their query parsing wasn't schematized in Phase 1.

import { z } from "zod";
import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { CommentsQuery, ResolutionsQuery, PostVersionQuery } from "./requestSchemas.ts";

// `uploaded` / `builtAt` are Date / ISO values serialized to ISO-8601 strings
// by Response.json — modelled as strings on the wire.
const ChangeListEntry = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int(),
  uploaded: z.string(),
});
const ResolutionListEntry = z.object({
  threadId: z.string(),
  size: z.number().int(),
  uploaded: z.string(),
});

const CommentUsersResponse = z
  .array(z.string())
  .meta({ id: "CommentUsersResponse" });
const CommentChangesResponse = z
  .array(ChangeListEntry)
  .meta({ id: "CommentChangesResponse" });
const ResolutionsListResponse = z
  .array(ResolutionListEntry)
  .meta({ id: "ResolutionsListResponse" });
const PostVersionResponse = z
  .object({
    currentHash: z.string(),
    isAuthor: z.boolean(),
    history: z
      .array(z.object({ hash: z.string(), builtAt: z.string() }))
      .optional(),
  })
  .meta({ id: "PostVersionResponse" });

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
    200: {
      description:
        "Users list / change list (application/json), or one change's bytes (application/octet-stream).",
      content: {
        "application/json": {
          schema: z.union([CommentUsersResponse, CommentChangesResponse]),
        },
        "application/octet-stream": { schema: OctetStream },
      },
    },
    400: problem("Invalid query parameter."),
    401: problem("Not logged in."),
    403: problem("Not authorized for this user or post."),
    404: problem("Change not found."),
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
    200: { description: "Stored (or already present)." },
    400: problem("Invalid query parameter or empty body."),
    401: problem("Not logged in."),
    403: problem("Not the owning user."),
    413: problem("Change exceeds the size limit."),
    429: problem("Rate limit exceeded."),
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
    200: {
      description: "Resolution list, or one opaque resolution envelope.",
      content: { "application/json": { schema: ResolutionsListResponse } },
    },
    401: problem("Not logged in."),
    404: problem("Resolution not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/resolutions",
  summary: "Write one resolution envelope (post author only).",
  description: "Body is a small opaque JSON envelope (≤ 2 KB).",
  request: { query: ResolutionsQuery },
  responses: {
    200: { description: "Stored." },
    400: problem("Invalid query parameter or empty body."),
    401: problem("Not logged in."),
    403: problem("Not the post author."),
    413: problem("Resolution body exceeds the size limit."),
    429: problem("Rate limit exceeded."),
  },
});

registry.registerPath({
  method: "get",
  path: "/post-version",
  summary: "Current post version hash (and history for the author).",
  request: { query: PostVersionQuery },
  responses: {
    200: {
      description:
        "Current hash + isAuthor; history is included only for the post author.",
      content: { "application/json": { schema: PostVersionResponse } },
    },
    401: problem("Not logged in."),
    404: problem("Unknown post."),
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
