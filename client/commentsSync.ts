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
import {
  ApiError,
  MAX_RETRY_AFTER_MS,
  getChange,
  listChanges,
  putChange,
} from "./commentsApi.ts";

// Default backoff window when the server emits a 429 without a
// Retry-After header or a `retryAfter` JSON extension. Matches our
// Worker's rate-limiter window (wrangler.toml: 60s).
const DEFAULT_RATE_LIMIT_MS = 60_000;

function formatErr(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status}${err.problem?.type ? ` ${err.problem.type}` : ""}` +
      (err.problem?.detail ? ` — ${err.problem.detail}` : "");
  }
  return String(err);
}

// Detect a rate-limit response from either our Worker OR the
// Cloudflare edge (e.g. 1015). Two signals, in priority order:
//   1. HTTP status 429 — the universal wire-level rate-limit code.
//      Backoff window comes from the standard Retry-After header
//      (parsed in ApiError); falls back to the JSON `retryAfter`
//      extension our Worker emits, then to the default window.
//   2. Belt-and-suspenders: any non-429 carrying a Retry-After
//      header still earns the backoff (some intermediaries proxy
//      this header on other statuses).
// Returns the milliseconds to back off, or null if not rate-limited.
function rateLimitBackoffMs(err: ApiError): number | null {
  // ApiError.retryAfterMs is already clamped to [0, MAX_RETRY_AFTER_MS]
  // by parseRetryAfter. The body-fallback branch below applies the
  // same cap directly — a hostile server emitting
  // `{ "retryAfter": 9e15 }` must not wedge the client (see commentsApi
  // header comment on MAX_RETRY_AFTER_MS).
  if (err.status === 429) {
    if (err.retryAfterMs !== null) return err.retryAfterMs;
    const fromBody = err.problem?.retryAfter;
    if (typeof fromBody === "number" && Number.isFinite(fromBody)) {
      return Math.min(Math.max(0, fromBody) * 1000, MAX_RETRY_AFTER_MS);
    }
    return DEFAULT_RATE_LIMIT_MS;
  }
  if (err.retryAfterMs !== null) return err.retryAfterMs;
  return null;
}

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

  // Rate-limit backoff: when the server returns 429 with the
  // rate-limit/exceeded problem type, suppress pushes until this
  // monotonic-ms timestamp. Local mutations still land in the
  // Automerge doc — they just don't burn rate-limit budget on the
  // wire. When the window expires the next requestSync() flushes the
  // accumulated set.
  private rateLimitedUntilMs = 0;

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
      console.warn(`comment hydrate (listChanges) failed: ${formatErr(err)}`);
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
    // Honour an in-flight rate-limit window: defer the push to when
    // the window expires. The local change is already in the doc and
    // will get picked up by the catch-up flush.
    const now = Date.now();
    if (now < this.rateLimitedUntilMs) {
      this.dirty = true;
      const wait = this.rateLimitedUntilMs - now;
      setTimeout(() => {
        this.dirty = false;
        this.requestSync();
      }, wait);
      return;
    }
    void this.pushLoop().catch((err) => {
      console.warn(`comment sync push failed: ${formatErr(err)}`);
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
    const results = await Promise.allSettled(
      toPush.map(async (c) => {
        await putChange(this.postPath, this.userId, c.hash, c.bytes);
        this.serverKnownHashes.add(c.hash);
      }),
    );
    // Hoist any rate-limit response into the backoff window. One
    // rate-limit hit in a batch poisons the whole window — we treat
    // the limiter's signal (whichever layer emitted it) as
    // authoritative for "the user is over budget right now".
    for (const r of results) {
      if (r.status !== "rejected") continue;
      const err = r.reason;
      if (!(err instanceof ApiError)) continue;
      const backoffMs = rateLimitBackoffMs(err);
      if (backoffMs !== null) {
        this.rateLimitedUntilMs = Math.max(
          this.rateLimitedUntilMs,
          Date.now() + backoffMs,
        );
        console.warn(
          `comment sync rate-limited; backing off ${Math.ceil(backoffMs / 1000)}s ` +
            `(${formatErr(err)})`,
        );
        // Don't re-throw — the unpushed change is still in the doc
        // and will retry once the window expires.
        return;
      }
    }
    // Non-rate-limit rejections propagate to the pushLoop catch().
    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
    }
  }
}
