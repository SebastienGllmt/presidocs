// Tests for the RFC 9457 helper. Covers the wire-format contracts
// methodology.md's "HTTP error responses" section commits to: the
// about:blank vs project-slug branch, the per-slug title constancy,
// extension passthrough (and the core-members-win-over-extensions
// invariant), the rate-limit Retry-After pairing, and the symmetric
// parser's content-type + size guards.

import { test, expect } from "bun:test";
import { problem, parseProblem, resolveProblemBase } from "./problemDetails.ts";

test("project slug → full type URI + content-type + per-slug title", async () => {
  const res = problem(401, "auth/unauthenticated");
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  const body = await res.json();
  expect(body.type).toMatch(/\/probs\/auth\/unauthenticated$/);
  expect(body.title).toBe("Authentication required");
  expect(body.status).toBe(401);
  expect(body.detail).toBeUndefined();
});

test("about:blank → type stays literal, title = HTTP reason phrase", async () => {
  const res = problem(405, "about:blank");
  const body = await res.json();
  expect(body.type).toBe("about:blank");
  expect(body.title).toBe("Method Not Allowed");
  expect(body.status).toBe(405);
});

test("about:blank uses the library reason phrase, even for codes no hand-table had", async () => {
  // 409 was never in the old hand-maintained table; http-status-codes has it.
  const body = await problem(409, "about:blank").json();
  expect(body.title).toBe("Conflict");
});

test("about:blank for a genuinely unassigned status falls back to `HTTP <n>`", async () => {
  const res = problem(799, "about:blank");
  const body = await res.json();
  expect(body.title).toBe("HTTP 799");
});

test("detail is included when provided, omitted when not", async () => {
  const a = await problem(400, "request/missing-parameter", "post is required").json();
  expect(a.detail).toBe("post is required");
  const b = await problem(400, "request/missing-parameter").json();
  expect(b.detail).toBeUndefined();
});

test("extensions pass through as top-level members (RFC §3.2)", async () => {
  const res = problem(413, "comments/change-too-large", undefined, {
    maxBytes: 8192,
    actualBytes: 12000,
  });
  const body = await res.json();
  expect(body.maxBytes).toBe(8192);
  expect(body.actualBytes).toBe(12000);
  // Core members survive.
  expect(body.type).toMatch(/\/comments\/change-too-large$/);
  expect(body.status).toBe(413);
});

test("rate-limit/exceeded auto-adds Retry-After: 60 (RFC §4 + RFC 9110 §10.2.3)", async () => {
  const res = problem(429, "rate-limit/exceeded", undefined, { retryAfter: 60 });
  expect(res.headers.get("Retry-After")).toBe("60");
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  const body = await res.json();
  expect(body.retryAfter).toBe(60);
});

test("non-rate-limit problems do not get a Retry-After header", () => {
  const res = problem(403, "auth/forbidden");
  expect(res.headers.get("Retry-After")).toBeNull();
});

test("parseProblem reads our own output", async () => {
  const res = problem(400, "request/empty-body");
  const parsed = await parseProblem(res);
  expect(parsed).not.toBeNull();
  expect(parsed?.type).toMatch(/\/request\/empty-body$/);
  expect(parsed?.status).toBe(400);
});

test("parseProblem returns null for non-problem responses (wrong content-type)", async () => {
  const res = new Response(JSON.stringify({ foo: 1 }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
  expect(await parseProblem(res)).toBeNull();
});

test("parseProblem returns null for malformed JSON body even with right content-type", async () => {
  const res = new Response("not json{", {
    status: 400,
    headers: { "Content-Type": "application/problem+json" },
  });
  expect(await parseProblem(res)).toBeNull();
});

test("parseProblem accepts content-types with parameters (charset etc.)", async () => {
  const res = new Response(
    JSON.stringify({ type: "about:blank", title: "Not Found", status: 404 }),
    {
      status: 404,
      headers: { "Content-Type": "application/problem+json; charset=utf-8" },
    },
  );
  const parsed = await parseProblem(res);
  expect(parsed?.title).toBe("Not Found");
});

test("extensions CANNOT overwrite core members (F1: §3.1.2 body/wire status MUST match)", async () => {
  const res = problem(429, "rate-limit/exceeded", undefined, {
    // All four would corrupt the contract if naively merged after core.
    status: 999,
    type: "https://evil.example/spoof",
    title: "Spoofed",
    detail: "should not stomp",
  });
  // Wire status is the authoritative one.
  expect(res.status).toBe(429);
  const body = await res.json();
  expect(body.status).toBe(429);
  expect(body.type).toMatch(/\/probs\/rate-limit\/exceeded$/);
  expect(body.title).toBe("Rate limit exceeded");
  // detail param wasn't passed, so the extension-key `detail` is
  // suppressed by the core spread; the body has no detail.
  expect(body.detail).toBeUndefined();
});

test("non-overlapping extensions still pass through (F1 fix doesn't drop ext)", async () => {
  const res = problem(413, "comments/change-too-large", "too big", {
    maxBytes: 8192,
    actualBytes: 10000,
    instance: "urn:uuid:abc",
  });
  const body = await res.json();
  expect(body.maxBytes).toBe(8192);
  expect(body.actualBytes).toBe(10000);
  expect(body.instance).toBe("urn:uuid:abc");
  expect(body.detail).toBe("too big");
});

test("parseProblem rejects look-alike media types (F4: strict equality, not substring)", async () => {
  // The pre-fix regression: text/plain with a quoted-string parameter
  // containing the media type would pass `.includes` and be parsed as
  // a problem body.
  const sneaky = new Response('{"type":"about:blank","title":"x","status":400}', {
    status: 400,
    headers: {
      "Content-Type": 'text/plain; note="application/problem+json"',
    },
  });
  expect(await parseProblem(sneaky)).toBeNull();
  // application/problem+jsonish — close-but-not-equal.
  const fake = new Response("{}", {
    status: 400,
    headers: { "Content-Type": "application/problem+jsonish" },
  });
  expect(await parseProblem(fake)).toBeNull();
});

test("parseProblem rejects bodies above the 64 KB cap via Content-Length (F3)", async () => {
  // A Content-Length above the cap is the cheap pre-check that lets us
  // skip even reading the body.
  const res = new Response("x", {
    status: 400,
    headers: {
      "Content-Type": "application/problem+json",
      "Content-Length": String(1024 * 1024),
    },
  });
  expect(await parseProblem(res)).toBeNull();
});

test("parseProblem rejects bodies that exceed the cap mid-stream (F3)", async () => {
  // No Content-Length advertised; the streaming reader stops once
  // received bytes exceed the cap. Mock a ReadableStream that pushes
  // 80 KB across multiple chunks.
  const cap = 64 * 1024;
  const chunkSize = 16 * 1024;
  let pushed = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pushed >= cap + chunkSize) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSize));
      pushed += chunkSize;
    },
  });
  const res = new Response(stream, {
    status: 400,
    headers: { "Content-Type": "application/problem+json" },
  });
  expect(await parseProblem(res)).toBeNull();
});

test("parseProblem rejects non-object JSON (e.g. a bare number)", async () => {
  const res = new Response("42", {
    status: 400,
    headers: { "Content-Type": "application/problem+json" },
  });
  expect(await parseProblem(res)).toBeNull();
});

test("resolveProblemBase: explicit PROBLEM_BASE_URL wins over SITE_URL", () => {
  const r = resolveProblemBase({
    PROBLEM_BASE_URL: "https://docs.example.org/probs",
    SITE_URL: "https://blog.example.org",
  });
  expect(r).toEqual({ base: "https://docs.example.org/probs", usingFallback: false });
});

test("resolveProblemBase: SITE_URL inferred as `${SITE_URL}/probs`", () => {
  const r = resolveProblemBase({ SITE_URL: "https://blog.example.org" });
  expect(r).toEqual({ base: "https://blog.example.org/probs", usingFallback: false });
});

test("resolveProblemBase: SITE_URL with trailing slash doesn't double up", () => {
  const r = resolveProblemBase({ SITE_URL: "https://blog.example.org/" });
  expect(r.base).toBe("https://blog.example.org/probs");
});

test("resolveProblemBase: empty-string env vars are treated as unset", () => {
  const r = resolveProblemBase({ PROBLEM_BASE_URL: "", SITE_URL: "" });
  expect(r.usingFallback).toBe(true);
});

test("resolveProblemBase: both unset → documentation-reserved fallback", () => {
  const r = resolveProblemBase({});
  expect(r.usingFallback).toBe(true);
  expect(r.base).toBe("https://blog.example.com/probs");
});
