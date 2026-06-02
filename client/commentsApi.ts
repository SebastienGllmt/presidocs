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
// Errors arrive as RFC 9457 problem+json (see shared/problemDetails.ts).
// We wrap them in `ApiError` so callers can branch on `err.problem?.type`
// — the rate-limit retryAfter extension in particular is consumed by
// commentsSync.ts to back off the push loop.

import { parseProblem, type ProblemDetails } from "../shared/problemDetails.ts";
import {
  ChangeList,
  type ChangeListEntry as ChangeListEntryType,
  CommentUsers,
} from "../shared/commentSchemas.ts";

// Wire shape, defined once in shared/commentSchemas.ts and re-exported here so
// existing importers keep their path.
export type ChangeListEntry = ChangeListEntryType;

// Sentinel thrown by every wrapper on non-2xx. Carries the parsed
// problem-details body when the server sent one, or null for non-
// problem responses (the dev-only / static-asset paths called out as
// out-of-scope in methodology.md → "HTTP error responses").
//
// Per RFC 9457 §3.1.4, consumers SHOULD NOT branch on `detail` —
// branch on `status` + `problem?.type` instead. `detail` is the
// human-readable string we surface to the log/UI.
//
// `retryAfterMs` captures the standard HTTP `Retry-After` header (RFC
// 9110 §10.2.3). The header is the *universal* rate-limit signal:
// our Worker emits it on `rate-limit/exceeded`, AND Cloudflare's edge
// emits it on its 1xxx-class 429s (e.g. 1015) — so reading the header
// gives us backoff coverage for both layers without parsing the
// snake_case `retry_after` extension Cloudflare embeds in its body.
export class ApiError extends Error {
  public readonly retryAfterMs: number | null;
  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetails | null,
    op: string,
    retryAfterHeader?: string | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `${op} failed: ${status}`);
    this.name = "ApiError";
    this.retryAfterMs = parseRetryAfter(retryAfterHeader);
  }
}

// One-hour ceiling on any backoff window. Above ~24.8 days
// (`2^31-1` ms) `setTimeout` silently clamps the delay to 1 ms and
// fires immediately, which would busy-loop `requestSync()` against a
// `rateLimitedUntilMs` that never elapses. The cap also defangs a
// hostile / misconfigured proxy that injects `Retry-After: 9999999999`.
// One hour is comfortably above any rate-limit window we'd ever
// realistically emit (the engine's wrangler.toml is 60s).
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

// RFC 9110 §10.2.3: Retry-After is either a delta-seconds non-negative
// integer or an HTTP-date. Only delta-seconds is in our two emitters'
// wire format today (our helper writes "60"; Cloudflare's example
// writes 30). Parse both shapes defensively; ignore unparseable values;
// clamp to [0, MAX_RETRY_AFTER_MS].
function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

// Convenience: every call site advertises that it understands the
// problem+json content type alongside the application/json body it's
// actually expecting on the happy path.
const ACCEPT = "application/json, application/problem+json";

function commentsUrl(
  post: string,
  user?: string,
  change?: string,
): string {
  const params = new URLSearchParams({ post });
  if (user !== undefined) params.set("user", user);
  if (change !== undefined) params.set("change", change);
  return `/comments?${params.toString()}`;
}

async function apiError(res: Response, op: string): Promise<ApiError> {
  // Snapshot the header BEFORE consuming the body — parseProblem may
  // read the stream and some hosts strip headers when the body is
  // drained (defensive; not observed in practice).
  const retryAfter = res.headers.get("Retry-After");
  return new ApiError(res.status, await parseProblem(res), op, retryAfter);
}

// A 2xx whose body isn't the shape we expect (a server bug, a captive-portal
// HTML page, a meddling proxy) is NOT trusted into the CRDT/UI — it's surfaced
// as an ApiError so it falls into the *same* backoff path commentsSync already
// uses for a transport failure. A blind `as` couldn't tell a real list from an
// error page that happened to JSON-parse.
function invalidShape(op: string): ApiError {
  // Status 200 — the request itself succeeded; only the body was wrong.
  return new ApiError(200, null, `${op} (malformed response body)`);
}

// Author-only — server returns 403 for non-authors.
export async function listUsers(post: string): Promise<string[]> {
  const res = await fetch(commentsUrl(post), {
    credentials: "same-origin",
    headers: { Accept: ACCEPT },
  });
  if (!res.ok) throw await apiError(res, "listUsers");
  const parsed = CommentUsers.safeParse(await res.json());
  if (!parsed.success) throw invalidShape("listUsers");
  return parsed.data;
}

export async function listChanges(
  post: string,
  user: string,
): Promise<ChangeListEntry[]> {
  const res = await fetch(commentsUrl(post, user), {
    credentials: "same-origin",
    headers: { Accept: ACCEPT },
  });
  if (!res.ok) throw await apiError(res, "listChanges");
  const parsed = ChangeList.safeParse(await res.json());
  if (!parsed.success) throw invalidShape("listChanges");
  return parsed.data;
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
