// Tier 2 — draftsStorage round-trip + malformed-JSON tolerance.
//
// The store is small but load-bearing: it's the only thing that lets a
// composer survive a tab close. The round-trip is the floor and tolerance
// of bad localStorage values is the next-most-likely failure shape (a
// previous session's storage from a different schema version).

import "../happydom.ts";

import { beforeEach, expect, test } from "bun:test";

import { DraftsStorage, type DraftEntry } from "./draftsStorage.ts";
import type { Thread } from "./commentsStore.ts";

// `Thread` carries a `target` we don't construct here — DraftsStorage's
// shape filter only checks `id` is a string, so we cast a stub. This
// stays inline (no helper) because the test cares about persistence, not
// the inner shape of a thread.
const stubThread = (id: string): Thread =>
  ({ id, target: {}, createdAt: 0, replies: [] }) as unknown as Thread;

beforeEach(() => {
  // Wipe the keyspace so each test starts from a known-empty state. The
  // commentsStore test file uses the same Map-backed localStorage shim;
  // happy-dom's real localStorage is what runs here.
  localStorage.clear();
});

test("load returns [] when no entry exists for the (post, user) key", () => {
  const ds = new DraftsStorage("/posts/foo", "google:123");
  expect(ds.load()).toEqual([]);
});

test("save then load round-trips a single draft", () => {
  const ds = new DraftsStorage("/posts/foo", "google:123");
  const entries: DraftEntry[] = [{ thread: stubThread("d1"), body: "wip" }];
  ds.save(entries);
  const loaded = ds.load();
  expect(loaded.length).toBe(1);
  expect(loaded[0]!.body).toBe("wip");
  expect(loaded[0]!.thread.id).toBe("d1");
});

test("save then load round-trips a suggestion payload on the draft", () => {
  // Proposal 65: a suggestion draft carries its propose-an-edit payload on the
  // Thread; DraftsStorage serializes the whole Thread, so the payload persists
  // across a reload for free.
  const ds = new DraftsStorage("/posts/foo", "google:123");
  const suggestion = {
    proposed: "the fixed text",
    authorId: "google:123",
    authorName: "Ada",
    authorEmail: "ada@example.com",
  };
  const thread = { ...stubThread("d1"), suggestion } as Thread;
  ds.save([{ thread, body: "" }]);
  expect(ds.load()[0]!.thread.suggestion).toEqual(suggestion);
});

test("save with [] removes the key (keeps storage clean)", () => {
  // Methodology calls this out as the "absent ⇒ empty" rule: saving zero
  // drafts should not leave an empty-array entry behind, so the storage
  // inspector reads "the user has no drafts" rather than "the user has a
  // record indicating zero drafts."
  const ds = new DraftsStorage("/posts/foo", "google:123");
  ds.save([{ thread: stubThread("d1"), body: "wip" }]);
  ds.save([]);
  expect(localStorage.getItem("blog-drafts:/posts/foo:user:google:123"))
    .toBeNull();
});

test("load returns [] when the stored JSON is malformed (parse failure)", () => {
  // Future schema migration scenario: an older version wrote a different
  // shape. The current loader must not crash on it.
  localStorage.setItem(
    "blog-drafts:/posts/foo:user:google:123",
    "{not-json}",
  );
  const ds = new DraftsStorage("/posts/foo", "google:123");
  expect(ds.load()).toEqual([]);
});

test("load returns [] when the JSON is valid but the shape is wrong (non-array root)", () => {
  // A previous version stored `{ drafts: [...] }`; today we store the
  // array directly. Defensive against either drift direction.
  localStorage.setItem(
    "blog-drafts:/posts/foo:user:google:123",
    JSON.stringify({ drafts: [] }),
  );
  const ds = new DraftsStorage("/posts/foo", "google:123");
  expect(ds.load()).toEqual([]);
});

test("load filters out individual entries that fail the shape check", () => {
  // One good entry + one missing `body` + one missing `thread.id`.
  // The loader must KEEP the good one and drop the others rather than
  // dropping the whole list.
  localStorage.setItem(
    "blog-drafts:/posts/foo:user:google:123",
    JSON.stringify([
      { thread: { id: "ok" }, body: "good" },
      { thread: { id: "missing-body" } /* no body */ },
      { /* no thread */ body: "orphan" },
    ]),
  );
  const ds = new DraftsStorage("/posts/foo", "google:123");
  const loaded = ds.load();
  expect(loaded.length).toBe(1);
  expect(loaded[0]!.body).toBe("good");
});

test("different (post, user) tuples are isolated (no cross-leakage)", () => {
  const a = new DraftsStorage("/posts/foo", "google:111");
  const b = new DraftsStorage("/posts/foo", "google:222");
  a.save([{ thread: stubThread("a1"), body: "alice-text" }]);
  b.save([{ thread: stubThread("b1"), body: "bob-text" }]);
  expect(a.load()[0]?.body).toBe("alice-text");
  expect(b.load()[0]?.body).toBe("bob-text");
  // Different post path: also a fresh keyspace.
  const aDifferentPost = new DraftsStorage("/posts/bar", "google:111");
  expect(aDifferentPost.load()).toEqual([]);
});
