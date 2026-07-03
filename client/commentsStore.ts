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
type WasmSource = string | Uint8Array;
let _wasmSource: WasmSource = "/assets/automerge.wasm";

export function setCommentsWasmSource(src: WasmSource): void {
  _wasmSource = src;
  // Force a fresh init if `loadAutomerge` had already been called —
  // otherwise an earlier (default) init would still be in effect.
  _automerge = null;
  // UNSUPPORTED: switching the WASM source mid-session. Any `Doc<T>`
  // value already constructed via the previous init is bound to that
  // WASM module's internal handle table; subsequent operations on it
  // after a swap will throw with cryptic errors. Tests are the only
  // caller and they always set the source before constructing any
  // doc, so this isn't a problem today — just don't get clever.
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

// All fresh CommentDocs start from these *exact* bytes — generated once
// (see below) and frozen as a constant. Every device that loads them
// shares the same root Automerge change graph, so subsequent writes
// merge as adds to a single `threads` map rather than as conflicting
// re-creates of the field.
//
// Why the constant (and not `Automerge.from({threads:{}}, {actor: X})`
// per session): `Automerge.from` records a `time` field in the genesis
// change, so two devices calling it produce byte-different seed blobs
// with different op IDs for the same "create threads field" change.
// When merged, Automerge sees two independent root assignments to the
// same field and resolves the conflict by picking one — the loser's
// entire `threads` map is silently replaced by the winner's (typically
// empty) one. The author's aggregating viewer hit exactly this bug
// before the fix: list + GET both succeeded, but the merged snapshot
// dropped every reader's content.
//
// REGENERATING THESE BYTES BREAKS COMPATIBILITY with every existing
// blob on R2 / localStorage. The genesis op in the seed embeds a
// timestamp via `Automerge.from(...)`, so even running the
// regenerator twice in a row with the same actor id produces
// different bytes and a different SEED_CHANGE_HASH; downstream
// changes recorded against the old seed would lose their parent in
// the new doc and Automerge.applyChanges would silently skip them
// (no error — see methodology.md → "Schema evolution gotcha").
// Don't regenerate unless you also intend to ship a migration
// change per the Automerge docs' schema-migration pattern.
//
// One-shot regen command (e.g. CommentDoc shape changes, you've
// implemented the migration):
//   bun -e 'import("@automerge/automerge/slim").then(async (am) => {
//     await am.initializeWasm(await Bun.file("node_modules/@automerge/automerge/dist/automerge.wasm").arrayBuffer());
//     const s = am.from({ threads: {}, replies: {} }, { actor: "0000000000000000" });
//     const b = am.save(s); let r = "";
//     for (let i = 0; i < b.length; i++) r += String.fromCharCode(b[i]);
//     console.log(btoa(r));
//   });'
export const SEED_BYTES_B64 =
  "hW9Kg1cN6wgAdQEIAAAAAAAAAAABDi3iQnW6anGaIFPMkopg6j6BTdhcwIDQlKNyJId8WdMGAQIDAhMCIwZAAlYCBxURIQIjAjQBQgJWAoABAn8AfwF/An/norDQBn8Afwd+B3JlcGxpZXMHdGhyZWFkcwIAAgECAgACAAIAAA==";

// Hash of the single genesis change inside SEED_BYTES_B64 (computed
// once via Automerge.decodeChange and pinned here). The sync layer
// excludes this hash when computing "what to upload" — the seed is
// shared by every device by construction and never needs to live in
// any user's R2 folder. Pinning the constant means the sync layer
// doesn't have to crack open the seed at runtime.
export const SEED_CHANGE_HASH =
  "0e2de24275ba6a719a2053cc928a60ea3e814dd85cc080d094a37224877c59d3";

let _seedBytes: Uint8Array | null = null;
function getSeedBytes(_automerge: Automerge): Uint8Array {
  if (!_seedBytes) _seedBytes = base64ToBytes(SEED_BYTES_B64);
  return _seedBytes;
}

// ---------- Public types (snapshot side, plain JSON) ----------
//
// Comment anchors are stored as W3C Web Annotation Data Model "targets"
// (REC 2017, https://www.w3.org/TR/annotation-model/#selectors): a
// `source` IRI plus one or more selectors that narrow the target to a
// part of that source. See methodology.md → Comments → "Anchoring is
// the Web Annotation target model" for the full rationale and the
// field-by-field mapping from the pre-2026 ad-hoc shape.
//
// Two anchor flavors, both expressed in pure WA selector vocabulary:
//   - text selection → a RangeSelector between two block selectors
//     (each refined by a TextPositionSelector giving the char offset
//     within that block) plus a TextQuoteSelector carrying the verbatim
//     text (+ surrounding context for future fuzzy re-anchoring).
//   - whole graphic   → a single FragmentSelector naming the figure.
//
// The per-block content hashes that drive stale-detection have no
// native WA equivalent (the model has selectors, not integrity checks),
// so they live in the project-namespaced `x-blog:segmentHashes`
// extension — the conventional WA escape hatch for data the vocabulary
// doesn't cover. That array is also the authoritative *ordered* block
// list our highlight/stale code walks; the RangeSelector only names the
// two endpoints, so the extension is a superset, not a duplicate.

export type Context = "article" | "narration";

// Char offsets within one block. We only ever use one boundary per
// endpoint of a range (`start` on the range's start block, `end` on its
// end block), but the spec makes both fields mandatory, so the unused
// one mirrors the used one (a zero-length boundary marker).
export type TextPositionSelector = {
  type: "TextPositionSelector";
  start: number;
  end: number;
};

// A real HTML fragment id (`<p id="foo">` → value "foo"). Used when the
// block carried an author-supplied `id`.
export type FragmentSelector = {
  type: "FragmentSelector";
  value: string;
  refinedBy?: TextPositionSelector;
};

// A synthesized block path (`article:__b-7`) for blocks with no
// author id. Named CssSelector per the spec slot for "path into the
// DOM"; the value is our internal block-index id, not a literal CSS
// query (these ids are deliberately fragile under edits — see the
// stale-anchor flow). Carries the same data-attribute the DOM has
// (`[data-comment-block-id="..."]`) for any external consumer that
// wants to resolve it.
export type CssSelector = {
  type: "CssSelector";
  value: string;
  refinedBy?: TextPositionSelector;
};

export type BlockSelector = FragmentSelector | CssSelector;

export type TextQuoteSelector = {
  type: "TextQuoteSelector";
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type RangeSelector = {
  type: "RangeSelector";
  startSelector: BlockSelector;
  endSelector: BlockSelector;
};

// W3C Media Fragments selector (https://www.w3.org/TR/media-frags/) —
// `value` is an `npt` time range like "t=83,95" (seconds). It records
// the slice of the narration *audio* a comment sits on. Populated
// *automatically* for narration comments from the generated mark
// timings (the narrator stamps each drawer segment with `data-time-ms`,
// sourced from the manifest, which `bun run generate` computes via the
// AudioPipeline) — the author never types a timestamp. Absent on
// article and graphic targets. It rides alongside the text selectors as
// an additional facet of the same target; the range is segment-granular
// (bounded by `<mark>` times, the finest timing the manifest carries),
// not character-granular.
export const MEDIA_FRAGS_SPEC = "http://www.w3.org/TR/media-frags/";

export type MediaFragmentSelector = {
  type: "FragmentSelector";
  conformsTo: typeof MEDIA_FRAGS_SPEC;
  value: string;
};

export type TextTarget = {
  source: string; // post-relative IRI: "" (article) or "#narration"
  // [structural range, verbatim quote, (narration only) audio range].
  selector: [RangeSelector, TextQuoteSelector, ...MediaFragmentSelector[]];
  "x-blog:segmentHashes": Array<{ id: string; hash: string }>;
};

export type GraphicTarget = {
  source: string;
  selector: FragmentSelector;
};

export type Target = TextTarget | GraphicTarget;

// ---------- Target helpers ----------
//
// All knowledge of the selector shape lives here so the UI and the
// offline authoring tools read plain fields, not nested selector
// arrays. `source` encodes the commentable surface as a fragment: the
// article body is the bare resource (""), the spoken-script drawer is
// "#narration". (The post path itself is implicit — the whole doc is
// per-post — and gets prepended only at the JSON-LD export boundary.)

const NARRATION_SOURCE = "#narration";

export function sourceForContext(context: Context): string {
  return context === "narration" ? NARRATION_SOURCE : "";
}

export function contextOf(target: Target): Context {
  return target.source.includes(NARRATION_SOURCE) ? "narration" : "article";
}

export function isTextTarget(t: Target): t is TextTarget {
  return "x-blog:segmentHashes" in t;
}

// Internal block id (`id:foo` / `article:__b-7`) ⇄ block selector. The
// `id:` namespace prefix is internal bookkeeping; a FragmentSelector's
// `value` is the bare HTML fragment, so we re-add / strip the prefix at
// this boundary.
function blockIdToSelector(internalId: string): BlockSelector {
  if (internalId.startsWith("id:")) {
    return { type: "FragmentSelector", value: internalId.slice(3) };
  }
  return { type: "CssSelector", value: internalId };
}
function selectorToBlockId(sel: BlockSelector): string {
  return sel.type === "FragmentSelector" ? `id:${sel.value}` : sel.value;
}

// Format a millisecond instant as `npt` seconds (trailing zeros trimmed).
function nptSeconds(ms: number): string {
  return Number((ms / 1000).toFixed(3)).toString();
}

export function makeTextTarget(args: {
  context: Context;
  blocks: Array<{ id: string; hash: string }>;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  /**
   * Audio time range for narration comments, derived automatically from
   * the generated mark timings — never hand-entered. `endMs: null` means
   * open-ended (the last segment runs to the end of the audio), which
   * Media Fragments expresses as a start-only `t=<start>`.
   */
  audioRange?: { startMs: number; endMs: number | null };
}): TextTarget {
  const first = args.blocks[0]!;
  const last = args.blocks[args.blocks.length - 1]!;
  const startSelector = blockIdToSelector(first.id);
  startSelector.refinedBy = {
    type: "TextPositionSelector",
    start: args.startOffset,
    end: args.startOffset,
  };
  const endSelector = blockIdToSelector(last.id);
  endSelector.refinedBy = {
    type: "TextPositionSelector",
    start: args.endOffset,
    end: args.endOffset,
  };
  const quote: TextQuoteSelector = { type: "TextQuoteSelector", exact: args.quote };
  if (args.prefix) quote.prefix = args.prefix;
  if (args.suffix) quote.suffix = args.suffix;
  const range: RangeSelector = { type: "RangeSelector", startSelector, endSelector };
  const segmentHashes = args.blocks.map((b) => ({ id: b.id, hash: b.hash }));
  const source = sourceForContext(args.context);
  if (args.audioRange) {
    const { startMs, endMs } = args.audioRange;
    const value =
      endMs == null ? `t=${nptSeconds(startMs)}` : `t=${nptSeconds(startMs)},${nptSeconds(endMs)}`;
    const media: MediaFragmentSelector = {
      type: "FragmentSelector",
      conformsTo: MEDIA_FRAGS_SPEC,
      value,
    };
    return { source, selector: [range, quote, media], "x-blog:segmentHashes": segmentHashes };
  }
  return { source, selector: [range, quote], "x-blog:segmentHashes": segmentHashes };
}

export function makeGraphicTarget(context: Context, figureId: string): GraphicTarget {
  return {
    source: sourceForContext(context),
    selector: blockIdToSelector(figureId) as FragmentSelector,
  };
}

// Reconstruct the practical anchor fields our resolution code needs from
// a WA text target. Centralizes the selector-shape knowledge.
export function textTargetParts(t: TextTarget): {
  blocks: Array<{ id: string; hash: string }>;
  startOffset: number;
  endOffset: number;
  quote: string;
} {
  const [range, quote] = t.selector;
  return {
    blocks: t["x-blog:segmentHashes"],
    startOffset: range.startSelector.refinedBy?.start ?? 0,
    endOffset: range.endSelector.refinedBy?.end ?? 0,
    quote: quote.exact,
  };
}

export function graphicTargetId(t: GraphicTarget): string {
  return selectorToBlockId(t.selector);
}

// The audio time range a (narration) comment sits on, in ms, or null if
// the target carries no Media Fragments selector (article / graphic
// targets, or a narration comment created before the drawer timings
// were available). `endMs: null` is an open-ended range (runs to the
// end of the audio).
export function audioFragmentRange(
  target: Target,
): { startMs: number; endMs: number | null } | null {
  if (!isTextTarget(target)) return null;
  const media = target.selector.find(
    (s): s is MediaFragmentSelector =>
      "conformsTo" in s && s.conformsTo === MEDIA_FRAGS_SPEC,
  );
  if (!media) return null;
  const m = /^t=([\d.]+)(?:,([\d.]+))?$/.exec(media.value);
  if (!m) return null;
  const startMs = Math.round(parseFloat(m[1]!) * 1000);
  const endMs = m[2] !== undefined ? Math.round(parseFloat(m[2]) * 1000) : null;
  return { startMs, endMs };
}

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

// A propose-an-edit payload (proposal 65). Written once in the
// thread-creation change and immutable after — the range's original text
// is the target's `TextQuoteSelector.exact`, so we only carry the
// replacement here. `proposed: ""` deletes the anchored range. Author
// fields mirror `Reply`'s: a note-less suggestion still needs an author
// for its card and its export `creator`.
export type Suggestion = {
  proposed: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  authorPicture?: string;
};

export type Thread = {
  id: string;
  target: Target;
  // Snapshot exposes replies as an array (sorted by createdAt). The
  // underlying doc keeps them as a map for CRDT-friendliness.
  replies: Reply[];
  createdAt: number;
  resolvedAt?: number;
  suggestion?: Suggestion;
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
//
// Schema is deliberately *flat*: threads and replies are sibling
// top-level maps, both keyed by globally-unique ids. Replies carry a
// `threadId` pointing back at their parent. The shape is what makes
// the CRDT "magical" merging actually work for our use case — see
// methodology.md → Comments → Storage layer → "Flat schema" for the
// full rationale. Short version:
//   - All writes (creating threads, adding replies) land at unique
//     paths by construction, so the CRDT's "concurrent adds to
//     different map keys never conflict" property does all the work.
//   - There's no nested-mutation case where two clients independently
//     "create the same parent object," which is the one case CRDTs
//     can't resolve cleanly (loser's whole subtree gets dropped).
//   - The per-reply storage granularity also makes incremental
//     server sync a natural future evolution: we send a reply as
//     the unit of change, not a whole thread.

// Threads only carry their own immutable-after-create fields plus a
// per-thread mutable `resolvedAt`. Replies live in a separate map,
// not nested here.
type StoredThread = {
  target: Target;
  createdAt: number;
  resolvedAt?: number;
  suggestion?: Suggestion;
};

// Internal storage of a reply — extends the public `Reply` with the
// `threadId` pointer needed for the flat map. `snapshot()` strips
// `threadId` back out when assembling per-thread reply lists, so
// consumers of the public type never see this field.
type StoredReply = Reply & { threadId: string };

type CommentDoc = {
  threads: { [id: string]: StoredThread };
  replies: { [replyId: string]: StoredReply };
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

// Foreign readers' docs (loaded by the author-side aggregator) persist
// alongside our own so a reload renders everyone's comments — and the
// correct unresolved count — before the network aggregation runs. One
// blob per reader, plus a small index listing which readers we have a
// blob for (avoids enumerating all of localStorage on boot).
function otherDocKey(postPath: string, userId: string): string {
  return `blog-comments:${postPath}:other:${userId}.amrg`;
}
function othersIndexKey(postPath: string): string {
  return `blog-comments:${postPath}:others`;
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
  //
  // INVARIANT: `doc` only ever contains *this user's* writes. Other
  // readers' blobs (loaded by the author-side aggregator) live in
  // `others` and are read-only — they're factored into `snapshot()`
  // but NEVER written back via `exportBytes()`, so the author's R2
  // blob doesn't bloat into a superset of everyone else's content.
  private doc: Doc<CommentDoc>;

  // Read-only docs from other readers, keyed by their userId.
  // Populated only by `mergeOther`, called from the author-only
  // aggregator. `snapshot()` merges `doc` with all entries here for
  // display; `exportBytes()` ignores them.
  private readonly others = new Map<string, Doc<CommentDoc>>();

  // Optional callback fired after every mutation (after persist()).
  // The sync layer wires its `requestSync()` here so every local
  // change kicks off a server push. Stays null when running offline /
  // in tests.
  onChange: (() => void) | null = null;

  // Memoization: snapshot() and getAllLocalChanges() are both pure
  // functions of (this.doc, this.others) and (this.doc), respectively.
  // We invalidate both on every mutation / merge so we only pay
  // their costs (Automerge clone+merge, getAllChanges+decodeChange
  // per change) when something has actually changed. Pre-cache,
  // snapshot was O(K others) per render and getAllLocalChanges was
  // O(N local changes) on every push — both ran far more often than
  // they needed to.
  private cachedSnapshot: Thread[] | null = null;
  private cachedLocalChanges:
    | Array<{ hash: string; bytes: Uint8Array }>
    | null = null;

  // hash -> change-bytes for each foreign reader's doc, derived on demand
  // and invalidated per user on `applyOtherChanges`. Backs both the
  // aggregator's delta check (`foreignChangeHashes`) and origin derivation
  // (which replays the production-tagged subset) — so neither re-fetches
  // what the store already holds.
  private readonly foreignBytesCache = new Map<string, Map<string, Uint8Array>>();

  // Memo for origin derivation, keyed by scope ("" = own doc, else the
  // foreign userId): the signature of the production-tagged hash set last
  // derived. An unchanged set (the common 60s-poll case) skips the replay.
  private readonly derivedProdSig = new Map<string, string>();

  // Reply ids by birth store, both derived positively (see deriveOrigins):
  // `production` from replaying the production-tagged blobs, `local` as
  // the complement within the full replay — so an id in NEITHER set means
  // "derivation didn't cover it" (failed, or the reply isn't on the server
  // yet), never silently "local". In-memory only — re-derived from the
  // server listing on every boot, never persisted: provenance is a fact
  // of the server's data, not client state to maintain.
  private readonly productionReplies = new Set<string>();
  private readonly localReplies = new Set<string>();

  private constructor(
    private readonly automerge: Automerge,
    private readonly postPath: string,
    private readonly storageKey: string,
    initial: Doc<CommentDoc>,
  ) {
    this.doc = initial;
  }

  static async create(postPath: string, userId: string): Promise<CommentStore> {
    const automerge = await loadAutomerge();
    const key = docKey(postPath, userId);

    let doc: Doc<CommentDoc> | null = null;
    const b64 = localStorage.getItem(key);
    if (b64) {
      try {
        doc = automerge.load<CommentDoc>(base64ToBytes(b64));
      } catch (err) {
        console.warn("Failed to load Automerge doc, starting fresh:", err);
      }
    }
    // Nothing on disk — load the shared seed (see SEED_BYTES_B64).
    if (!doc) doc = automerge.load<CommentDoc>(getSeedBytes(automerge));

    const store = new CommentStore(automerge, postPath, key, doc);
    store.loadPersistedOthers();
    return store;
  }

  // Re-hydrate the author-side aggregate from localStorage so the first
  // render already includes every reader's threads. The aggregator then
  // refreshes only deltas (the persisted docs seed `foreignChangeHashes`,
  // so a reload re-GETs nothing). A bad blob is dropped, not fatal — the
  // aggregator will re-pull it.
  private loadPersistedOthers(): void {
    const indexRaw = localStorage.getItem(othersIndexKey(this.postPath));
    if (!indexRaw) return;
    let userIds: unknown;
    try {
      userIds = JSON.parse(indexRaw);
    } catch {
      return;
    }
    if (!Array.isArray(userIds)) return;
    for (const userId of userIds) {
      if (typeof userId !== "string") continue;
      const b64 = localStorage.getItem(otherDocKey(this.postPath, userId));
      if (!b64) continue;
      try {
        this.others.set(
          userId,
          this.automerge.load<CommentDoc>(base64ToBytes(b64)),
        );
      } catch (err) {
        console.warn(`Failed to load foreign comment doc for ${userId}:`, err);
      }
    }
  }

  // ---------- Reads ----------

  // Returns a JSON snapshot: threads as an array, each thread's replies
  // as an array sorted by createdAt. The snapshot is *plain JS* — safe
  // to hand to render code, no Automerge proxies to worry about.
  //
  // When `others` is non-empty (author viewing all readers' blobs), the
  // snapshot is computed from a transient merge of `doc` + every other
  // doc. Automerge merges are O(n) in the change count, so for K
  // readers we pay K merges per snapshot — fine at our scale (single-
  // digit threads per post). If snapshot ever shows up in a flame
  // graph, cache the merged doc and invalidate on doc / others changes.
  //
  // CRITICAL: `Automerge.merge(local, remote)` mutates local's state
  // and marks it "outdated" (see implementation.js → progressDocument).
  // If we merged into `this.doc` directly, the next `change()` call
  // would throw "Attempting to change an outdated document". Clone
  // first so the original stays writable; the clone is throwaway.
  // Skip the clone on the reader path (no `others`) for the obvious
  // savings.
  snapshot(): Thread[] {
    if (this.cachedSnapshot !== null) return this.cachedSnapshot;
    let merged: Doc<CommentDoc> = this.doc;
    if (this.others.size > 0) {
      merged = this.automerge.clone(this.doc);
      for (const other of this.others.values()) {
        merged = this.automerge.merge(merged, other);
      }
    }
    const js = this.automerge.toJS(merged) as CommentDoc;

    // Group replies by their parent threadId so the per-thread
    // assembly below is O(1) per thread. The threadId field is
    // internal — strip it back out so the public `Reply` shape stays
    // clean for UI consumers.
    const repliesByThread = new Map<string, Reply[]>();
    for (const stored of Object.values(js.replies)) {
      const { threadId, ...reply } = stored;
      const arr = repliesByThread.get(threadId);
      if (arr) arr.push(reply);
      else repliesByThread.set(threadId, [reply]);
    }

    const out: Thread[] = [];
    for (const id of Object.keys(js.threads)) {
      const t = js.threads[id]!;
      // Defensive: a thread written before the Web Annotation migration
      // (the `anchor` shape, not `target`) still applies cleanly to the
      // doc — the seed didn't change — but has no `target`. Rather than
      // crash the whole comment system on one stale blob, drop it. This
      // is the documented breaking change (methodology.md → "WA target
      // model"): pre-migration comments don't survive.
      if (!t.target) continue;
      const replies = (repliesByThread.get(id) ?? []).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      out.push({
        id,
        target: t.target,
        replies,
        createdAt: t.createdAt,
        ...(t.resolvedAt !== undefined && { resolvedAt: t.resolvedAt }),
        ...(t.suggestion !== undefined && { suggestion: t.suggestion }),
      });
    }
    // Replies not matched to any thread (e.g. the author replied to a
    // foreign thread but hasn't merged the foreign blob in yet, or the
    // referenced thread was deleted) are silently dropped from the
    // snapshot — they're still in the doc, so they'll surface again
    // once their thread is visible. No need to handle them here.
    this.cachedSnapshot = out.sort((a, b) => a.createdAt - b.createdAt);
    return this.cachedSnapshot;
  }

  // True iff the thread lives in *our own* doc (we created it as the
  // original commenter), as opposed to a foreign thread we only see
  // via the author-side aggregator. Used by the UI to decide whether
  // a Resolve action should write back through `resolveThread()`
  // (own-thread → CommentStore) or through the per-post resolutions
  // store (foreign-thread → author action).
  ownsThread(threadId: string): boolean {
    return (this.doc as CommentDoc).threads[threadId] !== undefined;
  }

  // ---------- Mutations ----------

  addThread(
    threadId: string,
    target: Target,
    createdAt: number,
    suggestion?: Suggestion,
  ): void {
    this.mutate("add thread", (d) => {
      // Target (and the suggestion payload) are structurally cloned into
      // the doc so future change ops see a stable reference; we never
      // mutate them afterwards. The suggestion is immutable-after-create.
      d.threads[threadId] = {
        target: structuredClone(target),
        createdAt,
        ...(suggestion && { suggestion: structuredClone(suggestion) }),
      };
    });
  }

  // Always succeeds, regardless of whether the thread is in our own
  // doc, in another reader's blob (visible via the aggregator), or
  // even unknown right now (the reply just doesn't surface until its
  // thread does). The flat replies map means we never have to "find
  // the parent" to add the reply, which is what makes
  // author-on-foreign-thread replies work without the
  // create-the-same-parent CRDT conflict.
  addReply(threadId: string, reply: Reply): void {
    this.mutate("add reply", (d) => {
      d.replies[reply.id] = { ...reply, threadId };
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
      const r = d.replies[replyId];
      if (!r) return;
      // Tombstone is immutable once set — re-stamping would invent a
      // bogus "later delete" event during CRDT merge and confuse any
      // future audit / undo flow that keys off the original timestamp.
      if (r.deletedAt !== undefined) return;
      r.deletedAt = deletedAt;
      // Atomic auto-resolve: if no visible replies remain on a thread
      // *we own*, the thread is a dead record on our side — bundle the
      // resolve into the same op. Skip when the thread isn't in our
      // doc (foreign thread, owned by another reader) — we don't have
      // authority to resolve it; tombstoning the reply is enough.
      const t = d.threads[threadId];
      if (!t || t.resolvedAt !== undefined) return;
      let liveCount = 0;
      for (const candidate of Object.values(d.replies)) {
        if (candidate.threadId !== threadId) continue;
        if (candidate.deletedAt !== undefined) continue;
        liveCount++;
      }
      if (liveCount === 0) {
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

  // Merge a remote copy of *this user's own* doc into local — used by
  // tests + the localStorage path (where we serialize/deserialize the
  // whole doc, not individual changes). Internally decomposes into
  // individual changes and routes through `applyOwnChanges` so the
  // server-protocol path and the local-state path share one
  // implementation. Persists immediately. Does NOT fire onChange —
  // this is a sync-driven merge, not a user write.
  mergeBytes(remoteBytes: Uint8Array): void {
    const remoteDoc = this.automerge.load<CommentDoc>(remoteBytes);
    this.applyOwnChanges(this.automerge.getAllChanges(remoteDoc));
  }

  // Merge another *reader's* full saved doc into the read-only
  // composite — convenience wrapper around `applyOtherChanges`. Used
  // by tests; the production aggregator uses `applyOtherChanges`
  // directly with per-change bytes.
  mergeOther(userId: string, remoteBytes: Uint8Array): void {
    const remoteDoc = this.automerge.load<CommentDoc>(remoteBytes);
    this.applyOtherChanges(userId, this.automerge.getAllChanges(remoteDoc));
  }

  // ---------- Per-change sync surface ----------
  //
  // These are the methods the new (B) sync layer actually uses. They
  // operate on individual Automerge change-bytes (the unit
  // `Automerge.getChanges` / `applyChanges` work with), so the wire
  // protocol can store one change per R2 object without ever needing
  // the server to understand the doc.

  // Apply a batch of changes to our own doc. Used by the sync layer
  // on hydrate (fetching changes from the server that other devices
  // of ours uploaded). Does NOT fire onChange — these changes are
  // already on the server; re-pushing would loop.
  applyOwnChanges(changes: Uint8Array[]): void {
    if (changes.length === 0) return;
    [this.doc] = this.automerge.applyChanges(this.doc, changes);
    this.cachedSnapshot = null;
    this.cachedLocalChanges = null;
    this.persist();
  }

  // Apply a batch of changes to a specific other-user's doc. Used by
  // the author-only aggregator. Lazily initializes the other-doc
  // from the shared seed on first call — having both sides start
  // from the same seed is what makes the merge in `snapshot()`
  // conflict-free.
  applyOtherChanges(userId: string, changes: Uint8Array[]): void {
    const existing = this.others.get(userId);
    // Nothing to apply and nothing already loaded → don't materialize an
    // empty seed doc for a reader we have no content for.
    if (!existing && changes.length === 0) return;
    // Existing doc, no new changes → state is unchanged; skip the
    // re-persist + cache churn (the zero-delta reload/poll path).
    if (existing && changes.length === 0) return;

    let otherDoc = existing ?? this.automerge.load<CommentDoc>(
      getSeedBytes(this.automerge),
    );
    [otherDoc] = this.automerge.applyChanges(otherDoc, changes);
    this.others.set(userId, otherDoc);
    this.persistOther(userId, otherDoc);
    // Only the merged-view cache + this user's foreign bytes depend on
    // `others`; local-changes is computed from `this.doc` alone and
    // stays valid.
    this.cachedSnapshot = null;
    this.foreignBytesCache.delete(userId);
  }

  // Persist one reader's merged doc + record them in the per-post index,
  // so a later `CommentStore.create` re-hydrates the aggregate. Best-
  // effort: a storage failure just means the next load re-pulls from R2.
  private persistOther(userId: string, doc: Doc<CommentDoc>): void {
    try {
      const bytes = this.automerge.save(doc);
      localStorage.setItem(
        otherDocKey(this.postPath, userId),
        bytesToBase64(bytes),
      );
      const k = othersIndexKey(this.postPath);
      let ids: string[] = [];
      const raw = localStorage.getItem(k);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) ids = parsed.filter((v) => typeof v === "string");
        } catch {
          /* corrupt index — rebuild from this user */
        }
      }
      if (!ids.includes(userId)) {
        ids.push(userId);
        localStorage.setItem(k, JSON.stringify(ids));
      }
    } catch (err) {
      console.warn(`Failed to persist foreign comment doc for ${userId}:`, err);
    }
  }

  // hash -> change-bytes for one reader's doc (cached, invalidated per
  // user on apply). Drives both the aggregator's delta check and origin
  // derivation without re-fetching anything from the server.
  private foreignChangeBytes(userId: string): Map<string, Uint8Array> {
    const cached = this.foreignBytesCache.get(userId);
    if (cached) return cached;
    const map = new Map<string, Uint8Array>();
    const doc = this.others.get(userId);
    if (doc) {
      for (const bytes of this.automerge.getAllChanges(doc)) {
        map.set(this.automerge.decodeChange(bytes).hash, bytes);
      }
    }
    this.foreignBytesCache.set(userId, map);
    return map;
  }

  // Change hashes the store already holds for one reader — the set the
  // aggregator diffs the server LIST against, so a reload (where the doc
  // came back from localStorage) re-GETs nothing.
  foreignChangeHashes(userId: string): Set<string> {
    return new Set(this.foreignChangeBytes(userId).keys());
  }

  // ---------- Origin provenance (which live store a reply was born in) ----------
  //
  // The server's LIST entries may carry per-BLOB origin metadata (written
  // by the seeding CLI when it copies production blobs into the dev store
  // — see server/comments/store.ts → ChangeOrigin). Origin is per-blob, so
  // per-REPLY — a single thread can mix origins (a prod-born thread
  // carrying the author's localhost scaffolding replies) — which is why
  // there is no thread-level origin here. Attribution is derived fresh on
  // every boot via `deriveOrigins` (the sync layer and the author
  // aggregator feed the results in), never persisted: it's a fact of the
  // server's data. ONE uniform rule, no environment branches: a store
  // whose blobs carry no metadata (prod today) never satisfies
  // `hasSeededOrigins`, so no tags ever render there.

  /**
   * Where the reply was born, or null when derivation didn't cover it
   * (not on the server yet, or the derivation pass failed) — null is
   * "unknown", deliberately distinct from "local".
   */
  replyOrigin(replyId: string): "production" | "local" | null {
    if (this.productionReplies.has(replyId)) return "production";
    if (this.localReplies.has(replyId)) return "local";
    return null;
  }

  /**
   * True when this view contains at least one production-born reply —
   * the render gate for origin tags. Tags carry information only where
   * origins MIX; on a single-origin store (prod, or a never-seeded dev
   * post) every tag would say the same thing, so none are shown. Data-
   * derived, not an environment check.
   */
  hasSeededOrigins(): boolean {
    return this.productionReplies.size > 0;
  }

  addReplyOrigins(production: string[], local: string[]): void {
    for (const id of production) this.productionReplies.add(id);
    for (const id of local) this.localReplies.add(id);
  }

  // Derive per-reply origin provenance for one scope — our own doc
  // (`userId === null`) or a single reader's doc — from the server's
  // per-blob origin tags (the `entries` LIST). Reads bytes the store
  // ALREADY holds (own changes / the aggregated foreign doc), so it never
  // hits the network: production reply ids come from replaying just the
  // production-tagged changes into a throwaway doc; the full reply set
  // comes straight from the live doc, keeping `local = full − production`
  // dep-complete (a local reply whose change depends on prod changes still
  // attributes correctly). Provenance is a fact of the server's data, so
  // it's re-derived per boot, never persisted (see productionReplies).
  //
  // Dev-only by construction: a folder whose blobs carry no origin tags
  // (prod today, and any never-seeded dev post) returns before doing any
  // work. Memoized on the production-tag set, so a 60s poll re-deriving an
  // unchanged folder costs nothing.
  async deriveOrigins(
    entries: Array<{ hash: string; origin?: string }>,
    userId: string | null,
  ): Promise<void> {
    const prodHashes = entries
      .filter((e) => e.origin === "production")
      .map((e) => e.hash);
    if (prodHashes.length === 0) return;

    const scope = userId ?? "";
    const sig = prodHashes.slice().sort().join(",");
    if (this.derivedProdSig.get(scope) === sig) return;

    const byHash =
      userId === null
        ? new Map(this.getAllLocalChanges().map((c) => [c.hash, c.bytes]))
        : this.foreignChangeBytes(userId);
    const prodBytes = prodHashes
      .map((h) => byHash.get(h))
      .filter((b): b is Uint8Array => b !== undefined);
    const prodIds = await replayReplyIds(prodBytes);
    const prod = new Set(prodIds);
    this.addReplyOrigins(
      prodIds,
      this.replyIds(userId).filter((id) => !prod.has(id)),
    );
    this.derivedProdSig.set(scope, sig);
  }

  // Reply ids present in a scope's live doc (own, or one reader's). The
  // full, dep-complete set origin derivation diffs the production subset
  // against.
  private replyIds(userId: string | null): string[] {
    const doc = userId === null ? this.doc : this.others.get(userId);
    if (!doc) return [];
    const js = this.automerge.toJS(doc) as CommentDoc;
    return Object.keys(js.replies);
  }

  // Returns every change in our doc, paired with its hash. The sync
  // layer uses this to decide what to upload (set-diff against the
  // hashes it knows are already on the server). Hashes are derived
  // via `Automerge.decodeChange` — a pure function of the bytes —
  // so we cache the (bytes, hash) list and invalidate on every
  // mutation. Without the cache, every push call re-decodes the
  // entire history.
  getAllLocalChanges(): Array<{ hash: string; bytes: Uint8Array }> {
    if (this.cachedLocalChanges !== null) return this.cachedLocalChanges;
    const out: Array<{ hash: string; bytes: Uint8Array }> = [];
    for (const bytes of this.automerge.getAllChanges(this.doc)) {
      const hash = this.automerge.decodeChange(bytes).hash;
      out.push({ hash, bytes });
    }
    this.cachedLocalChanges = out;
    return out;
  }

  // ---------- Internals ----------

  private mutate(action: string, fn: (d: CommentDoc) => void): void {
    this.doc = this.automerge.change(this.doc, action, fn);
    this.cachedSnapshot = null;
    this.cachedLocalChanges = null;
    this.persist();
    // Notify the sync layer (if any) AFTER persist completes — even if
    // the network push fails the next reload picks up where we left off.
    this.onChange?.();
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

// Reply ids present after replaying `blobs` against the shared seed in a
// throwaway doc. The production-subset replay primitive behind
// `CommentStore.deriveOrigins` (production blobs are dep-closed — a
// production-born change never depends on a localhost-born one — so the
// subset applies cleanly on its own).
async function replayReplyIds(blobs: Uint8Array[]): Promise<string[]> {
  if (blobs.length === 0) return [];
  const automerge = await loadAutomerge();
  let doc = automerge.load<CommentDoc>(getSeedBytes(automerge));
  [doc] = automerge.applyChanges(doc, blobs);
  const js = automerge.toJS(doc) as CommentDoc;
  return Object.keys(js.replies);
}
