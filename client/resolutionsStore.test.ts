// Boundary validation for the resolutions localStorage cache. The store now
// `safeParse`s the persisted blob against the shared `CachedResolutions`
// schema on read (composing `ResolutionEnvelope`), so a stale/wrong shape —
// from an older engine version or another same-origin script — drops the whole
// cache and re-fetches, instead of flowing a malformed value into the UI.

import "../happydom.ts"; // localStorage / DOM env (per-file opt-in convention)

import { test, expect, afterEach } from "bun:test";
import { ResolutionStore } from "./resolutionsStore.ts";

const POST = "/posts/x";
function key(post: string) {
  return `blog-resolutions:${post}`;
}

afterEach(() => {
  localStorage.clear();
});

const validEntry = {
  uploadedAt: "2026-06-08T00:00:00.000Z",
  envelope: {
    threadId: "t1",
    resolvedAt: 1234,
    resolverId: "google:abc",
    resolverName: "A",
  },
};

test("loads a well-formed cache from localStorage", () => {
  localStorage.setItem(key(POST), JSON.stringify({ t1: validEntry }));
  const store = new ResolutionStore(POST);
  expect(store.isResolved("t1")).toBe(true);
  expect(store.get("t1")?.resolverId).toBe("google:abc");
});

test("drops a malformed cache (bad envelope shape) instead of loading it", () => {
  localStorage.setItem(
    key(POST),
    JSON.stringify({
      t1: { uploadedAt: "2026-06-08", envelope: { threadId: "t1" } }, // missing fields
    }),
  );
  const store = new ResolutionStore(POST);
  expect(store.isResolved("t1")).toBe(false); // whole cache dropped, re-fetch path
});

test("drops a cache whose top level is the wrong type (array, not record)", () => {
  localStorage.setItem(key(POST), JSON.stringify([validEntry]));
  const store = new ResolutionStore(POST);
  expect(store.isResolved("t1")).toBe(false);
});

test("survives malformed JSON without throwing", () => {
  localStorage.setItem(key(POST), "{not json");
  const store = new ResolutionStore(POST);
  expect(store.isResolved("t1")).toBe(false);
});

test("no cache → empty store", () => {
  const store = new ResolutionStore(POST);
  expect(store.isResolved("t1")).toBe(false);
});
