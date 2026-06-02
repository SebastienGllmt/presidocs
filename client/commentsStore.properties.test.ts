// Property-based tests for the CRDT merge contract, complementing the
// example-based tests in `commentsStore.test.ts`. Those pin down specific
// hand-written merge scenarios; these assert the algebraic laws directly —
// commutativity, associativity, idempotence, and no-content-loss — over
// randomly generated operation sequences, so the suite catches the *class*
// of bug the examples can only catch one instance of (e.g. the historical
// content-loss bugs documented in commentsStore.test.ts).
//
// Harness (localStorage shim + WASM wiring) mirrors commentsStore.test.ts.

import { test, expect, beforeEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as fc from "fast-check";

// ---- Storage shim (same Object.defineProperty pattern as the example
// test, so it coexists with happy-dom's non-writable localStorage) -------
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

// ---- Import the store after the shim is installed ----------------------
const { CommentStore, setCommentsWasmSource, makeTextTarget } = await import(
  "./commentsStore.ts"
);
{
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@automerge/automerge/automerge.wasm");
  setCommentsWasmSource(new Uint8Array(await readFile(wasmPath)));
}
type StoreT = Awaited<ReturnType<typeof CommentStore.create>>;

// A single anchor target is enough — these laws are about thread/reply
// identity and merge convergence, not about anchor content.
const TARGET = makeTextTarget({
  context: "article",
  blocks: [{ id: "id:foo", hash: "hash-of-foo" }],
  startOffset: 0,
  endOffset: 5,
  quote: "Hello",
});

// ---- Operation model ---------------------------------------------------
// One op = one mutation against a store. Ids are drawn from a *tiny shared
// pool* (not uuids) on purpose: two independently-generated sequences then
// routinely touch the same thread/reply, so a merge exercises real CRDT
// conflict resolution (concurrent resolve, concurrent delete, add-reply-to-
// same-thread) instead of a trivial disjoint union.
type Op =
  | { kind: "addThread"; id: string; at: number }
  | { kind: "addReply"; threadId: string; replyId: string; body: string; at: number }
  | { kind: "resolveThread"; id: string; at: number }
  | { kind: "deleteReply"; threadId: string; replyId: string; at: number };

const threadId = fc.constantFrom("t1", "t2", "t3");
const replyId = fc.constantFrom("r1", "r2", "r3", "r4");
const ts = fc.integer({ min: 0, max: 1000 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("addThread" as const), id: threadId, at: ts }),
  fc.record({
    kind: fc.constant("addReply" as const),
    threadId,
    replyId,
    body: fc.string({ maxLength: 40 }),
    at: ts,
  }),
  fc.record({ kind: fc.constant("resolveThread" as const), id: threadId, at: ts }),
  fc.record({ kind: fc.constant("deleteReply" as const), threadId, replyId, at: ts }),
);

const opsArb = fc.array(opArb, { maxLength: 8 });

function apply(store: StoreT, ops: readonly Op[], userId: string): void {
  for (const op of ops) {
    switch (op.kind) {
      case "addThread":
        store.addThread(op.id, TARGET, op.at);
        break;
      case "addReply":
        store.addReply(op.threadId, {
          id: op.replyId,
          body: op.body,
          createdAt: op.at,
          authorId: userId,
          authorName: userId,
          authorEmail: `${userId}@example.com`,
        });
        break;
      case "resolveThread":
        store.resolveThread(op.id, op.at);
        break;
      case "deleteReply":
        store.deleteReply(op.threadId, op.replyId, op.at);
        break;
    }
  }
}

// Each generated store gets a unique post path ⇒ its own localStorage key,
// while sharing the seed (empty storage at create() ⇒ a fork of the common
// ancestor), exactly as the example commutativity test does.
let storeSeq = 0;
const freshStore = (userId: string): Promise<StoreT> =>
  CommentStore.create(`/posts/prop-${storeSeq++}`, userId);

// The mergeBytes laws are same-owner / multi-device: one logical user,
// several forks of the seed (mirrors "merge is commutative" in the example
// test, which uses one TEST_USER_ID across distinct paths).
const OWNER = "google:prop-owner";

beforeEach(() => {
  storage.clear();
});

test("property: merge is commutative for any two op sequences", async () => {
  await fc.assert(
    fc.asyncProperty(opsArb, opsArb, async (opsA, opsB) => {
      storage.clear();
      const a = await freshStore(OWNER);
      apply(a, opsA, OWNER);
      const b = await freshStore(OWNER);
      apply(b, opsB, OWNER);

      const x = await freshStore(OWNER);
      x.mergeBytes(a.exportBytes());
      x.mergeBytes(b.exportBytes());

      const y = await freshStore(OWNER);
      y.mergeBytes(b.exportBytes());
      y.mergeBytes(a.exportBytes());

      expect(x.snapshot()).toEqual(y.snapshot());
    }),
    { numRuns: 50 },
  );
});

test("property: merge is associative for any three op sequences", async () => {
  await fc.assert(
    fc.asyncProperty(opsArb, opsArb, opsArb, async (oA, oB, oC) => {
      storage.clear();
      const a = await freshStore(OWNER);
      apply(a, oA, OWNER);
      const b = await freshStore(OWNER);
      apply(b, oB, OWNER);
      const c = await freshStore(OWNER);
      apply(c, oC, OWNER);

      // (a ∘ b) ∘ c
      const left = await freshStore(OWNER);
      left.mergeBytes(a.exportBytes());
      left.mergeBytes(b.exportBytes());
      left.mergeBytes(c.exportBytes());

      // a ∘ (b ∘ c)
      const bc = await freshStore(OWNER);
      bc.mergeBytes(b.exportBytes());
      bc.mergeBytes(c.exportBytes());
      const right = await freshStore(OWNER);
      right.mergeBytes(a.exportBytes());
      right.mergeBytes(bc.exportBytes());

      expect(left.snapshot()).toEqual(right.snapshot());
    }),
    { numRuns: 50 },
  );
});

test("property: merge is idempotent — re-applying the same bytes is a no-op", async () => {
  await fc.assert(
    fc.asyncProperty(opsArb, async (ops) => {
      storage.clear();
      const a = await freshStore(OWNER);
      apply(a, ops, OWNER);
      const bytes = a.exportBytes();

      const x = await freshStore(OWNER);
      x.mergeBytes(bytes);
      const once = x.snapshot();
      x.mergeBytes(bytes);
      expect(x.snapshot()).toEqual(once);
    }),
    { numRuns: 50 },
  );
});

// For the cross-reader aggregation test, reply ids are unique (fc.uuid),
// matching production where every reply id is a fresh uuid. Thread ids stay
// shared so the realistic "two readers reply to the same thread" case is
// exercised — but two readers must NOT independently mint the same reply id,
// because replies are keyed globally by id: a shared reply id across readers
// would carry two different parent threads and last-writer-wins could land
// it on a non-visible thread (an artifact of the test's id pool, not loss).
const lossOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("addThread" as const), id: threadId, at: ts }),
  fc.record({
    kind: fc.constant("addReply" as const),
    threadId,
    replyId: fc.uuid(),
    body: fc.string({ maxLength: 40 }),
    at: ts,
  }),
  fc.record({ kind: fc.constant("resolveThread" as const), id: threadId, at: ts }),
  fc.record({ kind: fc.constant("deleteReply" as const), threadId, replyId: fc.uuid(), at: ts }),
);
const lossOpsArb = fc.array(lossOpArb, { maxLength: 8 });

test("property: no content loss — every added thread/reply survives aggregation", async () => {
  await fc.assert(
    fc.asyncProperty(lossOpsArb, lossOpsArb, async (opsA, opsB) => {
      storage.clear();
      // Two distinct readers (the aggregator path uses mergeOther, keyed by
      // a per-reader userId — same shape as the example cross-actor tests).
      const userA = "google:reader-a";
      const userB = "google:reader-b";
      const a = await freshStore(userA);
      apply(a, opsA, userA);
      const b = await freshStore(userB);
      apply(b, opsB, userB);

      const author = await freshStore("google:author");
      author.mergeOther(userA, a.exportBytes());
      author.mergeOther(userB, b.exportBytes());
      const snap = author.snapshot();

      const presentThreads = new Set(snap.map((t) => t.id));
      const visibleReplyIds = new Set(
        snap.flatMap((t) => t.replies.map((r) => r.id)),
      );

      // Every thread either reader created must be visible.
      for (const op of [...opsA, ...opsB]) {
        if (op.kind === "addThread") {
          expect(presentThreads.has(op.id)).toBe(true);
        }
      }
      // Every added reply must be visible *if its thread is visible*. A
      // reply on a thread nobody created stays latent in the flat replies
      // map and legitimately doesn't surface — that's documented snapshot()
      // behaviour, not loss. Deleted replies are tombstoned, so they still
      // count as present (this checks ids, not visibility flags).
      for (const op of [...opsA, ...opsB]) {
        if (op.kind === "addReply" && presentThreads.has(op.threadId)) {
          expect(visibleReplyIds.has(op.replyId)).toBe(true);
        }
      }
    }),
    { numRuns: 50 },
  );
});
