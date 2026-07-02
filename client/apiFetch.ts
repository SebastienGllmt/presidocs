// Shared fetch scaffold for the client's JSON APIs (`/comments`,
// `/resolutions`). Both routes speak RFC 9457 problem+json; both wrap a non-2xx
// in `ApiError`, and a malformed 2xx body in a status-200 `ApiError` so it falls
// into the SAME backoff/skip path a transport failure would (a blind `as`
// couldn't tell a real body from an error page that happened to JSON-parse).
// commentsApi.ts and resolutionsApi.ts are the thin route-specific wrappers
// built on this.

import { parseProblem, type ProblemDetails } from "../shared/problemDetails.ts";
import type { z } from "zod";

// Convenience: every call site advertises that it understands the problem+json
// content type alongside the application/json body it expects on the happy path.
export const ACCEPT = "application/json, application/problem+json";

// One-hour ceiling on any backoff window. Above ~24.8 days (`2^31-1` ms)
// `setTimeout` silently clamps the delay to 1 ms and fires immediately, which
// would busy-loop `requestSync()` against a `rateLimitedUntilMs` that never
// elapses. The cap also defangs a hostile / misconfigured proxy that injects
// `Retry-After: 9999999999`. One hour is comfortably above any rate-limit
// window we'd ever realistically emit (the engine's wrangler.toml is 60s).
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

// Sentinel thrown by every wrapper on non-2xx. Carries the parsed
// problem-details body when the server sent one, or null for non-problem
// responses (the dev-only / static-asset paths called out as out-of-scope in
// methodology.md → "HTTP error responses").
//
// Per RFC 9457 §3.1.4, consumers SHOULD NOT branch on `detail` — branch on
// `status` + `problem?.type` instead. `detail` is the human-readable string we
// surface to the log/UI.
//
// `retryAfterMs` captures the standard HTTP `Retry-After` header (RFC 9110
// §10.2.3). The header is the *universal* rate-limit signal: our Worker emits it
// on `rate-limit/exceeded`, AND Cloudflare's edge emits it on its 1xxx-class
// 429s (e.g. 1015) — so reading the header gives us backoff coverage for both
// layers without parsing the snake_case `retry_after` extension Cloudflare
// embeds in its body.
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

// RFC 9110 §10.2.3: Retry-After is either a delta-seconds non-negative integer
// or an HTTP-date. Only delta-seconds is in our two emitters' wire format today
// (our helper writes "60"; Cloudflare's example writes 30). Parse both shapes
// defensively; ignore unparseable values; clamp to [0, MAX_RETRY_AFTER_MS].
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

// Build a route URL: `${route}?…` with `post` and any other defined params, in
// insertion order (undefined params omitted). Both /comments and /resolutions
// share this exact shape.
export function apiUrl(route: string, params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, v);
  return `${route}?${usp.toString()}`;
}

// Wrap a non-2xx Response as an ApiError, capturing problem+json + Retry-After.
export async function apiError(res: Response, op: string): Promise<ApiError> {
  // Snapshot the header BEFORE consuming the body — parseProblem may read the
  // stream and some hosts strip headers when the body is drained (defensive;
  // not observed in practice).
  const retryAfter = res.headers.get("Retry-After");
  return new ApiError(res.status, await parseProblem(res), op, retryAfter);
}

// A 2xx whose body isn't the shape we expect (a server bug, a captive-portal
// HTML page, a meddling proxy) is NOT trusted into the CRDT/UI — it's surfaced
// as a status-200 ApiError (the request itself succeeded; only the body was
// wrong) so it falls into the same backoff/skip path as a transport failure.
export function invalidShape(op: string): ApiError {
  return new ApiError(200, null, `${op} (malformed response body)`);
}

// GET a JSON endpoint and validate the body against `schema`: throws ApiError on
// a non-2xx (via apiError) and invalidShape on a malformed body.
export async function apiGetJson<T>(url: string, op: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: ACCEPT },
  });
  if (!res.ok) throw await apiError(res, op);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw invalidShape(op);
  return parsed.data;
}
