// CommentStore: the CRDT-backed storage layer for comments.
//
// The doc shape is intentionally close to the v1 JSON shape, with two
// changes that play better with Automerge's merge semantics:
//   - `threads` is a map keyed by thread id (was an array)
//   - each thread's `replies` is a map keyed by reply id (was an array)
//
// Maps avoid list-position conflicts entirely — two devices adding a
// reply concurrently always end up with both entries, no ordering tug.
// Render order is reconstructed from `createdAt`.
//
// What's actually doing CRDT work today: not much, by design. In v1 each
// (post, reader) writes to its own R2 blob (when Phase 2 lands), so
// concurrent writers on the same doc are effectively impossible — until
// a reader uses two devices, at which point Automerge merges them
// trivially. The library is here primarily so Phase 2's R2 sync is a
// `merge + save + PUT` loop instead of a hand-rolled op log, and so a
// future "readers see each other" feature doesn't need a rewrite.
//
// Automerge is lazy-imported — its WASM core is ~700KB and we don't want
// to block the article render on it. The CommentStore.create()
// constructor awaits the import, so callers naturally inherit the wait.

// We use Automerge's `/slim` subpath rather than the default entry,
// which has an exports map that tries to pick between a "bundler"
// variant (expects the bundler to instantiate the `.wasm` namespace
// import) and a "base64" variant (decodes inline). Bun's resolver
// picked paths inconsistently — both variants ended up in the bundle
// with only one path actually live. `/slim` is the bring-your-own-WASM
// entry: it exposes `initializeWasm()`, which we feed the URL of an
// HTTP-served `.wasm` asset. The browser fetches it once and caches
// (`index.ts` sets a long `Cache-Control: immutable` on the route).
import type * as AutomergeNS from "@automerge/automerge/slim";
type Automerge = typeof AutomergeNS;
type Doc<T> = AutomergeNS.Doc<T>;

// URL the slim init fetches to instantiate the WebAssembly module.
// Override via `setCommentsWasmSource(...)` (used by tests, which run
// in Bun's Node-like runtime and read the file from disk instead).
type WasmSource = string | URL | Request | Uint8Array | ArrayBuffer;
let _wasmSource: WasmSource = "/assets/automerge.wasm";

export function setCommentsWasmSource(src: WasmSource): void {
  _wasmSource = src;
  // Force a fresh init if `loadAutomerge` had already been called —
  // otherwise an earlier (default) init would still be in effect.
  _automerge = null;
}

let _automerge: Promise<Automerge> | null = null;
function loadAutomerge(): Promise<Automerge> {
  if (!_automerge) {
    _automerge = (async () => {
      const automerge = await import("@automerge/automerge/slim");
      if (!automerge.isWasmInitialized()) {
        await automerge.initializeWasm(_wasmSource);
      }
      return automerge;
    })();
  }
  return _automerge;
}

// All fresh CommentDocs start from these bytes. Why a *shared seed*
// instead of `Automerge.from({ threads: {} })` per device:
//
//   `Automerge.from({threads:{}}, {actor: X})` records "actor X
//   initialized the `threads` field at time T". If device A and device
//   B each do this independently, their resulting docs have two
//   different assignments to the same field by different actors. When
//   we then merge the two docs, Automerge picks one assignment to win
//   and discards the other — so whichever side "loses" loses *all*
//   their threads, because their `threads` object identity gets
//   replaced by the other side's empty `{}`.
//
// Loading the same seed bytes everywhere means every device shares the
// same root Automerge object identity. Subsequent `.addThread` ops
// mutate a *single* threads map (from Automerge's perspective), which
// merges correctly.
//
// The seed uses a fixed actor id so the bytes are deterministic — the
// genesis transaction is logically "no one in particular". Per-device
// actor ids are assigned by Automerge automatically when each device
// loads the seed and starts writing.
const SEED_ACTOR = "0000000000000000";
let _seedBytes: Uint8Array | null = null;
function getSeedBytes(automerge: Automerge): Uint8Array {
  if (!_seedBytes) {
    const seed = automerge.from<CommentDoc>(
      { threads: {} },
      { actor: SEED_ACTOR },
    );
    _seedBytes = automerge.save(seed);
  }
  return _seedBytes;
}

// ---------- Public types (snapshot side, plain JSON) ----------

export type Context = "article" | "narration";

export type TextAnchor = {
  kind: "text";
  context: Context;
  segments: Array<{ id: string; hash: string }>;
  startOffset: number;
  endOffset: number;
  quote: string;
};

export type GraphicAnchor = {
  kind: "graphic";
  context: Context;
  id: string;
};

export type Anchor = TextAnchor | GraphicAnchor;

export type Reply = {
  id: string;
  body: string;
  createdAt: number;
  deletedAt?: number;
  // Identity of the user who wrote this reply. Always set for replies
  // created after login was added (v1 of auth); the system gates the UI
  // on login so there is no anonymous path. Stored in the CRDT so that
  // the future R2 sync + author-side aggregating viewer have everything
  // they need (incl. email for follow-up) without a separate lookup.
  authorId: string;       // `<provider>:<sub>` — matches Identity.userId
  authorName: string;
  authorEmail: string;
  authorPicture?: string;
};

export type Thread = {
  id: string;
  anchor: Anchor;
  // Snapshot exposes replies as an array (sorted by createdAt). The
  // underlying doc keeps them as a map for CRDT-friendliness.
  replies: Reply[];
  createdAt: number;
  resolvedAt?: number;
};

// Predicates exposed alongside the types so callers don't reach into
// the optional timestamp fields directly. Mirrors the v1 helpers.
export function isResolved(thread: Thread): boolean {
  return thread.resolvedAt !== undefined;
}
export function isDeleted(reply: Reply): boolean {
  return reply.deletedAt !== undefined;
}
export function visibleReplies(thread: Thread): Reply[] {
  return thread.replies.filter((r) => !isDeleted(r));
}

// ---------- CRDT doc shape (internal) ----------

type CommentDoc = {
  threads: {
    [id: string]: {
      anchor: Anchor;
      replies: { [id: string]: Reply };
      createdAt: number;
      resolvedAt?: number;
    };
  };
};

// ---------- Storage keys ----------

// Doc is keyed by the logged-in user's id (`<provider>:<sub>`). The
// pre-auth scheme used a per-device random reader-id; that data, if any
// still sits in localStorage from earlier testing, is now inaccessible
// — auth is required to comment and the new key shape doesn't collide
// with the old one, so old blobs sit harmlessly dormant.
function docKey(postPath: string, userId: string): string {
  return `blog-comments:${postPath}:user:${userId}.amrg`;
}

// ---------- Base64 (binary <-> string for localStorage) ----------
//
// localStorage is string-only and Automerge snapshots are Uint8Array.
// btoa/atob only handle Latin-1 chars, so we encode by-byte. The
// snapshots are small enough that the inefficiency doesn't matter at our
// scale; switching to IndexedDB is a follow-up if comments ever get
// large enough for this to register.

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- Store ----------

export class CommentStore {
  // Marked private so callers can't mutate the doc directly — every
  // change goes through one of the named mutation methods, which keeps
  // op names useful in `Automerge.getHistory(doc)` for debugging.
  private doc: Doc<CommentDoc>;

  private constructor(
    private readonly automerge: Automerge,
    private readonly storageKey: string,
    initial: Doc<CommentDoc>,
  ) {
    this.doc = initial;
  }

  static async create(postPath: string, userId: string): Promise<CommentStore> {
    const automerge = await loadAutomerge();
    const key = docKey(postPath, userId);

    const b64 = localStorage.getItem(key);
    if (b64) {
      try {
        const doc = automerge.load<CommentDoc>(base64ToBytes(b64));
        return new CommentStore(automerge, key, doc);
      } catch (err) {
        console.warn("Failed to load Automerge doc, starting fresh:", err);
      }
    }

    // Nothing on disk — load the shared seed (see SEED_ACTOR comment).
    const empty = automerge.load<CommentDoc>(getSeedBytes(automerge));
    return new CommentStore(automerge, key, empty);
  }

  // ---------- Reads ----------

  // Returns a JSON snapshot: threads as an array, each thread's replies
  // as an array sorted by createdAt. The snapshot is *plain JS* — safe
  // to hand to render code, no Automerge proxies to worry about.
  snapshot(): Thread[] {
    const js = this.automerge.toJS(this.doc) as CommentDoc;
    const out: Thread[] = [];
    for (const id of Object.keys(js.threads)) {
      const t = js.threads[id]!;
      const replies = Object.values(t.replies).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      out.push({
        id,
        anchor: t.anchor,
        replies,
        createdAt: t.createdAt,
        ...(t.resolvedAt !== undefined && { resolvedAt: t.resolvedAt }),
      });
    }
    // Stable order by createdAt for the rare callers that don't sort
    // themselves by anchor position.
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---------- Mutations ----------

  addThread(threadId: string, anchor: Anchor, createdAt: number): void {
    this.mutate("add thread", (d) => {
      // Anchor is structurally cloned into the doc so future change ops
      // see a stable reference; we never mutate anchor afterwards.
      d.threads[threadId] = {
        anchor: structuredClone(anchor),
        replies: {},
        createdAt,
      };
    });
  }

  addReply(threadId: string, reply: Reply): void {
    this.mutate("add reply", (d) => {
      const t = d.threads[threadId];
      if (!t) return;
      t.replies[reply.id] = { ...reply };
    });
  }

  resolveThread(threadId: string, resolvedAt: number): void {
    this.mutate("resolve thread", (d) => {
      const t = d.threads[threadId];
      if (!t) return;
      // Idempotent: once resolved, the timestamp is frozen. Same reason
      // as deleteReply — re-stamping breaks audit timing and produces
      // spurious "later resolve" merge ops.
      if (t.resolvedAt !== undefined) return;
      t.resolvedAt = resolvedAt;
    });
  }

  deleteReply(threadId: string, replyId: string, deletedAt: number): void {
    this.mutate("delete reply", (d) => {
      const t = d.threads[threadId];
      if (!t) return;
      const r = t.replies[replyId];
      if (!r) return;
      // Tombstone is immutable once set — re-stamping would invent a
      // bogus "later delete" event during CRDT merge and confuse any
      // future audit / undo flow that keys off the original timestamp.
      if (r.deletedAt !== undefined) return;
      r.deletedAt = deletedAt;
      // Atomic auto-resolve: if no visible replies remain, the thread is
      // a dead record — bundle the resolve into the same op so a future
      // server sync gets a coherent "this whole thread is gone."
      const liveCount = Object.values(t.replies).filter(
        (rr) => rr?.deletedAt === undefined,
      ).length;
      if (liveCount === 0 && t.resolvedAt === undefined) {
        t.resolvedAt = deletedAt;
      }
    });
  }

  // ---------- Sync surface (Phase 2 will use these) ----------

  // Serialize the current doc for upload. The bytes are the full
  // Automerge change history (compressed); a fresh load reconstructs
  // the same logical state. Phase 2's R2 sync will PUT these bytes
  // with `If-Match: <etag>` on every change.
  exportBytes(): Uint8Array {
    return this.automerge.save(this.doc);
  }

  // Merge a remote doc (deserialized from bytes) into the local doc.
  // Automerge's merge is commutative and idempotent: applying the same
  // remote bytes twice is the same as once, and `merge(a, b)` is the
  // same logical state as `merge(b, a)`. Phase 2's conflict-retry loop
  // (on a 412 from R2) will GET the fresh bytes, call this, then save
  // back. Persists immediately so the post-merge state survives a
  // crash.
  mergeBytes(remoteBytes: Uint8Array): void {
    const remoteDoc = this.automerge.load<CommentDoc>(remoteBytes);
    this.doc = this.automerge.merge(this.doc, remoteDoc);
    this.persist();
  }

  // ---------- Internals ----------

  private mutate(action: string, fn: (d: CommentDoc) => void): void {
    this.doc = this.automerge.change(this.doc, action, fn);
    this.persist();
  }

  private persist(): void {
    try {
      const bytes = this.automerge.save(this.doc);
      localStorage.setItem(this.storageKey, bytesToBase64(bytes));
    } catch (err) {
      console.warn("Failed to persist Automerge doc:", err);
    }
  }
}
