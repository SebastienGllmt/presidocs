// Thin fetch wrappers over the `/resolutions` route.
//
//   GET /resolutions?post=X                — list entries     (any user)
//   GET /resolutions?post=X&thread=T       — fetch one body   (any user)
//   PUT /resolutions?post=X&thread=T       — write one body   (author only)
//
// Built on the shared fetch scaffold in client/apiFetch.ts (ApiError,
// problem+json wrapping, the GET-and-validate helper) — the same one
// commentsApi.ts uses.

import { ACCEPT, apiError, apiGetJson, apiUrl } from "./apiFetch.ts";
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

function resolutionsUrl(post: string, thread?: string): string {
  return apiUrl("/resolutions", { post, thread });
}

export function listResolutions(post: string): Promise<ResolutionListEntry[]> {
  // A malformed listing surfaces as a status-200 ApiError (see apiGetJson /
  // invalidShape), falling into ResolutionStore.hydrate's existing
  // catch-and-skip rather than seeding the cache with garbage.
  return apiGetJson(resolutionsUrl(post), "listResolutions", ResolutionList);
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
