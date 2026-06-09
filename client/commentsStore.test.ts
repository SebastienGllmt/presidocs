// Tests for the CRDT-backed comment store.
//
// Bun's runtime doesn't ship a `localStorage`, so we install a small
// in-memory shim before importing the store. The other web APIs the
// store touches (`crypto.randomUUID`, `btoa`, `atob`, `TextEncoder`,
// `structuredClone`) are all available in Bun natively.

import { test, expect, beforeEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// ---- Storage shim ------------------------------------------------------
// Installed at module top-level (before `import` of commentsStore.ts
// would call any of these — though our store only reads localStorage
// inside `create()` / `mutate()`, not at module load).
//
// We use `Object.defineProperty` instead of plain `globalThis.localStorage =`
// so this still works when another test file in the same `bun test` run has
// registered happy-dom (see ../happydom.ts) — happy-dom installs its own
// `localStorage` as a non-writable property, which would reject a plain
// assignment.

const storage = new Map<string, string>();
const localStorageShim: Storage = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => {
    storage.set(k, String(v));
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  clear: () => {
    storage.clear();
  },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() {
    return storage.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  writable: true,
  configurable: true,
});

// ---- Now import the store (after shim is in place) ---------------------

const {
  CommentStore,
  isResolved,
  isDeleted,
  visibleReplies,
  setCommentsWasmSource,
  makeTextTarget,
  makeGraphicTarget,
  graphicTargetId,
  audioFragmentRange,
  MEDIA_FRAGS_SPEC,
} = await import("./commentsStore.ts");

// ---- WASM source: read directly off node_modules ----------------------
// In the browser the store fetches `/assets/automerge.wasm` (served by
// index.ts). The test runtime has no HTTP server, so we resolve the
// package's WASM file via node's require.resolve and hand the bytes to
// the store before any test calls `CommentStore.create()`.
{
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@automerge/automerge/automerge.wasm");
  const wasmBytes = await readFile(wasmPath);
  setCommentsWasmSource(new Uint8Array(wasmBytes));
}
// CommentStore's constructor is private (callers go through `.create()`),
// so we derive the instance type from the public factory.
type StoreT = Awaited<ReturnType<typeof CommentStore.create>>;

// ---- Helpers -----------------------------------------------------------

function freshStorage() {
  storage.clear();
}

// Web Annotation targets, built through the same constructors the UI
// uses so the stored shape under test is exactly what ships.
const ANCHOR_TEXT = makeTextTarget({
  context: "article",
  blocks: [{ id: "id:foo", hash: "hash-of-foo" }],
  startOffset: 0,
  endOffset: 10,
  quote: "Hello world",
});

const ANCHOR_GRAPHIC = makeGraphicTarget("article", "id:diagram");

const TEST_USER_ID = "google:test-user-123";

function reply(id: string, body: string, createdAt: number) {
  return {
    id,
    body,
    createdAt,
    authorId: TEST_USER_ID,
    authorName: "Test User",
    authorEmail: "test@example.com",
  };
}

async function makeStore(
  path = "/posts/hash-functions",
  userId = TEST_USER_ID,
): Promise<StoreT> {
  return await CommentStore.create(path, userId);
}

// ---- Tests -------------------------------------------------------------

beforeEach(() => {
  freshStorage();
});

test("fresh store starts empty", async () => {
  const s = await makeStore();
  expect(s.snapshot()).toEqual([]);
});

test("addThread + addReply round-trip via snapshot", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "hi", 110));
  const snap = s.snapshot();
  expect(snap.length).toBe(1);
  expect(snap[0]!.id).toBe("t1");
  expect(snap[0]!.target).toEqual(ANCHOR_TEXT);
  expect(snap[0]!.replies.length).toBe(1);
  expect(snap[0]!.replies[0]!.body).toBe("hi");
  expect(snap[0]!.createdAt).toBe(100);
});

test("addReply on unknown thread is a no-op", async () => {
  const s = await makeStore();
  s.addReply("nope", reply("r1", "hi", 110));
  expect(s.snapshot()).toEqual([]);
});

test("replies are returned sorted by createdAt regardless of insert order", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r-late", "second", 200));
  s.addReply("t1", reply("r-early", "first", 110));
  s.addReply("t1", reply("r-middle", "middle", 150));
  const replies = s.snapshot()[0]!.replies;
  expect(replies.map((r) => r.body)).toEqual(["first", "middle", "second"]);
});

test("threads in snapshot are sorted by thread createdAt", async () => {
  const s = await makeStore();
  s.addThread("t-late", ANCHOR_TEXT, 300);
  s.addThread("t-early", ANCHOR_TEXT, 100);
  s.addThread("t-mid", ANCHOR_TEXT, 200);
  const ids = s.snapshot().map((t) => t.id);
  expect(ids).toEqual(["t-early", "t-mid", "t-late"]);
});

test("resolveThread sets resolvedAt; snapshot still includes the thread", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "hi", 110));
  s.resolveThread("t1", 999);
  const snap = s.snapshot();
  expect(snap.length).toBe(1); // store doesn't filter — UI does
  expect(snap[0]!.resolvedAt).toBe(999);
  expect(isResolved(snap[0]!)).toBe(true);
});

test("deleteReply tombstones; the deleted reply stays in snapshot", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "first", 110));
  s.addReply("t1", reply("r2", "second", 120));
  s.deleteReply("t1", "r1", 500);
  const t = s.snapshot()[0]!;
  expect(t.replies.length).toBe(2); // both still present
  const r1 = t.replies.find((r) => r.id === "r1")!;
  const r2 = t.replies.find((r) => r.id === "r2")!;
  expect(isDeleted(r1)).toBe(true);
  expect(r1.deletedAt).toBe(500);
  expect(isDeleted(r2)).toBe(false);
  expect(visibleReplies(t).length).toBe(1);
  expect(visibleReplies(t)[0]!.id).toBe("r2");
});

test("deleting the LAST visible reply auto-resolves the thread atomically", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "only", 110));
  s.deleteReply("t1", "r1", 500);
  const t = s.snapshot()[0]!;
  expect(isResolved(t)).toBe(true);
  expect(t.resolvedAt).toBe(500);
  // The reply is tombstoned but kept, so the deletion queue can flush it.
  expect(t.replies.length).toBe(1);
  expect(isDeleted(t.replies[0]!)).toBe(true);
});

test("deleting an already-deleted reply doesn't double-stamp", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "first", 110));
  s.addReply("t1", reply("r2", "second", 120));
  s.deleteReply("t1", "r1", 500);
  s.deleteReply("t1", "r1", 999); // attempt again with different timestamp
  const r1 = s.snapshot()[0]!.replies.find((r) => r.id === "r1")!;
  // First delete wins. (The store's deleteReply early-returns when the
  // reply is already deleted; without that guard, redundant calls would
  // overwrite the original deletedAt.)
  expect(r1.deletedAt).toBe(500);
});

test("re-resolving an already-resolved thread doesn't move the timestamp", async () => {
  const s = await makeStore();
  s.addThread("t1", ANCHOR_TEXT, 100);
  s.addReply("t1", reply("r1", "hi", 110));
  s.resolveThread("t1", 500);
  s.resolveThread("t1", 999);
  expect(s.snapshot()[0]!.resolvedAt).toBe(500);
});

test("graphic anchors round-trip", async () => {
  const s = await makeStore();
  s.addThread("g1", ANCHOR_GRAPHIC, 100);
  s.addReply("g1", reply("r1", "diagram is great", 110));
  const t = s.snapshot()[0]!;
  expect(t.target).toEqual(ANCHOR_GRAPHIC);
  expect(graphicTargetId(t.target as typeof ANCHOR_GRAPHIC)).toBe("id:diagram");
});

test("narration target carries an auto-derived Media Fragments selector", async () => {
  const target = makeTextTarget({
    context: "narration",
    blocks: [{ id: "id:lede", hash: "h" }],
    startOffset: 0,
    endOffset: 5,
    quote: "Hello",
    audioRange: { startMs: 2868, endMs: 8838 },
  });
  // Third selector is the Media Fragments FragmentSelector, in seconds.
  expect(target.selector[2]).toEqual({
    type: "FragmentSelector",
    conformsTo: MEDIA_FRAGS_SPEC,
    value: "t=2.868,8.838",
  });
  // Round-trips through the accessor back to ms.
  expect(audioFragmentRange(target)).toEqual({ startMs: 2868, endMs: 8838 });

  // Round-trips through the CRDT too.
  const s = await makeStore();
  s.addThread("n1", target, 100);
  s.addReply("n1", reply("r1", "pacing feels rushed", 110));
  expect(audioFragmentRange(s.snapshot()[0]!.target)).toEqual({
    startMs: 2868,
    endMs: 8838,
  });
});

test("open-ended audio range (final segment) omits the end", () => {
  const target = makeTextTarget({
    context: "narration",
    blocks: [{ id: "id:outro", hash: "h" }],
    startOffset: 0,
    endOffset: 3,
    quote: "Bye",
    audioRange: { startMs: 90000, endMs: null },
  });
  expect((target.selector[2] as { value: string }).value).toBe("t=90");
  expect(audioFragmentRange(target)).toEqual({ startMs: 90000, endMs: null });
});

test("non-narration / article targets have no Media Fragments selector", () => {
  expect(audioFragmentRange(ANCHOR_TEXT)).toBeNull();
  expect(ANCHOR_TEXT.selector.length).toBe(2);
  expect(audioFragmentRange(ANCHOR_GRAPHIC)).toBeNull();
});

test("reload from localStorage preserves the doc", async () => {
  // First store: write a few ops.
  const s1 = await makeStore();
  s1.addThread("t1", ANCHOR_TEXT, 100);
  s1.addReply("t1", reply("r1", "hello", 110));
  s1.addReply("t1", reply("r2", "world", 120));
  s1.resolveThread("t1", 999);

  // Don't clear storage — instantiate a second store at the same path.
  const s2 = await makeStore();
  expect(s2.snapshot()).toEqual(s1.snapshot());
});

test("doc is keyed by user id: different users see different docs", async () => {
  const sa = await makeStore("/posts/p", "google:user-a");
  sa.addThread("tA", ANCHOR_TEXT, 100);
  sa.addReply("tA", reply("rA", "from A", 110));

  const sb = await makeStore("/posts/p", "google:user-b");
  // Same post path, different user → independent docs.
  expect(sb.snapshot()).toEqual([]);
  expect(sa.snapshot().length).toBe(1);
});

test("doc persists across reloads for the same user", async () => {
  const s1 = await makeStore("/posts/p", "google:user-x");
  s1.addThread("t1", ANCHOR_TEXT, 100);
  s1.addReply("t1", reply("r1", "hello", 110));

  const s2 = await makeStore("/posts/p", "google:user-x");
  expect(s2.snapshot()).toEqual(s1.snapshot());
});

test("per-path isolation: comments on /posts/a don't bleed into /posts/b", async () => {
  const sa = await CommentStore.create("/posts/a", TEST_USER_ID);
  sa.addThread("t1", ANCHOR_TEXT, 100);
  sa.addReply("t1", reply("r1", "for a", 110));

  const sb = await CommentStore.create("/posts/b", TEST_USER_ID);
  expect(sb.snapshot()).toEqual([]);
  // And sa is unchanged
  expect(sa.snapshot().length).toBe(1);
});

// ---- CRDT merge semantics ---------------------------------------------
//
// These tests are the actual reason we picked a CRDT library. They
// verify what happens when two divergent docs are merged — i.e., what
// Phase 2's R2 sync flow will do whenever a client uploads on top of a
// remote that has changes the client hasn't seen.
//
// The pattern in each test:
//   1. Create a base doc.
//   2. "Fork" it by exporting bytes and loading into a second store.
//   3. Make different changes on each side.
//   4. Merge each side's bytes into the other and assert convergence.

async function forkStore(source: StoreT): Promise<StoreT> {
  // Use a different post path so the fork lives under a separate
  // localStorage key and doesn't trample the original's state.
  const forked = await CommentStore.create(`/posts/fork-${Math.random()}`, TEST_USER_ID);
  forked.mergeBytes(source.exportBytes());
  return forked;
}

test("concurrent thread adds: both survive after merge", async () => {
  const a = await CommentStore.create("/posts/p", TEST_USER_ID);
  const b = await forkStore(a);

  a.addThread("tA", ANCHOR_TEXT, 100);
  a.addReply("tA", reply("rA1", "from device A", 110));

  b.addThread("tB", ANCHOR_GRAPHIC, 200);
  b.addReply("tB", reply("rB1", "from device B", 210));

  // Cross-merge.
  a.mergeBytes(b.exportBytes());
  b.mergeBytes(a.exportBytes());

  // Both sides converge on the same state.
  const ids = (s: StoreT) => s.snapshot().map((t) => t.id).sort();
  expect(ids(a)).toEqual(["tA", "tB"]);
  expect(ids(b)).toEqual(["tA", "tB"]);
});

test("concurrent replies to the SAME thread: both survive", async () => {
  const a = await CommentStore.create("/posts/p", TEST_USER_ID);
  a.addThread("t1", ANCHOR_TEXT, 100);
  a.addReply("t1", reply("r0", "shared", 110));

  const b = await forkStore(a);

  // Each device adds its own reply to t1.
  a.addReply("t1", reply("rA", "A's reply", 200));
  b.addReply("t1", reply("rB", "B's reply", 210));

  a.mergeBytes(b.exportBytes());
  b.mergeBytes(a.exportBytes());

  const repliesA = a.snapshot()[0]!.replies.map((r) => r.id).sort();
  const repliesB = b.snapshot()[0]!.replies.map((r) => r.id).sort();
  expect(repliesA).toEqual(["r0", "rA", "rB"]);
  expect(repliesB).toEqual(["r0", "rA", "rB"]);
});

test("merge is idempotent: applying the same remote bytes twice is a no-op", async () => {
  const a = await CommentStore.create("/posts/p", TEST_USER_ID);
  a.addThread("t1", ANCHOR_TEXT, 100);
  a.addReply("t1", reply("r1", "hi", 110));

  const b = await forkStore(a);
  b.addThread("tB", ANCHOR_TEXT, 200);

  const beforeBytes = b.exportBytes();
  a.mergeBytes(beforeBytes);
  const onceMerged = JSON.stringify(a.snapshot());

  // Apply the same remote bytes again.
  a.mergeBytes(beforeBytes);
  const twiceMerged = JSON.stringify(a.snapshot());
  expect(twiceMerged).toBe(onceMerged);
});

test("merge is commutative: merge(a,b) and merge(b,a) reach the same state", async () => {
  // All four stores must start from the shared seed (which they do via
  // CommentStore.create when storage is empty) for the merge to be a
  // proper "merge of two forks of a common ancestor."
  const a = await CommentStore.create("/posts/a", TEST_USER_ID);
  const b = await CommentStore.create("/posts/b", TEST_USER_ID);
  a.addThread("tA", ANCHOR_TEXT, 100);
  b.addThread("tB", ANCHOR_TEXT, 200);

  const aBytes = a.exportBytes();
  const bBytes = b.exportBytes();

  const x = await CommentStore.create("/posts/x", TEST_USER_ID);
  x.mergeBytes(aBytes);
  x.mergeBytes(bBytes);

  const y = await CommentStore.create("/posts/y", TEST_USER_ID);
  y.mergeBytes(bBytes);
  y.mergeBytes(aBytes);

  expect(x.snapshot()).toEqual(y.snapshot());
});

// ---- Cross-actor / cross-blob scenarios -------------------------------
//
// These tests model two or more *separate users* — each with their own
// CommentStore, never having forked from each other — interacting via
// the aggregator path the blog author uses in production. They exist
// specifically to pin down architectural decisions that were previously
// gotten wrong (and not caught by the merge tests above, which all
// share a common ancestor via `forkStore`):
//
//   - Independently-created stores can merge without losing content.
//     The earlier bug here: each device called Automerge.from(...)
//     locally with different timestamps, producing different genesis
//     ops for the `threads` field; on merge, Automerge resolved the
//     conflict by picking one assignment and silently dropping the
//     loser's *entire* threads map. The fix: a hardcoded shared seed
//     so every device starts from the same bytes. Test #1 below pins
//     down the contract.
//
//   - The author can reply to a reader's thread without dropping the
//     reader's content. The earlier bug here: addReply materialized
//     the foreign thread into the author's own doc, which conflicted
//     with the reader's create on `threads[T]` → loser's whole
//     replies sub-map was dropped. The fix: flat replies map keyed by
//     replyId, so every add lands at a unique path that the CRDT can
//     merge for free. Test #2 below pins down the contract.

test("independently-created stores' threads both survive cross-merge (shared seed contract)", async () => {
  // Two stores created from scratch — they share NOTHING except the
  // hardcoded seed. This is the realistic production case for the
  // aggregator: two users on different devices, never having
  // interacted before. Without the shared seed, each side's "create
  // threads" op would conflict on merge and one side's threads would
  // silently vanish.
  const a = await CommentStore.create("/posts/p", "google:user-a");
  const b = await CommentStore.create("/posts/p", "google:user-b");

  a.addThread("tA", ANCHOR_TEXT, 100);
  a.addReply("tA", reply("rA1", "A's reply", 110));

  b.addThread("tB", ANCHOR_TEXT, 200);
  b.addReply("tB", reply("rB1", "B's reply", 210));

  // The author aggregates both readers' blobs via mergeOther (the
  // aggregator path), the same way the comments client does in prod.
  const author = await CommentStore.create("/posts/p", "google:author");
  author.mergeOther("google:user-a", a.exportBytes());
  author.mergeOther("google:user-b", b.exportBytes());

  const snap = author.snapshot();
  expect(snap.map((t) => t.id).sort()).toEqual(["tA", "tB"]);
  // Critically: BOTH threads survived, with their respective replies.
  const byId = new Map(snap.map((t) => [t.id, t]));
  expect(byId.get("tA")!.replies.map((r) => r.id)).toEqual(["rA1"]);
  expect(byId.get("tB")!.replies.map((r) => r.id)).toEqual(["rB1"]);
});

test("author can reply to a reader's foreign thread without dropping the reader's reply", async () => {
  // The bug-regression test. Previously, addReply materialized the
  // foreign thread in the author's doc — which collided with the
  // reader's create-thread op on merge, and the loser's whole replies
  // sub-map (which contained the reader's reply) was silently
  // dropped. With the flat schema, addReply just stores
  // d.replies[id] = { ...reply, threadId } in the author's blob,
  // which is a write at a brand-new key in a shared map (via seed) —
  // CRDT-mergeable for free, no conflict.
  const reader = await CommentStore.create("/posts/p", "google:reader");
  reader.addThread("t1", ANCHOR_TEXT, 100);
  reader.addReply("t1", reply("r-reader", "the reader's question", 110));

  const author = await CommentStore.create("/posts/p", "google:author");
  author.mergeOther("google:reader", reader.exportBytes());

  // Sanity: the foreign thread + its reply are visible to the author
  // before they reply (aggregator working).
  const before = author.snapshot();
  expect(before.length).toBe(1);
  expect(before[0]!.replies.map((r) => r.id)).toEqual(["r-reader"]);

  // Author replies to the foreign thread.
  author.addReply("t1", reply("r-author", "the author's reply", 200));

  // Both replies must appear in the author's view. Pre-fix this
  // assertion would fail with only one reply (the reader's having
  // been silently dropped by the CRDT merge).
  const after = author.snapshot();
  expect(after.length).toBe(1);
  expect(after[0]!.replies.map((r) => r.id).sort()).toEqual([
    "r-author",
    "r-reader",
  ]);
});

test("author replying to multiple foreign threads doesn't bleed content across them", async () => {
  // Two independent readers, each with their own thread + reply.
  // Author replies on both. Each thread should have exactly its
  // owner's reply plus the author's, with no cross-contamination
  // (no "the reply meant for thread A also appears on thread B").
  const readerA = await CommentStore.create("/posts/p", "google:readerA");
  readerA.addThread("tA", ANCHOR_TEXT, 100);
  readerA.addReply("tA", reply("rA-orig", "A's question", 110));

  const readerB = await CommentStore.create("/posts/p", "google:readerB");
  readerB.addThread("tB", ANCHOR_TEXT, 200);
  readerB.addReply("tB", reply("rB-orig", "B's question", 210));

  const author = await CommentStore.create("/posts/p", "google:author");
  author.mergeOther("google:readerA", readerA.exportBytes());
  author.mergeOther("google:readerB", readerB.exportBytes());

  author.addReply("tA", reply("rA-author", "reply to A", 300));
  author.addReply("tB", reply("rB-author", "reply to B", 310));

  const snap = author.snapshot();
  const byId = new Map(snap.map((t) => [t.id, t]));
  expect(byId.get("tA")!.replies.map((r) => r.id).sort()).toEqual([
    "rA-author",
    "rA-orig",
  ]);
  expect(byId.get("tB")!.replies.map((r) => r.id).sort()).toEqual([
    "rB-author",
    "rB-orig",
  ]);
});

test("author's foreign reply round-trips through their own blob (save/load)", async () => {
  // Simulates the realistic prod cycle: author replies, their blob is
  // PUT to R2, on the next page load their blob comes back via
  // hydrate + the reader's blob comes back via the aggregator. The
  // foreign reply must still be present and attached to the right
  // thread after the round-trip.
  const reader = await CommentStore.create("/posts/p", "google:reader");
  reader.addThread("t1", ANCHOR_TEXT, 100);
  reader.addReply("t1", reply("r-reader", "hi", 110));

  const author1 = await CommentStore.create("/posts/p", "google:author");
  author1.mergeOther("google:reader", reader.exportBytes());
  author1.addReply("t1", reply("r-author", "hi back", 200));

  const authorBlobBytes = author1.exportBytes();

  // Reload: new store, hydrate from saved bytes, re-aggregate reader.
  const author2 = await CommentStore.create(
    "/posts/p-reloaded",
    "google:author",
  );
  author2.mergeBytes(authorBlobBytes);
  author2.mergeOther("google:reader", reader.exportBytes());

  const snap = author2.snapshot();
  expect(snap.length).toBe(1);
  expect(snap[0]!.replies.map((r) => r.id).sort()).toEqual([
    "r-author",
    "r-reader",
  ]);
});

test("reader never sees the author's reply on their own thread (one-way visibility)", async () => {
  // Encodes the deliberate asymmetry: the author can see + reply on
  // readers' threads (aggregator), but the reader doesn't pull the
  // author's blob, so the author's reply never appears in their view.
  // This is the right semantics for our use case — the author follows
  // up by email, not via the comment thread.
  const reader = await CommentStore.create("/posts/p", "google:reader");
  reader.addThread("t1", ANCHOR_TEXT, 100);
  reader.addReply("t1", reply("r-reader", "hi", 110));

  const author = await CommentStore.create("/posts/p", "google:author");
  author.mergeOther("google:reader", reader.exportBytes());
  author.addReply("t1", reply("r-author", "private follow-up", 200));

  // Reader's view (their own blob, no aggregator) still shows only
  // their own reply. Nothing the author did leaked back.
  const readerSnap = reader.snapshot();
  expect(readerSnap.length).toBe(1);
  expect(readerSnap[0]!.replies.map((r) => r.id)).toEqual(["r-reader"]);
});

test("author on two devices both reply to the same foreign thread — both author replies survive", async () => {
  // Multi-device author case: author on device 1 replies, syncs to
  // R2; device 2 hydrates from that, re-aggregates the foreign
  // reader, and also replies; both replies + the reader's reply must
  // be visible on both devices after a full sync round.
  const reader = await CommentStore.create("/posts/p", "google:reader");
  reader.addThread("t1", ANCHOR_TEXT, 100);
  reader.addReply("t1", reply("r-reader", "question", 110));

  const author1 = await CommentStore.create("/posts/p", "google:author");
  author1.mergeOther("google:reader", reader.exportBytes());
  author1.addReply("t1", reply("r-author1", "from device 1", 200));

  // Device 2: fresh store path, hydrate from device 1's blob (the
  // cross-device sync), then re-aggregate the reader.
  const author2 = await CommentStore.create(
    "/posts/p-device2",
    "google:author",
  );
  author2.mergeBytes(author1.exportBytes());
  author2.mergeOther("google:reader", reader.exportBytes());
  author2.addReply("t1", reply("r-author2", "from device 2", 210));

  // Device 2 sees all three replies.
  const snap2 = author2.snapshot();
  expect(snap2.length).toBe(1);
  expect(snap2[0]!.replies.map((r) => r.id).sort()).toEqual([
    "r-author1",
    "r-author2",
    "r-reader",
  ]);

  // Sync back: device 1 picks up device 2's reply.
  author1.mergeBytes(author2.exportBytes());
  const snap1 = author1.snapshot();
  expect(snap1[0]!.replies.map((r) => r.id).sort()).toEqual([
    "r-author1",
    "r-author2",
    "r-reader",
  ]);
});

test("concurrent resolve doesn't double-stamp; deletedAt also stays put", async () => {
  // Two devices independently resolve the same thread / delete the
  // same reply. After merge, the timestamp shouldn't get clobbered —
  // both operations are idempotent (guarded inside the mutate fns).
  const a = await CommentStore.create("/posts/p", TEST_USER_ID);
  a.addThread("t1", ANCHOR_TEXT, 100);
  a.addReply("t1", reply("r1", "hi", 110));
  a.addReply("t1", reply("r2", "world", 120));
  const b = await forkStore(a);

  // A resolves at t=500; B resolves at t=600; A deletes r1 at t=700; B
  // deletes r1 at t=800.
  a.resolveThread("t1", 500);
  b.resolveThread("t1", 600);
  a.deleteReply("t1", "r1", 700);
  b.deleteReply("t1", "r1", 800);

  a.mergeBytes(b.exportBytes());
  b.mergeBytes(a.exportBytes());

  // Whichever timestamp won, both sides must agree. The guard inside
  // the mutate fn means each *local* device kept its own first write
  // (500 for A, 600 for B); Automerge then picks one deterministically
  // during merge. We don't care which one, only that they converge.
  const ta = a.snapshot()[0]!;
  const tb = b.snapshot()[0]!;
  expect(ta.resolvedAt).toBe(tb.resolvedAt!);
  const ra = ta.replies.find((r) => r.id === "r1")!;
  const rb = tb.replies.find((r) => r.id === "r1")!;
  expect(ra.deletedAt).toBe(rb.deletedAt!);
  expect(ta.resolvedAt).toBeDefined();
  expect(ra.deletedAt).toBeDefined();
});

// ---- Origin provenance (per-reply, both classes derived positively) ----

test("deriveOrigins: prod and local replies both attributed, incl. a local reply depending on prod changes", async () => {
  freshStorage();
  // One user's history: change 1 (tagged production) creates a thread +
  // first reply; later untagged changes add a scaffolding reply to the
  // SAME thread (its change depends on the prod changes — the dep trap
  // that forces local = fullReplay − prodReplay) plus a second thread.
  const src = await makeStore("/posts/p", "google:reader-1");
  src.addThread("tProd", ANCHOR_TEXT, 100);
  src.addReply("tProd", reply("rProd", "from prod", 110));
  const prodHashes = new Set(src.getAllLocalChanges().map((c) => c.hash));
  src.addReply("tProd", reply("rLocal", "context for the LLM", 120));
  src.addThread("tLocal", ANCHOR_TEXT, 130);
  src.addReply("tLocal", reply("rLocal2", "born here", 140));
  const all = src.getAllLocalChanges();
  const byHash = new Map(all.map((c) => [c.hash, c.bytes]));
  const entries = all.map((c) => ({
    hash: c.hash,
    ...(prodHashes.has(c.hash) && { origin: "production" }),
  }));

  const { deriveOrigins } = await import("./commentsStore.ts");
  const main = await makeStore("/posts/p", TEST_USER_ID);
  await deriveOrigins(entries, main, (h) => Promise.resolve(byHash.get(h) ?? null));

  expect(main.hasSeededOrigins()).toBe(true);
  expect(main.replyOrigin("rProd")).toBe("production");
  expect(main.replyOrigin("rLocal")).toBe("local");
  expect(main.replyOrigin("rLocal2")).toBe("local");
  // Underived ids are unknown — never silently "local".
  expect(main.replyOrigin("rNever")).toBeNull();
});

test("deriveOrigins on an untagged folder records local but never opens the render gate", async () => {
  freshStorage();
  const src = await makeStore("/posts/p", "google:reader-2");
  src.addThread("t1", ANCHOR_TEXT, 100);
  src.addReply("t1", reply("r1", "ordinary", 110));
  const all = src.getAllLocalChanges();
  const byHash = new Map(all.map((c) => [c.hash, c.bytes]));

  const { deriveOrigins } = await import("./commentsStore.ts");
  const main = await makeStore("/posts/p", TEST_USER_ID);
  await deriveOrigins(
    all.map((c) => ({ hash: c.hash })),
    main,
    (h) => Promise.resolve(byHash.get(h) ?? null),
  );

  // The class is derived (data, not absence)…
  expect(main.replyOrigin("r1")).toBe("local");
  // …but a single-origin view carries no information, so no tags render
  // (this is what keeps prod tag-free without an environment branch).
  expect(main.hasSeededOrigins()).toBe(false);
});
