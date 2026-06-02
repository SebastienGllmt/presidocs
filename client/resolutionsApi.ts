// Thin fetch wrappers over the `/resolutions` route.
//
//   GET /resolutions?post=X                — list entries     (any user)
//   GET /resolutions?post=X&thread=T       — fetch one body   (any user)
//   PUT /resolutions?post=X&thread=T       — write one body   (author only)
//
// Errors are RFC 9457 problem+json; see commentsApi.ts for the
// ApiError contract.

import { ApiError } from "./commentsApi.ts";
import { parseProblem } from "../shared/problemDetails.ts";
import {
  ResolutionEnvelope as ResolutionEnvelopeSchema,
  ResolutionList,
  type ResolutionEnvelope as ResolutionEnvelopeType,
  type ResolutionListEntry as ResolutionListEntryType,
} from "../shared/commentSchemas.ts";

// Wire shapes, defined once in shared/commentSchemas.ts and re-exported here so
// existing importers keep their path. The envelope is the sharpest case for a
// single schema: it's *written* by this client (putResolution) AND the CLI
// (authoring/resolveThreads.ts), and *read* back here (getResolution) — one
// schema makes those writers provably agree.
export type ResolutionListEntry = ResolutionListEntryType;
export type ResolutionEnvelope = ResolutionEnvelopeType;

const ACCEPT = "application/json, application/problem+json";

function resolutionsUrl(post: string, thread?: string): string {
  const params = new URLSearchParams({ post });
  if (thread !== undefined) params.set("thread", thread);
  return `/resolutions?${params.toString()}`;
}

async function apiError(res: Response, op: string): Promise<ApiError> {
  return new ApiError(res.status, await parseProblem(res), op);
}

export async function listResolutions(
  post: string,
): Promise<ResolutionListEntry[]> {
  const res = await fetch(resolutionsUrl(post), {
    credentials: "same-origin",
    headers: { Accept: ACCEPT },
  });
  if (!res.ok) throw await apiError(res, "listResolutions");
  const parsed = ResolutionList.safeParse(await res.json());
  // A malformed listing is surfaced as an ApiError (status 200 — the request
  // worked, the body didn't), falling into ResolutionStore.hydrate's existing
  // catch-and-skip rather than seeding the cache with garbage.
  if (!parsed.success) throw new ApiError(200, null, "listResolutions (malformed response body)");
  return parsed.data;
}

export async function getResolution(
  post: string,
  threadId: string,
): Promise<ResolutionEnvelope | null> {
  const res = await fetch(resolutionsUrl(post, threadId), {
    credentials: "same-origin",
    headers: { Accept: ACCEPT },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res, "getResolution");
  // Treat a malformed envelope exactly like a missing one (404 → null): the
  // caller already drops a null, so a corrupt body can't land a bad
  // "Resolved by …" tag in the UI.
  const parsed = ResolutionEnvelopeSchema.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

export async function putResolution(
  post: string,
  threadId: string,
  envelope: ResolutionEnvelope,
): Promise<void> {
  // Validate the envelope shape before it goes on the wire — a malformed
  // write fails loudly here (the caller logs it) rather than persisting a bad
  // blob the reader side would later have to defend against.
  const body = ResolutionEnvelopeSchema.parse(envelope);
  const res = await fetch(resolutionsUrl(post, threadId), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: ACCEPT },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, "putResolution");
}
