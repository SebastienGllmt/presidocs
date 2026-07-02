// Thin fetch wrappers over the `/comments` route. Keeps the rest of
// the client free of URL strings + status-code branching. Every
// function throws on transport / authz failure; missing changes
// (404) return null, missing users (empty LIST) return an empty
// array.
//
// Route shape (mirrors server/comments/routes.ts):
//   GET    /comments?post=X                      → string[]   (userIds)            — author only
//   GET    /comments?post=X&user=Y               → ChangeListEntry[] (hash + meta)  — self or author
//   GET    /comments?post=X&user=Y&change=Z      → Uint8Array (one change's bytes)  — self or author
//   PUT    /comments?post=X&user=Y&change=Z      → 200                               — self only
//
// The shared fetch scaffold (ApiError, Retry-After parsing, problem+json
// wrapping, the GET-and-validate helper) lives in client/apiFetch.ts and is
// shared with resolutionsApi.ts. ApiError + MAX_RETRY_AFTER_MS are re-exported
// here so existing importers (commentsSync.ts, tests) keep their path.

import {
  ACCEPT,
  apiError,
  apiGetJson,
  ApiError,
  apiUrl,
  MAX_RETRY_AFTER_MS,
} from "./apiFetch.ts";
import {
  ChangeList,
  type ChangeListEntry as ChangeListEntryType,
  CommentUsers,
} from "../shared/commentSchemas.ts";

export { ApiError, MAX_RETRY_AFTER_MS };

// Wire shape, defined once in shared/commentSchemas.ts and re-exported here so
// existing importers keep their path.
export type ChangeListEntry = ChangeListEntryType;

function commentsUrl(post: string, user?: string, change?: string): string {
  return apiUrl("/comments", { post, user, change });
}

// Author-only — server returns 403 for non-authors.
export function listUsers(post: string): Promise<string[]> {
  return apiGetJson(commentsUrl(post), "listUsers", CommentUsers);
}

export function listChanges(post: string, user: string): Promise<ChangeListEntry[]> {
  return apiGetJson(commentsUrl(post, user), "listChanges", ChangeList);
}

export async function getChange(
  post: string,
  user: string,
  changeHash: string,
): Promise<Uint8Array | null> {
  const res = await fetch(commentsUrl(post, user, changeHash), {
    credentials: "same-origin",
    headers: { Accept: `application/octet-stream, ${ACCEPT}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res, "getChange");
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function putChange(
  post: string,
  user: string,
  changeHash: string,
  bytes: Uint8Array,
): Promise<void> {
  const res = await fetch(commentsUrl(post, user, changeHash), {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      Accept: ACCEPT,
    },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw await apiError(res, "putChange");
}
