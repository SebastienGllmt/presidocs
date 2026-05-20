// Aggregate every reader's comment threads for one post, then filter
// to threads that still need the author's attention — anything not
// self-resolved and not author-resolved, with at least one live reply.
//
// Mirrors what the in-browser author aggregator does (`commentsSync` +
// `commentsAggregator.ts` + `ResolutionStore`) but offline: it reads
// the dev fsAdapter at `generated/.comments-dev/` directly, replays
// each user's `.bin` change-objects against the shared Automerge seed,
// merges them, and filters out resolved threads.
//
// Why we don't just import the browser CommentStore: the snapshot path
// there is structured around localStorage + WASM-init-from-URL. Here
// we're in Bun with neither, and we only need the read side — a
// throwaway merge pass is simpler than wiring the browser store into
// Node land.

import { initializeWasm, isWasmInitialized } from "@automerge/automerge/slim";
import * as Automerge from "@automerge/automerge/slim";
import { join } from "node:path";
import { fsAdapter } from "../server/comments/fsAdapter.ts";
import { SEED_BYTES_B64 } from "../client/commentsStore.ts";
import type {
  Reply,
  Target,
  Thread,
} from "../client/commentsStore.ts";

// ---------- Types mirrored from client/commentsStore.ts ----------
//
// We duplicate the CRDT-internal shape here (the `threads`/`replies`
// flat-maps with their stored variants) rather than importing them,
// because the client module marks them as `type` (compile-time) only
// — there's nothing to import at runtime. Keep these in sync with
// commentsStore.ts; a mismatch would silently produce nothing, since
// Automerge.applyChanges drops changes whose schema doesn't match.

type StoredThread = {
  target: Target;
  createdAt: number;
  resolvedAt?: number;
};

type StoredReply = Reply & { threadId: string };

type CommentDoc = {
  threads: { [id: string]: StoredThread };
  replies: { [replyId: string]: StoredReply };
};

// ---------- WASM init ----------
//
// Bun can read the .wasm directly off disk; no URL fetch needed.
// `commentsStore.ts` would normally hit `/assets/automerge.wasm`,
// but we're not in a browser, so feed Automerge the raw bytes.
let wasmInited = false;
async function ensureWasm(): Promise<void> {
  if (wasmInited || isWasmInitialized()) {
    wasmInited = true;
    return;
  }
  const wasmPath = join(
    import.meta.dir,
    "..",
    "node_modules",
    "@automerge",
    "automerge",
    "dist",
    "automerge.wasm",
  );
  const bytes = await Bun.file(wasmPath).arrayBuffer();
  await initializeWasm(new Uint8Array(bytes));
  wasmInited = true;
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- Public API ----------

export type UnresolvedThread = {
  thread: Thread;
  /** Which reader's blob this thread came from. */
  ownerUserId: string;
};

export type LoadOptions = {
  /**
   * Path the comments routes use to identify the post — has to match
   * what the client wrote with. In the dev store that's the absolute
   * URL path, e.g. `/posts/hash-functions`.
   */
  postPath: string;
  /**
   * Directory passed to the fsAdapter when the dev server set it up
   * — same string `index.ts` uses
   * (`generated/.comments-dev`).
   */
  commentsDir: string;
};

export type LoadResult = {
  unresolved: UnresolvedThread[];
  /**
   * Every thread with at least one live reply, *including* resolved
   * ones — the superset of `unresolved`. Used by the Web Annotation
   * export, which wants the full picture (resolved annotations carry
   * an `x-blog:resolvedAt`), not just the author's attention queue.
   */
  all: UnresolvedThread[];
  /**
   * Threads we found but filtered out. Useful for the CLI summary —
   * "12 threads total, 7 already resolved" reads better than just "5
   * unresolved" with no denominator.
   */
  resolvedCount: number;
  totalCount: number;
};

/**
 * Loads + merges every user's comment blobs for `postPath`, applies
 * the per-post resolutions index, and returns the threads that still
 * have unresolved replies needing the author's attention.
 */
export async function loadUnresolvedThreads(
  opts: LoadOptions,
): Promise<LoadResult> {
  await ensureWasm();
  const store = fsAdapter(opts.commentsDir);

  const seedBytes = base64ToBytes(SEED_BYTES_B64);

  // Per-user merged docs. We keep them separate so we know which
  // user "owns" each thread (for the CLI summary + future R2 follow-
  // up needs). Merging them into one doc would lose that.
  const userIds = await store.listUsers(opts.postPath);
  type PerUserDoc = { userId: string; doc: Automerge.Doc<CommentDoc> };
  const perUser: PerUserDoc[] = [];

  for (const userId of userIds) {
    let doc = Automerge.load<CommentDoc>(seedBytes);
    const entries = await store.listChanges(opts.postPath, userId);

    const changeBytes: Uint8Array[] = [];
    for (const entry of entries) {
      const bytes = await store.getChange(opts.postPath, userId, entry.hash);
      // A missing entry mid-listing means LIST and GET disagreed
      // (concurrent delete from another process, or a flaky fs).
      // Skip — applyChanges would have silently dropped any orphaned
      // descendants anyway, so we lose nothing by ignoring.
      if (bytes) changeBytes.push(bytes);
    }

    if (changeBytes.length > 0) {
      [doc] = Automerge.applyChanges(doc, changeBytes);
    }
    perUser.push({ userId, doc });
  }

  // Author-side resolutions: opaque JSON envelopes, one file per
  // resolved threadId. We only need the set of threadIds — the
  // envelope body is for the UI's "Resolved by …" tag and we don't
  // surface that here.
  const resolutionEntries = await store.listResolutions(opts.postPath);
  const authorResolved = new Set(resolutionEntries.map((e) => e.threadId));

  let totalCount = 0;
  let resolvedCount = 0;
  const unresolved: UnresolvedThread[] = [];
  const all: UnresolvedThread[] = [];

  for (const { userId, doc } of perUser) {
    const js = Automerge.toJS(doc) as CommentDoc;

    // Bucket replies under their parent thread up-front so the per-
    // thread assembly below is O(1). Strips the internal `threadId`
    // back out so the emitted shape matches the public `Reply`.
    const repliesByThread = new Map<string, Reply[]>();
    for (const stored of Object.values(js.replies)) {
      const { threadId, ...reply } = stored;
      const arr = repliesByThread.get(threadId);
      if (arr) arr.push(reply);
      else repliesByThread.set(threadId, [reply]);
    }

    for (const [id, t] of Object.entries(js.threads)) {
      // Skip pre-Web-Annotation blobs (old `anchor` shape, no `target`).
      // The seed is unchanged so these still apply to the doc, but they
      // predate the migration and carry no usable anchor — drop them
      // rather than crash. See client/commentsStore.ts snapshot().
      if (!t.target) continue;
      totalCount++;

      const replies = (repliesByThread.get(id) ?? [])
        .filter((r) => r.deletedAt === undefined)
        .sort((a, b) => a.createdAt - b.createdAt);

      const isResolvedByOwner = t.resolvedAt !== undefined;
      const isResolvedByAuthor = authorResolved.has(id);
      // A thread with zero live replies has nothing to say. Self-
      // resolve already collapses to this on the client (the last
      // reply delete auto-resolves the thread), but a malformed blob
      // could still produce one — skip it defensively.
      const hasNothingToSay = replies.length === 0;

      if (hasNothingToSay) {
        resolvedCount++;
        continue;
      }

      const entry: UnresolvedThread = {
        ownerUserId: userId,
        thread: {
          id,
          target: t.target,
          replies,
          createdAt: t.createdAt,
          ...(t.resolvedAt !== undefined && { resolvedAt: t.resolvedAt }),
        },
      };
      all.push(entry);

      if (isResolvedByOwner || isResolvedByAuthor) {
        resolvedCount++;
        continue;
      }

      unresolved.push(entry);
    }
  }

  // Stable order: oldest threads first. Lines up with the in-browser
  // render order and makes Claude's pass deterministic across re-runs
  // when nothing has changed.
  unresolved.sort((a, b) => a.thread.createdAt - b.thread.createdAt);
  all.sort((a, b) => a.thread.createdAt - b.thread.createdAt);

  return { unresolved, all, resolvedCount, totalCount };
}
