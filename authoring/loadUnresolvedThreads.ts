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
import { fsAdapter } from "./fsAdapter.ts";
import { resolveBlogPaths } from "../shared/blogPaths.ts";
import { SEED_BYTES_B64 } from "../client/commentsStore.ts";
import type {
  Reply,
  Suggestion,
  Target,
  Thread,
} from "../client/commentsStore.ts";
import type {
  CommentOrigin,
  ThreadOrigins,
} from "./annotationExport.ts";

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
  suggestion?: Suggestion;
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
  // Engine-owned vendored asset — resolved via the engine's node_modules even
  // when this runs from a content repo consuming the engine as a dependency.
  const wasmPath = resolveBlogPaths().automergeWasm;
  const bytes = await Bun.file(wasmPath).arrayBuffer();
  await initializeWasm(new Uint8Array(bytes));
  wasmInited = true;
}

// ---------- Public API ----------

export type UnresolvedThread = {
  thread: Thread;
  /** Which reader's blob this thread came from. */
  ownerUserId: string;
  /**
   * Which live store the thread (and each of its replies) was born in,
   * derived from the per-blob `.src` provenance stamps the pulls write
   * (see authoring/r2Sync.ts → stampOrigin). A thread and its replies can
   * differ — e.g. a production-born thread carrying a localhost-born
   * author reply left as context for the LLM. `unknown` = pre-provenance
   * blobs not yet re-pulled.
   */
  origins: ThreadOrigins;
};

export type LoadOptions = {
  /**
   * Path the comments routes use to identify the post — has to match
   * what the client wrote with. In the dev store that's the absolute
   * URL path, e.g. `/posts/hash-functions`.
   */
  postPath: string;
  /**
   * Root of the on-disk authoring store (`generated/.comments-dev`)
   * — the fsAdapter layout shared by the offline tools. The dev
   * server itself writes to Miniflare R2 instead (createDevServer.ts);
   * `pull-comments` mirrors into this directory.
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

  // Native TC39 `Uint8Array.fromBase64()` (Bun) — replaces a hand-rolled
  // atob+charCode loop that was copy-pasted from client/commentsStore.ts.
  const seedBytes = Uint8Array.fromBase64(SEED_BYTES_B64);

  function replay(changes: Uint8Array[]): Automerge.Doc<CommentDoc> {
    let doc = Automerge.load<CommentDoc>(seedBytes);
    if (changes.length > 0) {
      [doc] = Automerge.applyChanges(doc, changes);
    }
    return doc;
  }

  function memberIds(doc: Automerge.Doc<CommentDoc>): {
    threads: Set<string>;
    replies: Set<string>;
  } {
    const js = Automerge.toJS(doc) as CommentDoc;
    return {
      threads: new Set(Object.keys(js.threads)),
      replies: new Set(Object.keys(js.replies)),
    };
  }

  // Per-user merged docs. We keep them separate so we know which
  // user "owns" each thread (for the CLI summary + future R2 follow-
  // up needs). Merging them into one doc would lose that.
  const userIds = await store.listUsers(opts.postPath);
  type PerUserDoc = { userId: string; doc: Automerge.Doc<CommentDoc> };
  const perUser: PerUserDoc[] = [];

  // Thread/reply → origin, attributed by SUBSET REPLAY rather than by
  // decoding CRDT internals: blobs are Automerge changes (one blob can
  // carry ops for several threads/replies), so per-item origin is derived
  // by replaying each user's production-stamped blobs alone, then
  // production+unknown, then all — an item first appearing when the
  // localhost blobs are added was born on localhost. The subsets are
  // dep-closed where it matters: a production-born change can never
  // depend on a localhost-born one (no upward path puts localhost
  // changes in front of a prod writer), so the production replay never
  // drops items to missing deps. `production` wins on (defensive,
  // shouldn't-happen) cross-user collisions.
  const threadOriginById = new Map<string, CommentOrigin>();
  const replyOriginById = new Map<string, CommentOrigin>();
  function recordOrigin(
    into: Map<string, CommentOrigin>,
    id: string,
    origin: CommentOrigin,
  ): void {
    const prev = into.get(id);
    if (prev === undefined || origin === "production") into.set(id, origin);
  }

  for (const userId of userIds) {
    const entries = await store.listChanges(opts.postPath, userId);

    const byOrigin: Record<CommentOrigin, Uint8Array[]> = {
      production: [],
      localhost: [],
      unknown: [],
    };
    for (const entry of entries) {
      const bytes = await store.getChange(opts.postPath, userId, entry.hash);
      // A missing entry mid-listing means LIST and GET disagreed
      // (concurrent delete from another process, or a flaky fs).
      // Skip — applyChanges would have silently dropped any orphaned
      // descendants anyway, so we lose nothing by ignoring.
      if (!bytes) continue;
      // The fsAdapter reads the `.src` provenance sidecars the pulls write;
      // an unstamped blob (pre-provenance data) is "unknown".
      byOrigin[entry.origin ?? "unknown"].push(bytes);
    }

    const full = replay([
      ...byOrigin.production,
      ...byOrigin.unknown,
      ...byOrigin.localhost,
    ]);
    perUser.push({ userId, doc: full });

    const inProd = memberIds(replay(byOrigin.production));
    const inProdUnknown = memberIds(
      replay([...byOrigin.production, ...byOrigin.unknown]),
    );
    const inAll = memberIds(full);
    const originOf = (id: string, kind: "threads" | "replies"): CommentOrigin =>
      inProd[kind].has(id)
        ? "production"
        : inProdUnknown[kind].has(id)
          ? "unknown"
          : "localhost";
    for (const id of inAll.threads) {
      recordOrigin(threadOriginById, id, originOf(id, "threads"));
    }
    for (const id of inAll.replies) {
      recordOrigin(replyOriginById, id, originOf(id, "replies"));
    }
  }

  // Author-side resolutions: opaque JSON envelopes, one file per
  // resolved threadId. We only need the set of threadIds — the
  // envelope body is for the UI's "Resolved by …" tag and we don't
  // surface that here.
  const resolutionEntries = await store.listResolutions(opts.postPath);
  const authorResolved = new Set(resolutionEntries.map((e) => e.threadId));

  // Cross-merge every reader's blob before assembling threads. A thread
  // object lives only in its *creator's* doc, but replies to it can come
  // from anyone — most importantly the post author replying to a reader's
  // thread. So we bucket replies by threadId across ALL docs first, then
  // attach them to whichever doc owns the thread. Bucketing per-doc (the
  // old approach) silently dropped any reply whose parent thread was
  // created in a *different* blob — i.e. every author-on-reader reply —
  // even though the in-browser author aggregator already merges across
  // users. Strips the internal `threadId` so the emitted shape matches
  // the public `Reply`.
  //
  // Docs are disjoint (each is loaded only from its own user's changes,
  // all off the same shared seed), so a given reply id appears in exactly
  // one doc; `seenReplyIds` is belt-and-suspenders against a malformed
  // store double-counting.
  const repliesByThread = new Map<string, Reply[]>();
  const seenReplyIds = new Set<string>();
  const threadsById = new Map<
    string,
    { thread: StoredThread; ownerUserId: string }
  >();

  for (const { userId, doc } of perUser) {
    const js = Automerge.toJS(doc) as CommentDoc;

    for (const [replyId, stored] of Object.entries(js.replies)) {
      if (seenReplyIds.has(replyId)) continue;
      seenReplyIds.add(replyId);
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
      // A thread is owned by exactly one doc (its creator); first writer
      // wins if a malformed store somehow surfaces the id twice.
      if (!threadsById.has(id)) {
        threadsById.set(id, { thread: t, ownerUserId: userId });
      }
    }
  }

  let totalCount = 0;
  let resolvedCount = 0;
  const unresolved: UnresolvedThread[] = [];
  const all: UnresolvedThread[] = [];

  for (const [id, { thread: t, ownerUserId }] of threadsById) {
    totalCount++;

    const replies = (repliesByThread.get(id) ?? [])
      .filter((r) => r.deletedAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt);

    const isResolvedByOwner = t.resolvedAt !== undefined;
    const isResolvedByAuthor = authorResolved.has(id);
    // A thread with zero live replies has nothing to say. Self-resolve
    // already collapses to this on the client (the last reply delete
    // auto-resolves the thread), but a malformed blob could still
    // produce one — skip it defensively. EXCEPT a suggestion: its diff
    // (original → proposed) is its content, so a note-less suggestion
    // still needs the author's attention (mirrors the export guard).
    const hasNothingToSay = replies.length === 0 && t.suggestion === undefined;

    if (hasNothingToSay) {
      resolvedCount++;
      continue;
    }

    const entry: UnresolvedThread = {
      ownerUserId,
      thread: {
        id,
        target: t.target,
        replies,
        createdAt: t.createdAt,
        ...(t.resolvedAt !== undefined && { resolvedAt: t.resolvedAt }),
        ...(t.suggestion !== undefined && { suggestion: t.suggestion }),
      },
      origins: {
        thread: threadOriginById.get(id) ?? "unknown",
        replies: Object.fromEntries(
          replies.map((r) => [r.id, replyOriginById.get(r.id) ?? "unknown"]),
        ),
      },
    };
    all.push(entry);

    if (isResolvedByOwner || isResolvedByAuthor) {
      resolvedCount++;
      continue;
    }

    unresolved.push(entry);
  }

  // Stable order: oldest threads first. Lines up with the in-browser
  // render order and makes Claude's pass deterministic across re-runs
  // when nothing has changed.
  unresolved.sort((a, b) => a.thread.createdAt - b.thread.createdAt);
  all.sort((a, b) => a.thread.createdAt - b.thread.createdAt);

  return { unresolved, all, resolvedCount, totalCount };
}
