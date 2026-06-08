import { test, expect, afterEach } from "bun:test";
import { fetchGoogleUserInfo, fetchMicrosoftUserInfo } from "./userinfo.ts";

// userinfo.ts calls global `fetch`; stub it per-test and restore after.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubJson(body: unknown, ok = true, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  // The fetcher only reads res.ok/.status/.statusText/.json(); a real
  // Response covers all of those.
  void ok;
}

test("Google: a well-formed payload round-trips", async () => {
  stubJson({
    sub: "123",
    email: "a@b.com",
    email_verified: true,
    name: "A",
    picture: "p",
  });
  const info = await fetchGoogleUserInfo("tok");
  expect(info.sub).toBe("123");
  expect(info.email).toBe("a@b.com");
  expect(info.emailVerified).toBe(true);
});

test("Google: empty sub is rejected at the boundary (before any userId)", async () => {
  stubJson({ sub: "", email: "a@b.com", email_verified: true });
  await expect(fetchGoogleUserInfo("tok")).rejects.toThrow();
});

test("Google: missing sub is rejected", async () => {
  stubJson({ email: "a@b.com", email_verified: true });
  await expect(fetchGoogleUserInfo("tok")).rejects.toThrow();
});

test("Google: non-boolean email_verified is rejected", async () => {
  stubJson({ sub: "1", email: "a@b.com", email_verified: "true" });
  await expect(fetchGoogleUserInfo("tok")).rejects.toThrow();
});

test("Google: an additive unknown claim passes (bare z.object)", async () => {
  stubJson({
    sub: "1",
    email: "a@b.com",
    email_verified: false,
    hd: "example.com", // unknown
  });
  const info = await fetchGoogleUserInfo("tok");
  expect(info.sub).toBe("1");
  expect(info.emailVerified).toBe(false);
});

test("Microsoft: preferred_username is used when email is absent", async () => {
  stubJson({ sub: "ms-1", preferred_username: "u@corp.com", name: "U" });
  const info = await fetchMicrosoftUserInfo("tok");
  expect(info.email).toBe("u@corp.com");
  expect(info.emailVerified).toBe(true); // verified-by-definition
});

test("Microsoft: neither email nor preferred_username throws", async () => {
  stubJson({ sub: "ms-1", name: "U" });
  await expect(fetchMicrosoftUserInfo("tok")).rejects.toThrow();
});

test("Microsoft: empty sub is rejected", async () => {
  stubJson({ sub: "", email: "u@corp.com" });
  await expect(fetchMicrosoftUserInfo("tok")).rejects.toThrow();
});
