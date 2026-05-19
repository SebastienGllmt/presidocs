// Own-blob sync for the logged-in user. Pure set-diff over Automerge
// change hashes — no etag bookkeeping, no If-Match retry, no
// concurrency-control state machine. Change objects are immutable
// and content-addressed on the server (the hash IS the URL), so the
// classical "two writers race on the same blob" problem just doesn't
// arise.
//
//   hydrate():
//     1. LIST own changes from the server
//     2. For each hash we don't have locally, GET + applyOwnChanges
//     3. Record the union of (server set ∪ local set) as "known to be
//        on the server"
//     4. Push anything we have locally that isn't in that set
//
//   requestSync() (called after every local mutation):
//     Push any local change whose hash isn't in the "known on
//     server" set.
//
// Pushes are concurrency-safe by construction (different change
// hashes → different keys → no conflict). We do still serialize
// pushes within a tab via a single in-flight flag, just to avoid
// firing N concurrent fetches for a burst of N mutations — but the
// flag is a politeness measure, not a correctness one.

import { SEED_CHANGE_HASH, type CommentStore } from "./commentsStore.ts";
import { getChange, listChanges, putChange } from "./commentsApi.ts";

export class CommentSync {
  // Hashes the server is known to have for *our* user. Starts with
  // the seed (which is shared by construction; never needs to be
  // uploaded), grows on every successful pull/push.
  private serverKnownHashes = new Set<string>([SEED_CHANGE_HASH]);

  // Single-flight push gate. Multiple `requestSync()` calls while a
  // push is running coalesce — we just re-run after the in-flight
  // one finishes if anything new was added meanwhile.
  private pushing = false;
  private dirty = false;

  constructor(
    private readonly store: CommentStore,
    private readonly postPath: string,
    private readonly userId: string,
  ) {}

  // GET any of our own changes the server has that we don't, apply
  // them, then push anything we have that the server doesn't. Called
  // once at boot.
  async hydrate(): Promise<void> {
    let remote;
    try {
      remote = await listChanges(this.postPath, this.userId);
    } catch (err) {
      console.warn("comment hydrate (listChanges) failed:", err);
      return;
    }
    const remoteHashes = new Set(remote.map((e) => e.hash));
    const localHashes = new Set(
      this.store.getAllLocalChanges().map((c) => c.hash),
    );
    const toFetch = [...remoteHashes].filter((h) => !localHashes.has(h));
    const fetched = await Promise.all(
      toFetch.map((h) => getChange(this.postPath, this.userId, h)),
    );
    const applyBytes = fetched.filter((b): b is Uint8Array => b !== null);
    this.store.applyOwnChanges(applyBytes);

    // Record everything we now know exists on the server. The local
    // hashes we already had count too — they might be there from a
    // previous session even if we never re-listed.
    for (const h of remoteHashes) this.serverKnownHashes.add(h);

    // Push any local changes the server doesn't have.
    this.requestSync();
  }

  // Called from `store.onChange` after every local mutation.
  requestSync(): void {
    if (this.pushing) {
      this.dirty = true;
      return;
    }
    void this.pushLoop().catch((err) => {
      console.warn("comment sync push failed:", err);
    });
  }

  private async pushLoop(): Promise<void> {
    this.pushing = true;
    try {
      do {
        this.dirty = false;
        await this.pushOnce();
      } while (this.dirty);
    } finally {
      this.pushing = false;
    }
  }

  private async pushOnce(): Promise<void> {
    const localChanges = this.store.getAllLocalChanges();
    const toPush = localChanges.filter(
      (c) => !this.serverKnownHashes.has(c.hash),
    );
    if (toPush.length === 0) return;
    // Parallel upload — each change is independent and the server is
    // happy to receive concurrent writes (different keys).
    await Promise.all(
      toPush.map(async (c) => {
        await putChange(this.postPath, this.userId, c.hash, c.bytes);
        this.serverKnownHashes.add(c.hash);
      }),
    );
  }
}
