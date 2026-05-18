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
(globalThis as unknown as { localStorage: Storage }).localStorage =
  localStorageShim;

// ---- Now import the store (after shim is in place) ---------------------

const {
  CommentStore,
  isResolved,
  isDeleted,
  visibleReplies,
  setCommentsWasmSource,
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

const ANCHOR_TEXT = {
  kind: "text" as const,
  context: "article" as const,
  segments: [{ id: "id:foo", hash: "hash-of-foo" }],
  startOffset: 0,
  endOffset: 10,
  quote: "Hello world",
};

const ANCHOR_GRAPHIC = {
  kind: "graphic" as const,
  context: "article" as const,
  id: "id:diagram",
};

function reply(id: string, body: string, createdAt: number) {
  return { id, body, createdAt };
}

async function makeStore(path = "/posts/hash-functions"): Promise<StoreT> {
  return await CommentStore.create(path);
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
  expect(snap[0]!.anchor).toEqual(ANCHOR_TEXT);
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
  expect(t.anchor.kind).toBe("graphic");
  expect((t.anchor as typeof ANCHOR_GRAPHIC).id).toBe("id:diagram");
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

test("reader UUID persists across store instantiations", async () => {
  // First create: generates a UUID.
  await makeStore();
  const firstId = localStorageShim.getItem("blog-reader-id");
  expect(firstId).toBeTruthy();

  // Second create: must reuse the same UUID. (Otherwise the second
  // instance would write to a different blob key, and the user's
  // previous comments would look "missing" until they reload.)
  await makeStore();
  const secondId = localStorageShim.getItem("blog-reader-id");
  expect(secondId).toBe(firstId);
});

test("v1 JSON migration: legacy key is replayed and cleared", async () => {
  // Pre-populate the legacy v1 store at the un-reader-scoped key.
  const legacyThreads = [
    {
      id: "t1",
      anchor: ANCHOR_TEXT,
      replies: [
        reply("r1", "old comment", 100),
        { ...reply("r2", "deleted comment", 110), deletedAt: 200 },
      ],
      createdAt: 100,
      resolvedAt: undefined,
    },
    {
      id: "t2",
      anchor: ANCHOR_GRAPHIC,
      replies: [reply("r3", "on the diagram", 120)],
      createdAt: 120,
      resolvedAt: 999, // pre-resolved
    },
  ];
  localStorageShim.setItem(
    "blog-comments:/posts/hash-functions",
    JSON.stringify(legacyThreads),
  );

  const s = await makeStore();
  const snap = s.snapshot();
  expect(snap.length).toBe(2);

  const t1 = snap.find((t) => t.id === "t1")!;
  const t2 = snap.find((t) => t.id === "t2")!;
  expect(t1.replies.length).toBe(2); // tombstoned reply preserved
  expect(isDeleted(t1.replies.find((r) => r.id === "r2")!)).toBe(true);
  expect(t2.resolvedAt).toBe(999);

  // Legacy key is gone.
  expect(localStorageShim.getItem("blog-comments:/posts/hash-functions"))
    .toBeNull();
  // New key exists.
  const readerId = localStorageShim.getItem("blog-reader-id")!;
  expect(
    localStorageShim.getItem(
      `blog-comments:/posts/hash-functions:${readerId}.amrg`,
    ),
  ).toBeTruthy();
});

test("v1 migration is one-shot — second load doesn't re-migrate", async () => {
  localStorageShim.setItem(
    "blog-comments:/posts/hash-functions",
    JSON.stringify([
      { id: "t1", anchor: ANCHOR_TEXT, replies: [reply("r1", "a", 100)], createdAt: 100 },
    ]),
  );

  const s1 = await makeStore();
  const after1 = s1.snapshot();

  // The legacy key should be gone — even if someone repopulates it,
  // the store has the new key now and won't migrate again.
  localStorageShim.setItem(
    "blog-comments:/posts/hash-functions",
    JSON.stringify([
      { id: "tInjected", anchor: ANCHOR_TEXT, replies: [reply("rX", "x", 1)], createdAt: 1 },
    ]),
  );

  const s2 = await makeStore();
  const after2 = s2.snapshot();
  // s2 must show s1's state, not the re-injected legacy data.
  expect(after2.map((t) => t.id)).toEqual(after1.map((t) => t.id));
});

test("corrupt v1 JSON doesn't crash — fresh empty doc is used", async () => {
  localStorageShim.setItem(
    "blog-comments:/posts/hash-functions",
    "not valid json{{{",
  );
  // The store logs the parse failure via console.warn; suppress just
  // for this assertion so test output stays clean.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const s = await makeStore();
    expect(s.snapshot()).toEqual([]);
  } finally {
    console.warn = origWarn;
  }
});

test("per-path isolation: comments on /posts/a don't bleed into /posts/b", async () => {
  const sa = await CommentStore.create("/posts/a");
  sa.addThread("t1", ANCHOR_TEXT, 100);
  sa.addReply("t1", reply("r1", "for a", 110));

  const sb = await CommentStore.create("/posts/b");
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
  const forked = await CommentStore.create(`/posts/fork-${Math.random()}`);
  forked.mergeBytes(source.exportBytes());
  return forked;
}

test("concurrent thread adds: both survive after merge", async () => {
  const a = await CommentStore.create("/posts/p");
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
  const a = await CommentStore.create("/posts/p");
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
  const a = await CommentStore.create("/posts/p");
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
  const a = await CommentStore.create("/posts/a");
  const b = await CommentStore.create("/posts/b");
  a.addThread("tA", ANCHOR_TEXT, 100);
  b.addThread("tB", ANCHOR_TEXT, 200);

  const aBytes = a.exportBytes();
  const bBytes = b.exportBytes();

  const x = await CommentStore.create("/posts/x");
  x.mergeBytes(aBytes);
  x.mergeBytes(bBytes);

  const y = await CommentStore.create("/posts/y");
  y.mergeBytes(bBytes);
  y.mergeBytes(aBytes);

  expect(x.snapshot()).toEqual(y.snapshot());
});

test("concurrent resolve doesn't double-stamp; deletedAt also stays put", async () => {
  // Two devices independently resolve the same thread / delete the
  // same reply. After merge, the timestamp shouldn't get clobbered —
  // both operations are idempotent (guarded inside the mutate fns).
  const a = await CommentStore.create("/posts/p");
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
