// Storage abstraction for the comments R2 proxy.
//
// Schema is per-change: each Automerge change uploaded by a client
// lives as its own object under `comments/<postPath>/<userId>/<hash>.bin`,
// where `<hash>` is the change's content hash (the same one
// `Automerge.decodeChange(bytes).hash` returns). Content-addressed,
// globally unique, deduplicating-by-construction (the same change
// uploaded twice produces the same key + same bytes).
//
// Why per-change rather than one full-blob-per-user: it's the
// natural shape for CRDT sync. The server is and stays dumb — it
// shuffles opaque bytes around and does no merging itself. Clients
// do `LIST` + set-diff against locally-known hashes to discover what
// they need, GET the missing changes, and apply them via
// `Automerge.applyChanges`. No If-Match etag dance, no 412 retry
// loop, no concurrent-writer hazard: change objects are immutable
// once written (each at a unique hash-keyed URL), so two clients
// uploading simultaneously just create two different objects.
// Zero-delta page loads cost a single LIST per user.
//
// See methodology.md → Comments → Storage layer for the full
// rationale and the layout-evolution table.

export type ChangeListEntry = {
  hash: string;
  size: number;
  uploaded: Date;
};

export type PutChangeResult =
  | { kind: "ok" }
  // The change is already there (same key, same bytes). Idempotent.
  // We treat this as success; the client doesn't care that the bytes
  // were already on disk.
  | { kind: "already_present" };

export interface CommentChangeStore {
  // Returns the bytes of one specific change, or null if it doesn't
  // exist.
  getChange(
    post: string,
    userId: string,
    changeHash: string,
  ): Promise<Uint8Array | null>;

  // Writes a change. Content-addressed: re-writing the same hash
  // (same bytes) is a no-op success.
  putChange(
    post: string,
    userId: string,
    changeHash: string,
    bytes: Uint8Array,
  ): Promise<PutChangeResult>;

  // Lists all change hashes under one (post, user). Returns the
  // ordered metadata so callers can also know sizes / upload times
  // for free.
  listChanges(post: string, userId: string): Promise<ChangeListEntry[]>;

  // Lists all userIds that have *any* change under this post.
  // Author-only at the route layer; the store doesn't enforce auth.
  listUsers(post: string): Promise<string[]>;

  // --- Author-resolution surface ---
  //
  // Resolutions live in a separate per-post namespace
  // (`resolutions/<post>/<threadId>.json`), keyed by threadId rather
  // than by user. One blob per resolved thread; the body is an
  // opaque JSON envelope the server doesn't parse. Author-only
  // writes; any logged-in user may read.
  //
  // We don't bother with content-addressed change-objects here
  // because resolutions are single-writer per post (only the author
  // writes) — last-write-wins on the same key is harmless (two
  // author devices resolving the same thread differ only in
  // timestamp, and we don't care which wins). This sidesteps the
  // entire Automerge / per-change / set-diff plumbing.
  getResolution(
    post: string,
    threadId: string,
  ): Promise<Uint8Array | null>;

  putResolution(
    post: string,
    threadId: string,
    bytes: Uint8Array,
  ): Promise<void>;

  listResolutions(post: string): Promise<ResolutionListEntry[]>;
}

export type ResolutionListEntry = {
  threadId: string;
  size: number;
  uploaded: Date;
};

// ---------- Key shape ----------

// `comments/<postPath>/<userId>/<changeHash>.bin`. `postPath` and
// `userId` are allowed to contain `/` and `:` respectively, so the
// key is constructed via simple concatenation — same approach as
// before, just one extra path segment.
export function changeKey(
  postPath: string,
  userId: string,
  changeHash: string,
): string {
  return `comments/${postPath}/${userId}/${changeHash}.bin`;
}

export function userPrefix(postPath: string, userId: string): string {
  return `comments/${postPath}/${userId}/`;
}

export function postPrefix(postPath: string): string {
  return `comments/${postPath}/`;
}

// Pull the `<changeHash>` out of a full key. Returns null for
// malformed keys (defensive; shouldn't happen because we control
// the writes).
export function changeHashFromKey(key: string): string | null {
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash === -1) return null;
  const last = key.slice(lastSlash + 1);
  if (!last.endsWith(".bin")) return null;
  return last.slice(0, -".bin".length);
}

// Pull the `<userId>` from a full key. The userId is the segment
// between the post path and the change file. We don't know where the
// post path ends in general, so we identify the userId as the
// second-to-last `/`-separated segment.
export function userIdFromKey(key: string): string | null {
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash === -1) return null;
  const beforeLast = key.lastIndexOf("/", lastSlash - 1);
  if (beforeLast === -1) return null;
  return key.slice(beforeLast + 1, lastSlash);
}

// `resolutions/<postPath>/<threadId>.json`. Mutable (last-write-wins);
// single writer per post (the author), so concurrent overwrites are
// effectively the same content.
export function resolutionKey(postPath: string, threadId: string): string {
  return `resolutions/${postPath}/${threadId}.json`;
}

export function resolutionPrefix(postPath: string): string {
  return `resolutions/${postPath}/`;
}

export function threadIdFromResolutionKey(key: string): string | null {
  const lastSlash = key.lastIndexOf("/");
  if (lastSlash === -1) return null;
  const last = key.slice(lastSlash + 1);
  if (!last.endsWith(".json")) return null;
  return last.slice(0, -".json".length);
}
