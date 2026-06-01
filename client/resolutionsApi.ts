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

export type ResolutionListEntry = {
  threadId: string;
  size: number;
  uploaded: string; // ISO 8601
};

// The bytes-side shape we put / get. The server treats it as opaque,
// so this type is purely a client-side contract.
export type ResolutionEnvelope = {
  threadId: string;
  resolvedAt: number;
  resolverId: string;   // <provider>:<sub>
  resolverName: string; // for display ("Resolved by …")
};

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
  return (await res.json()) as ResolutionListEntry[];
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
  return (await res.json()) as ResolutionEnvelope;
}

export async function putResolution(
  post: string,
  threadId: string,
  envelope: ResolutionEnvelope,
): Promise<void> {
  const res = await fetch(resolutionsUrl(post, threadId), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: ACCEPT },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) throw await apiError(res, "putResolution");
}
