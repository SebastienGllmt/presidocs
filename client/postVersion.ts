// Client helpers for the per-post document-version concept.
//
// On boot we ask /post-version for the post's current SHA-256 (plus,
// for the post author, the history of past hashes). The comments UI
// compares the current hash to a localStorage entry of "last hash I
// showed this user" — if it differs (and a previous one was recorded),
// we render a banner so the user understands why their old comments
// might appear outdated or have been resolved.

import { parseProblem } from "../shared/problemDetails.ts";
import {
  PostVersionResponse as PostVersionResponseSchema,
  type PostVersionEntry as PostVersionEntryType,
  type PostVersionResponse as PostVersionResponseType,
} from "../shared/commentSchemas.ts";

// Wire shapes, defined once in shared/commentSchemas.ts and re-exported here so
// existing importers keep their path. `isAuthor` is the server-computed
// authoritative author flag (TLS-verified session email vs. the post's
// author-email meta tag) — use it instead of any DOM-based check, since the
// served HTML's `<meta name="author-email">` is stripped in prod for spam
// reasons and a client-side `document.querySelector` returns false there.
// `history` is present only when isAuthor === true.
export type PostVersionEntry = PostVersionEntryType;
export type PostVersionResponse = PostVersionResponseType;

const LAST_SEEN_PREFIX = "blog-doc-version:";

function lastSeenKey(postPath: string): string {
  return `${LAST_SEEN_PREFIX}${postPath}`;
}

export async function fetchPostVersion(
  postPath: string,
): Promise<PostVersionResponse | null> {
  try {
    const res = await fetch(
      `/post-version?post=${encodeURIComponent(postPath)}`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json, application/problem+json" },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const p = await parseProblem(res);
      console.warn(
        `fetchPostVersion: ${res.status}${p ? ` ${p.type}` : ""}` +
          (p?.detail ? ` — ${p.detail}` : ""),
      );
      return null;
    }
    // A malformed body degrades to the same null as a 404 / non-ok — the
    // version banner just doesn't show. No new crash surface.
    const parsed = PostVersionResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.warn("fetchPostVersion failed:", err);
    return null;
  }
}

export function getLastSeenVersion(postPath: string): string | null {
  try {
    return localStorage.getItem(lastSeenKey(postPath));
  } catch {
    return null;
  }
}

export function setLastSeenVersion(postPath: string, hash: string): void {
  try {
    localStorage.setItem(lastSeenKey(postPath), hash);
  } catch {
    // localStorage may be disabled — fail silently; the worst-case is
    // a banner that won't go away.
  }
}
