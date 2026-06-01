// Coverage for the ApiError Retry-After parsing — the universal
// rate-limit signal that lets the comments sync layer back off
// regardless of whether the 429 came from our Worker (via
// shared/problemDetails.ts) or from Cloudflare's edge (1xxx-class
// problem+json — same media type, different `type` URI).
//
// The end-to-end backoff is tested indirectly through commentsSync; this
// file just pins down the header parsing.

import { test, expect } from "bun:test";
import { ApiError, MAX_RETRY_AFTER_MS } from "./commentsApi.ts";

test("ApiError captures delta-seconds Retry-After in ms", () => {
  const err = new ApiError(429, null, "putChange", "60");
  expect(err.retryAfterMs).toBe(60_000);
});

test("ApiError handles whitespace around delta-seconds", () => {
  const err = new ApiError(429, null, "putChange", "  30  ");
  expect(err.retryAfterMs).toBe(30_000);
});

test("ApiError parses HTTP-date Retry-After (RFC 9110 §10.2.3 second form)", () => {
  // Anchor a date ~5 minutes in the future; the parsed value should be
  // positive but bounded by that delta (clock-skew tolerant).
  const future = new Date(Date.now() + 5 * 60 * 1000).toUTCString();
  const err = new ApiError(429, null, "putChange", future);
  expect(err.retryAfterMs).not.toBeNull();
  expect(err.retryAfterMs!).toBeGreaterThan(0);
  expect(err.retryAfterMs!).toBeLessThanOrEqual(5 * 60 * 1000);
});

test("ApiError clamps past HTTP-date to 0 (never negative)", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const err = new ApiError(429, null, "putChange", past);
  expect(err.retryAfterMs).toBe(0);
});

test("ApiError clamps absurd delta-seconds to MAX_RETRY_AFTER_MS (F6: setTimeout overflow guard)", () => {
  // 99999999999 seconds would, unclamped, exceed 2^31-1 ms and cause
  // setTimeout to fire immediately, busy-looping requestSync.
  const err = new ApiError(429, null, "putChange", "99999999999");
  expect(err.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
});

test("ApiError clamps absurdly distant HTTP-date to MAX_RETRY_AFTER_MS (F6)", () => {
  const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toUTCString();
  const err = new ApiError(429, null, "putChange", farFuture);
  expect(err.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
});

test("ApiError without Retry-After header → retryAfterMs is null", () => {
  const err = new ApiError(429, null, "putChange");
  expect(err.retryAfterMs).toBeNull();
});

test("ApiError with garbage Retry-After header → null (not NaN)", () => {
  const err = new ApiError(429, null, "putChange", "not-a-date-or-int");
  expect(err.retryAfterMs).toBeNull();
});

test("ApiError message prefers problem.detail, then problem.title, then synthetic", () => {
  const detail = new ApiError(
    400,
    {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "post is required",
    },
    "listUsers",
  );
  expect(detail.message).toBe("post is required");

  const titleOnly = new ApiError(
    400,
    { type: "about:blank", title: "Bad Request", status: 400 },
    "listUsers",
  );
  expect(titleOnly.message).toBe("Bad Request");

  const noBody = new ApiError(500, null, "listUsers");
  expect(noBody.message).toBe("listUsers failed: 500");
});
