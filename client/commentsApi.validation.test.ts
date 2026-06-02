// Boundary validation for the client fetch wrappers. Each
// wrapper now `safeParse`s the response instead of trusting it via a blind
// `as` cast; a 2xx whose body isn't the expected shape degrades into the
// caller's *existing* failure path (ApiError → backoff, or null → "missing"),
// never into a malformed value flowing on into the CRDT/UI.

import { afterEach, expect, test } from "bun:test";

import {
  listChanges,
  listUsers,
  ApiError,
} from "./commentsApi.ts";
import {
  getResolution,
  listResolutions,
  putResolution,
  type ResolutionEnvelope,
} from "./resolutionsApi.ts";

const originalFetch = globalThis.fetch;

function installFetch(
  stub: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  Object.defineProperty(globalThis, "fetch", {
    value: stub,
    writable: true,
    configurable: true,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    writable: true,
    configurable: true,
  });
});

// ---- listUsers / listChanges: malformed body → ApiError (backoff path) -----

test("listUsers parses a well-formed string array", async () => {
  installFetch(async () => json(["google:1", "microsoft:2"]));
  expect(await listUsers("/posts/foo")).toEqual(["google:1", "microsoft:2"]);
});

test("listUsers throws ApiError when the body isn't a string array", async () => {
  // An HTML error page that happened to parse, or a server bug.
  installFetch(async () => json({ not: "an array" }));
  await expect(listUsers("/posts/foo")).rejects.toBeInstanceOf(ApiError);
});

test("listChanges parses well-formed entries", async () => {
  const hash = "a".repeat(64);
  installFetch(async () =>
    json([{ hash, size: 12, uploaded: "2026-05-31T12:00:00Z" }]),
  );
  const out = await listChanges("/posts/foo", "google:1");
  expect(out).toEqual([{ hash, size: 12, uploaded: "2026-05-31T12:00:00Z" }]);
});

test("listChanges throws ApiError on a bad hash (wrong shape)", async () => {
  // `hash` isn't 64-hex — exactly the kind of corruption a blind `as` would
  // have waved through into the set-diff.
  installFetch(async () =>
    json([{ hash: "nope", size: 12, uploaded: "2026-05-31T12:00:00Z" }]),
  );
  await expect(listChanges("/posts/foo", "google:1")).rejects.toBeInstanceOf(
    ApiError,
  );
});

// ---- getResolution: malformed envelope → null (treated like 404) ----------

test("getResolution parses a well-formed envelope", async () => {
  const env: ResolutionEnvelope = {
    threadId: "t1",
    resolvedAt: 1234,
    resolverId: "ai-applied",
    resolverName: "AI",
  };
  installFetch(async () => json(env));
  expect(await getResolution("/posts/foo", "t1")).toEqual(env);
});

test("getResolution returns null on a malformed envelope (degrade to missing)", async () => {
  installFetch(async () => json({ threadId: "t1" })); // missing fields
  expect(await getResolution("/posts/foo", "t1")).toBeNull();
});

test("getResolution still returns null on 404", async () => {
  installFetch(async () => new Response("", { status: 404 }));
  expect(await getResolution("/posts/foo", "t1")).toBeNull();
});

// ---- listResolutions: malformed listing → ApiError ------------------------

test("listResolutions throws ApiError when the listing isn't an array", async () => {
  installFetch(async () => json({ oops: true }));
  await expect(listResolutions("/posts/foo")).rejects.toBeInstanceOf(ApiError);
});

// ---- putResolution: validate the body BEFORE it goes on the wire ----------

test("putResolution rejects a malformed envelope before fetching", async () => {
  let fetched = false;
  installFetch(async () => {
    fetched = true;
    return new Response(null, { status: 200 });
  });
  // resolvedAt must be an int — a string is a programming error we want to
  // catch loudly, not serialize.
  const bad = {
    threadId: "t1",
    resolvedAt: "soon",
    resolverId: "ai-applied",
    resolverName: "AI",
  } as unknown as ResolutionEnvelope;
  await expect(putResolution("/posts/foo", "t1", bad)).rejects.toThrow();
  expect(fetched).toBe(false);
});

test("putResolution sends a well-formed envelope", async () => {
  let body: unknown = null;
  installFetch(async (_url, init) => {
    body = init?.body ?? null;
    return new Response(null, { status: 200 });
  });
  const env: ResolutionEnvelope = {
    threadId: "t1",
    resolvedAt: 1234,
    resolverId: "google:9",
    resolverName: "Reader",
  };
  await putResolution("/posts/foo", "t1", env);
  expect(JSON.parse(body as string)).toEqual(env);
});
