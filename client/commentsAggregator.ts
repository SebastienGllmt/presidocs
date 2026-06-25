// Author-only aggregator. For each non-self user with content under this
// post: LIST their change hashes, GET any the store doesn't already have,
// and apply via `store.applyOtherChanges` — which persists the merged
// foreign doc to localStorage. The store is the single source of truth for
// "what we already have", so a reload re-LISTs each user but re-GETs
// nothing, and the author's boot renders everyone's comments (and the
// correct unresolved count) from the persisted aggregate before this even
// runs. The first session on a device still pays the full GET fan-out once.
//
// Not real-time: a reader's new comments surface on the next poll / load.
// A push-based refresh would slot in here without touching the store or the
// per-user sync loop; deferred to v2.

import type { CommentStore } from "./commentsStore.ts";
import { getChange, listChanges, listUsers } from "./commentsApi.ts";

export async function aggregateOtherReaders(
  store: CommentStore,
  postPath: string,
  ownUserId: string,
): Promise<void> {
  let users: string[];
  try {
    users = await listUsers(postPath);
  } catch (err) {
    console.warn("aggregate (listUsers) failed:", err);
    return;
  }
  await Promise.all(
    users
      .filter((u) => u !== ownUserId)
      .map(async (userId) => {
        try {
          await pullUser(store, postPath, userId);
        } catch (err) {
          console.warn(`aggregate: failed to pull user ${userId}:`, err);
        }
      }),
  );
}

async function pullUser(
  store: CommentStore,
  postPath: string,
  userId: string,
): Promise<void> {
  const remote = await listChanges(postPath, userId);
  const known = store.foreignChangeHashes(userId);
  const toFetch = remote.map((e) => e.hash).filter((h) => !known.has(h));
  if (toFetch.length > 0) {
    const fetched = await Promise.all(
      toFetch.map((h) => getChange(postPath, userId, h)),
    );
    store.applyOtherChanges(
      userId,
      fetched.filter((b): b is Uint8Array => b !== null),
    );
  }

  // Origin provenance (dev-only debug tags). Derived from bytes the store
  // already holds — no re-fetch — and memoized per user, so this is free on
  // a zero-delta poll and a no-op anywhere blobs carry no origin tags
  // (prod). Runs even when nothing was fetched: the origin sets are
  // in-memory only, so a reload that re-hydrated the doc from localStorage
  // still needs them repopulated. A failure must never break the aggregate.
  try {
    await store.deriveOrigins(remote, userId);
  } catch (err) {
    console.warn(`aggregate origin derivation failed for ${userId}:`, err);
  }
}
