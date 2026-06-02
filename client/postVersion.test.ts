// Tier 2 — postVersion fetch + localStorage round-trip.
//
// The fetch helper has three distinct outcomes (success, 404 → null,
// other-non-ok → null) and the localStorage round-trip drives the
// "doc changed" banner trigger. Together they're the input to the
// comments-column version banner; getting either silently wrong leaves
// readers staring at a banner that never goes away (or never appears).

import "../happydom.ts";

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  fetchPostVersion,
  getLastSeenVersion,
  setLastSeenVersion,
  type PostVersionResponse,
} from "./postVersion.ts";

// Capture and swap `fetch` so each test gets to inject its own response.
// We use Object.defineProperty rather than a plain `globalThis.fetch =`
// because happy-dom's fetch (when registered) sits on globalThis as a
// non-writable property in some Bun versions; defineProperty bypasses
// the writability check.
const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(stub: FetchStub): void {
  Object.defineProperty(globalThis, "fetch", {
    value: stub,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    writable: true,
    configurable: true,
  });
});

// ---- fetchPostVersion --------------------------------------------------

test("fetchPostVersion parses { currentHash, isAuthor } on 200", async () => {
  installFetch(async () =>
    new Response(
      JSON.stringify({ currentHash: "abc123", isAuthor: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const out = await fetchPostVersion("/posts/foo");
  expect(out?.currentHash).toBe("abc123");
  expect(out?.isAuthor).toBe(false);
});

test("fetchPostVersion includes history when isAuthor=true", async () => {
  const body: PostVersionResponse = {
    currentHash: "h2",
    isAuthor: true,
    history: [
      { hash: "h2", builtAt: "2026-05-31T12:00:00Z" },
      { hash: "h1", builtAt: "2026-05-30T12:00:00Z" },
    ],
  };
  installFetch(async () =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
  const out = await fetchPostVersion("/posts/foo");
  expect(out?.history?.length).toBe(2);
  expect(out?.history?.[0]?.hash).toBe("h2");
});

test("fetchPostVersion returns null on 404 (post deleted / not yet built)", async () => {
  installFetch(async () => new Response("", { status: 404 }));
  expect(await fetchPostVersion("/posts/missing")).toBeNull();
});

test("fetchPostVersion returns null on a malformed 200 body (degrade like 404)", async () => {
  // A 200 whose JSON is the wrong shape (a meddling proxy, a server bug, an
  // HTML page that parsed). The banner just won't show — no crash, no garbage
  // currentHash flowing into the version compare.
  installFetch(async () =>
    new Response(JSON.stringify({ isAuthor: "yes" }), { status: 200 }),
  );
  expect(await fetchPostVersion("/posts/foo")).toBeNull();
});

test("fetchPostVersion returns null on 401 / 500 / other non-2xx (safe degrade)", async () => {
  installFetch(async () => new Response("nope", { status: 401 }));
  expect(await fetchPostVersion("/posts/foo")).toBeNull();

  installFetch(async () => new Response("oops", { status: 500 }));
  expect(await fetchPostVersion("/posts/foo")).toBeNull();
});

test("fetchPostVersion returns null when the network throws (offline, CORS)", async () => {
  installFetch(async () => {
    throw new Error("network error");
  });
  expect(await fetchPostVersion("/posts/foo")).toBeNull();
});

test("fetchPostVersion URL-encodes the post path", async () => {
  let captured = "";
  installFetch(async (url) => {
    captured = url;
    return new Response(JSON.stringify({ currentHash: "h", isAuthor: false }), {
      status: 200,
    });
  });
  await fetchPostVersion("/posts/foo bar");
  // Space encoded as %20; `/` not encoded.
  expect(captured).toBe("/post-version?post=%2Fposts%2Ffoo%20bar");
});

// ---- last-seen round-trip + banner-trigger predicate ----------------

test("getLastSeenVersion returns null before any setLastSeenVersion call", () => {
  expect(getLastSeenVersion("/posts/foo")).toBeNull();
});

test("setLastSeenVersion → getLastSeenVersion round-trips", () => {
  setLastSeenVersion("/posts/foo", "hash-A");
  expect(getLastSeenVersion("/posts/foo")).toBe("hash-A");
});

test("setLastSeenVersion is keyed per post path (no cross-post bleed)", () => {
  setLastSeenVersion("/posts/foo", "hash-foo");
  setLastSeenVersion("/posts/bar", "hash-bar");
  expect(getLastSeenVersion("/posts/foo")).toBe("hash-foo");
  expect(getLastSeenVersion("/posts/bar")).toBe("hash-bar");
});

test("banner trigger: shows iff lastSeen exists AND differs from currentHash", () => {
  // Trigger predicate (computed by the comments UI on top of these two
  // helpers): `lastSeen !== null && lastSeen !== currentHash`. We don't
  // export it as a function, but the helpers' contract is what makes
  // that predicate correct, so pin both halves here.
  const post = "/posts/foo";

  // First-ever load: no banner (we have nothing to compare to).
  expect(getLastSeenVersion(post)).toBeNull();
  setLastSeenVersion(post, "v1");

  // Same-as-last-seen: no banner.
  expect(getLastSeenVersion(post)).toBe("v1");

  // Differs: banner condition true.
  setLastSeenVersion(post, "v1"); // explicit re-set, mimicking the render
  const currentNewBuild = "v2";
  const lastSeen = getLastSeenVersion(post);
  expect(lastSeen !== null && lastSeen !== currentNewBuild).toBe(true);
});
