// Author-only aggregator. For each non-self user with content under
// this post: LIST their change hashes, GET any we don't already have
// cached locally, and apply via `store.applyOtherChanges`. Pure
// set-diff — zero-delta page loads cost just one LIST per user.
//
// Not real-time: readers' new comments only show up on the next page
// load. A polling refresh would slot in here without touching the
// store or the per-user sync loop; deferred to v2.

import type { CommentStore } from "./commentsStore.ts";
import { getChange, listChanges, listUsers } from "./commentsApi.ts";

// Per-author cache of which change hashes we've already pulled for
// each foreign user. Persists for the page lifetime only — survives
// re-renders but not reloads. On reload we re-LIST each user (which
// is fine; zero-delta LISTs are cheap).
type AggregatorState = Map<string, Set<string>>;

export async function aggregateOtherReaders(
  store: CommentStore,
  postPath: string,
  ownUserId: string,
  state: AggregatorState,
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
          await pullUser(store, postPath, userId, state);
        } catch (err) {
          console.warn(
            `aggregate: failed to pull user ${userId}:`,
            err,
          );
        }
      }),
  );
}

async function pullUser(
  store: CommentStore,
  postPath: string,
  userId: string,
  state: AggregatorState,
): Promise<void> {
  const remote = await listChanges(postPath, userId);
  const remoteHashes = new Set(remote.map((e) => e.hash));
  const known = state.get(userId) ?? new Set<string>();

  const toFetch = [...remoteHashes].filter((h) => !known.has(h));
  if (toFetch.length === 0) {
    // Zero-delta path: nothing new for this user.
    return;
  }
  const fetched = await Promise.all(
    toFetch.map((h) => getChange(postPath, userId, h)),
  );
  const applyBytes = fetched.filter((b): b is Uint8Array => b !== null);
  store.applyOtherChanges(userId, applyBytes);

  // Mark everything we now know exists on the server for this user.
  for (const h of remoteHashes) known.add(h);
  state.set(userId, known);
}

export function newAggregatorState(): AggregatorState {
  return new Map();
}
