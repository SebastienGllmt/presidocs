// Boundary validation for the /auth/me client wrapper. `loadIdentity` now
// `safeParse`s the body against the shared `IdentityResponse` schema instead
// of blind-casting it: a logged-out reader (`null`) and a malformed body both
// degrade to `null` (the login-button branch), never to a malformed Identity.
//
// `loadIdentity` caches `_identity` at module scope, so each test re-imports a
// fresh module instance (cache-busting query) to reset that cache.

import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let n = 0;
async function freshLoadIdentity() {
  const mod = await import(`./identity.ts?t=${n++}`);
  return mod.loadIdentity as () => Promise<unknown>;
}

function stub(body: unknown, ok = true, status = 200) {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  void ok;
}

test("a well-formed identity body round-trips", async () => {
  stub({
    userId: "google:123",
    email: "a@b.com",
    emailVerified: true,
    name: "A",
    picture: null,
    provider: "google",
  });
  const loadIdentity = await freshLoadIdentity();
  const id = (await loadIdentity()) as { userId: string } | null;
  expect(id?.userId).toBe("google:123");
});

test("the JSON literal null (logged out) returns null", async () => {
  stub("null");
  const loadIdentity = await freshLoadIdentity();
  expect(await loadIdentity()).toBeNull();
});

test("a malformed body degrades to null (bad provider / missing fields)", async () => {
  stub({ userId: "google:123", email: "a@b.com", provider: "saml" });
  const loadIdentity = await freshLoadIdentity();
  expect(await loadIdentity()).toBeNull();
});

test("a userId failing the <provider>:<sub> primitive degrades to null", async () => {
  stub({
    userId: "nope", // no provider prefix
    email: "a@b.com",
    emailVerified: true,
    name: null,
    picture: null,
    provider: "google",
  });
  const loadIdentity = await freshLoadIdentity();
  expect(await loadIdentity()).toBeNull();
});

test("a non-ok response returns null", async () => {
  stub("null", false, 500);
  const loadIdentity = await freshLoadIdentity();
  expect(await loadIdentity()).toBeNull();
});
