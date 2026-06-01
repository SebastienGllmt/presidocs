// Comments: Google-Docs-style threads in a right-margin column, anchored
// to text selections (in the article body OR the spoken-script drawer) or
// to whole graphics. Persistence + merge live in `commentsStore.ts`,
// which wraps an Automerge document. This file is purely the UI layer.
//
// Why a column instead of a floating popover
// ------------------------------------------
// Multiple threads can target the same selection (e.g., two readers leave
// independent comments on the same sentence). A single floating popover
// can only display one thread at a time and clicks on overlapping
// highlight spans only ever resolve to the innermost — so any thread
// underneath becomes unreachable. The cards-in-a-column layout makes every
// thread visible at once and removes the disambiguation problem entirely.
//
// Text anchoring strategy
// -----------------------
// Every paragraph-level element inside a commentable root is a "segment".
// Each segment has a stable id (its DOM id if present, otherwise a
// synthesized `__b-<n>` index) and a sha256 of its normalized text content.
// A text anchor stores the *list* of segments the selection touches plus
// character offsets within the first and last segment. On render we re-hash
// each segment and mark the thread `outdated` when any hash mismatches —
// matching the "orphan + flag" preference.
//
// Graphic anchoring is far simpler: just the element id. The content of a
// graphic isn't text, so there's nothing to hash; if the graphic is
// replaced (same id, new contents) the comment intentionally follows.

import {
  CommentStore,
  isResolved,
  isDeleted,
  visibleReplies,
  isTextTarget,
  contextOf,
  makeTextTarget,
  makeGraphicTarget,
  textTargetParts,
  graphicTargetId,
  type Context,
  type Reply,
  type Target,
  type Thread,
} from "./commentsStore.ts";
import {
  loadIdentity,
  loginUrl,
  signOut,
  type Identity,
} from "./identity.ts";
import { CommentSync } from "./commentsSync.ts";
import {
  aggregateOtherReaders,
  newAggregatorState,
} from "./commentsAggregator.ts";
import { CommentPolling } from "./commentsPolling.ts";
import { ResolutionStore } from "./resolutionsStore.ts";
import type { ResolutionEnvelope } from "./resolutionsApi.ts";
import {
  fetchPostVersion,
  getLastSeenVersion,
  setLastSeenVersion,
  type PostVersionResponse,
} from "./postVersion.ts";
import { DraftsStorage } from "./draftsStorage.ts";
import { compareSegmentHashes } from "./commentsStale.ts";
import {
  BLOCK_TAGS,
  computePopoverPositionForRect,
  loadHighlightsHidden,
  normalizeText,
  saveHighlightsHidden,
  walkBlocks,
} from "./commentsDom.ts";

type BlockInfo = {
  id: string;
  element: HTMLElement;
  context: Context;
  hash: string;
  text: string;
};

// BLOCK_TAGS, normalizeText, walkBlocks are imported from ./commentsDom.ts
// — extracting them gave the indexer's leaf-tag set, whitespace rule, and
// document-order walker a place to be tested without instantiating the
// whole CommentSystem.

// v1: only `<figure>` is a commentable graphic. The authoring convention
// (per methodology.md) wraps each graphic in a figure with an id, and that
// lets us attach an HTML button child without worrying about SVG namespace
// or `<img>` being a void element. Standalone <svg>/<img>/<canvas> would
// need a wrapper before we could place the trigger; we can add that later.
const GRAPHIC_ROOT_TAGS = new Set(["FIGURE"]);

// Cards stack with this much vertical space between them when collision-
// avoidance pushes a later card past its preferred anchor-aligned top.
const CARD_GAP_PX = 8;
// Extra gap kept between the lowest card's bottom and the player dock
// when reserving bottom scroll room, so a bottom card never sits flush
// against the dock.
const BOTTOM_CLEARANCE_PX = 24;

// Below this viewport width the column doesn't fit alongside the
// article. We switch to a popover model: cards are rendered into the
// column DOM as usual, but CSS hides them by default and only the
// `data-mobile-active`-tagged card pops up as a fixed overlay.
const MOBILE_BREAKPOINT_PX = 1099;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function offsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  if (node === block) {
    let total = 0;
    for (let i = 0; i < offset && i < block.childNodes.length; i++) {
      total += (block.childNodes[i]?.textContent ?? "").length;
    }
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n === node) return total + offset;
    total += (n.nodeValue ?? "").length;
  }
  return block.textContent?.length ?? 0;
}

function nodeAtOffset(
  block: HTMLElement,
  charOffset: number,
): { node: Node; offset: number } | null {
  let remaining = charOffset;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.nodeValue?.length ?? 0;
    if (remaining <= len) return { node: n, offset: remaining };
    remaining -= len;
  }
  let last: Text | null = null;
  const w2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (w2.nextNode()) last = w2.currentNode as Text;
  if (last) return { node: last, offset: last.nodeValue?.length ?? 0 };
  return null;
}

function findBlockFor(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  if (!el) return null;
  return (el as Element).closest<HTMLElement>("[data-comment-block-id]");
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const min = 60_000;
  if (diff < min) return "just now";
  if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

class CommentSystem {
  private articleRoot: HTMLElement | null = null;
  // `drawerRoot` is set when the narrator drawer is detected. Threads in
  // the drawer index against this root; if the drawer never appears
  // (manifest missing) we still work on the article alone.
  private drawerRoot: HTMLElement | null = null;

  // Logged-in user, or null when not authenticated. The UI gates every
  // comment-creation path on this being non-null. Loaded once at boot
  // from /auth/me; not refreshed mid-session (an expired cookie at
  // mid-session falls back to "still appears logged in locally," which is
  // harmless given comments only write to localStorage in v1).
  private identity: Identity | null = null;

  // The CRDT store owns persistence + merge semantics. `snapshot` is a
  // cached plain-JSON view of the store's threads, refreshed after every
  // mutation. The UI reads from `snapshot`; mutations route through the
  // store. Stays null when not logged in — the store is keyed by user id,
  // so we can't create it until identity is known.
  private store: CommentStore | null = null;
  private snapshot: Thread[] = [];

  // Owns the network push/pull for the logged-in user's blob. Lives
  // alongside the store so a single mutation triggers persist (in the
  // store) and a server PUT (here). Null when not logged in.
  private sync: CommentSync | null = null;

  // Per-foreign-user known-hash cache used by the aggregator. Hoisted
  // to a class field (was a local in the original boot block) so the
  // polling loop can reuse the same state across refreshes — without
  // it every poll would re-GET every change-object for every reader
  // instead of just the new ones.
  private aggState = newAggregatorState();

  // Visibility-gated periodic polling. Re-runs hydrate (own user) and
  // the aggregator (author only) on a fixed interval while the tab is
  // focused. Null when not logged in.
  private polling: CommentPolling | null = null;

  // Per-post resolutions doc — author-only writes, all-logged-in
  // reads. Threads marked as resolved here are filtered out of the
  // render alongside threads with their own resolvedAt timestamp.
  // Hydrate-and-poll like the CommentStore. Null when not logged in.
  private resolutions: ResolutionStore | null = null;

  // Document-version state. The current SHA-256 of the post HTML
  // and (for the author) the history of past hashes. Set once on
  // boot; the "your comments may no longer apply" banner is rendered
  // when the previously-stored last-seen hash differs from the
  // server's currentHash.
  private docVersion: PostVersionResponse | null = null;
  private previousVersionHash: string | null = null;
  private versionBannerEl: HTMLElement | null = null;
  private versionHistoryEl: HTMLElement | null = null;
  // Author-only at-a-glance unresolved-thread count. Lives in the
  // column header alongside the version history so the author can see
  // "are there comments I haven't dealt with yet?" without scrolling
  // the post. Clicking it cycles through the unresolved threads in
  // document order. Re-rendered on every renderAll() so polls and
  // mutations keep it current.
  private unresolvedCountEl: HTMLButtonElement | null = null;
  // Index into the document-order list of unresolved threads, used so
  // repeated clicks on the badge step through them rather than
  // re-snapping to the same one. Reset whenever the underlying set
  // shifts (resolved, deleted, …) so we don't index off the end.
  private unresolvedCycleIndex = 0;
  private lastUnresolvedIds: string[] = [];

  // Below the mobile breakpoint, cards render as fixed-position
  // overlays (popovers) rather than as a stacked column. Tracked
  // via a `MediaQueryList` listener so a window resize across the
  // breakpoint flips the layout live.
  private isMobile = false;
  // Mobile-only: id of the thread/draft currently displayed as the
  // popover. Null when nothing is open. Switches on highlight /
  // graphic-indicator tap and on draft creation; cleared on
  // tap-outside.
  private activeCardId: string | null = null;
  // Mobile-only: viewport-relative position chosen for the popover
  // at the moment the user opened it. Re-applied after every render
  // (a poll-driven `renderAll` rebuilds the card element and would
  // otherwise drop the inline styles). Stays in viewport coordinates
  // — the popover is `position: fixed` so it deliberately doesn't
  // scroll with the anchor.
  private activeMobilePosition: {
    top?: string;
    bottom?: string;
    maxHeight: string;
  } | null = null;
  // Floating button (mobile-only) that toggles visibility of all
  // highlights + indicators + popovers. State mirrored on
  // `body.cmt-highlights-hidden`.
  private hideAllFab: HTMLButtonElement | null = null;
  private highlightsHidden = false;

  // Desktop-only: id of the thread most recently focused via a
  // highlight or graphic-indicator click. A second consecutive click
  // on the same anchor toggles its card hidden. Reset on explicit
  // Hide/Resolve/Cancel, on clicks that brought a hidden card back
  // (so the user gets one tap to navigate before the next would
  // re-hide), and on focusing a different anchor.
  private lastFocusedThreadId: string | null = null;

  // Header in the column showing "Signed in as ..." or the login pane
  // when not authenticated. Rendered once at init, re-rendered on
  // identity change (currently only at boot).
  private identityHeader: HTMLElement | null = null;
  // Drafts — a freshly composed thread that the user hasn't submitted
  // yet. Promoted to the store on first reply, removed on Cancel.
  // Deliberately not in the CRDT: drafts shouldn't sync to a server
  // (or to the user's other devices) until the user commits. They DO
  // persist to localStorage so closing the tab doesn't lose work; see
  // `draftsStorage` and `draftBodies` below for the per-textarea
  // body-of-typing buffer that pairs with each draft thread.
  private drafts: Thread[] = [];
  // In-progress textarea contents for each draft, keyed by thread id.
  // Updated on every keystroke (via the `input` event) and persisted
  // alongside `drafts`. Carries through reloads so the user sees their
  // half-typed comment when they come back.
  private draftBodies = new Map<string, string>();
  // Persistence handle for `drafts` + `draftBodies`. Null until identity
  // is loaded — the storage key embeds the userId so we can't construct
  // it before login, matching how `CommentStore` is scoped.
  private draftsStorage: DraftsStorage | null = null;
  // Thread ids whose card the user has temporarily hidden via "Cancel".
  // Session-only (deliberately not persisted) — a reload brings every
  // card back, so you can't accidentally lose track of comments by
  // hiding them all and forgetting. Restored by clicking the anchor's
  // highlight (text) or graphic indicator (figures).
  private hiddenCardIds = new Set<string>();

  private blocksByContext = new Map<Context, BlockInfo[]>();
  private blocksById = new Map<string, BlockInfo>();
  private graphicsById = new Map<string, HTMLElement>();

  // The right-margin column hosting all cards. One card per thread/draft.
  private column: HTMLElement | null = null;
  // Invisible flow element appended to <body> that grows just enough to
  // give scroll room below the lowest comment card, so a card can always
  // be scrolled clear of the viewport-fixed player dock (see
  // repositionCards). 0 height when not needed.
  private bottomSpacer: HTMLElement | null = null;
  // See mountColumn — measures the column's positioning origin so card
  // tops align with their anchors instead of sitting lower.
  private columnProbe: HTMLElement | null = null;
  private cardEls = new Map<string, HTMLElement>();

  // Floating "Comment" pill that appears above a text selection.
  private actionBar: HTMLDivElement | null = null;
  private pendingRange: Range | null = null;
  private pendingStartBlock: BlockInfo | null = null;
  private pendingEndBlock: BlockInfo | null = null;

  // Set while a card is being scrolled-to / pulsed, used to suppress the
  // reposition pass from fighting the smooth-scroll.
  private pulseTimer = 0;

  async init() {
    this.articleRoot = document.querySelector<HTMLElement>(
      "[data-narration-src]",
    );
    if (!this.articleRoot) return;

    await this.indexArticle();

    // The narrator drawer is appended asynchronously after fetching the
    // manifest. Watch for it; if it never arrives, commenting still works
    // on the article alone.
    const existing = document.querySelector<HTMLElement>(".narrate-drawer");
    if (existing) {
      await this.indexDrawer(existing);
    } else {
      const obs = new MutationObserver(async () => {
        const d = document.querySelector<HTMLElement>(".narrate-drawer");
        if (d) {
          obs.disconnect();
          await this.indexDrawer(d);
          this.renderAll();
        }
      });
      obs.observe(document.body, { childList: true, subtree: false });
    }

    // Load identity first — the comment store is keyed on user id, so
    // without a logged-in user there's nothing to load.
    this.identity = await loadIdentity();

    this.mountColumn();
    this.mountActionBar();
    this.mountHideAllFab();
    this.installGraphicTriggers();
    this.renderIdentityHeader();

    // Track mobile mode via a MediaQueryList. The `change` event
    // fires whenever the viewport crosses the breakpoint (resize,
    // orientation change, devtools-toggle, …). On crossing we drop
    // any active popover (it'd be visually nonsense in the column
    // layout) and re-run layout.
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    this.isMobile = mql.matches;
    mql.addEventListener("change", (e) => {
      this.isMobile = e.matches;
      if (!this.isMobile) this.setActiveCard(null);
      this.repositionCards();
    });

    if (this.identity) {
      // Spin up the CRDT-backed store. This is the only place we await
      // Automerge's WASM load — once `create()` returns the store is
      // fully hydrated and all UI handlers can safely call its mutation
      // methods.
      const postPath = window.location.pathname;
      this.store = await CommentStore.create(postPath, this.identity.userId);

      // Drafts persist to localStorage under a (post, user) key so a
      // half-typed comment survives reloads. Loaded synchronously since
      // localStorage reads are cheap; the in-memory Thread + body
      // structures are restored before the first render so the cards
      // appear immediately rather than popping in after.
      this.draftsStorage = new DraftsStorage(postPath, this.identity.userId);
      for (const entry of this.draftsStorage.load()) {
        this.drafts.push(entry.thread);
        if (entry.body) this.draftBodies.set(entry.thread.id, entry.body);
      }

      // Wire up the network sync. `onChange` is set BEFORE `hydrate`
      // so a user write that lands during the initial GET also queues
      // a push (it'll serialize behind hydrate on the sync layer's
      // internal chain). Wiring after hydrate caused a real bug: a
      // first-ever comment submitted in the ~ms window of the initial
      // pull would persist to localStorage but never reach the server,
      // since `onChange` was null at mutation time and `hydrate` itself
      // only pulled — never pushed back any pre-existing local state.
      this.sync = new CommentSync(this.store, postPath, this.identity.userId);
      this.store.onChange = () => this.sync?.requestSync();
      try {
        await this.sync.hydrate();
      } catch (err) {
        // A missing/failed pull is non-fatal — we still have the
        // localStorage snapshot to render from. The post-hydrate
        // requestSync (inside hydrate itself) will surface any
        // persistent push error in the console.
        console.warn("comment hydrate failed:", err);
      }

      // Document version + server-authoritative author flag. Fetched
      // here (before the aggregator decision) because `docVersion.
      // isAuthor` is what every author-only branch downstream gates
      // on. Failures degrade gracefully — `isAuthorMode()` defaults
      // to false, suppressing aggregator + author-resolve + history.
      await this.initDocVersion(postPath);

      // Author-only: also pull every other reader's blob and merge into
      // the read-only composite so the snapshot includes everyone. Done
      // after hydrate so the first render still shows the author's own
      // comments even if a slow reader fan-out is in flight.
      if (this.isAuthorMode()) {
        aggregateOtherReaders(
          this.store,
          postPath,
          this.identity.userId,
          this.aggState,
        )
          .then(() => this.refreshSnapshotAndRender())
          .catch((err) => console.warn("aggregate failed:", err));
      }

      // Resolutions store: parallel to CommentStore but per-post
      // (not per-user). Hydrate before the first render so any
      // already-resolved threads stay hidden on boot rather than
      // flickering in and then out on the first poll. Re-renders
      // are wired through the same path as comment mutations.
      this.resolutions = new ResolutionStore(postPath);
      this.resolutions.onChange = () => this.refreshSnapshotAndRender();
      try {
        await this.resolutions.hydrate();
      } catch (err) {
        console.warn("resolutions hydrate failed:", err);
      }

      this.snapshot = this.store.snapshot();

      // Start the polling loop. Each tick re-runs the same hydrate +
      // aggregate (if author) the boot path just ran, so foreign
      // writes that landed while we were idle appear without a
      // reload. The poll callback is the only thing that re-renders
      // post-boot; the store's onChange wiring still handles
      // local-mutation re-renders synchronously.
      this.polling = new CommentPolling(() => this.pollOnce(postPath));
    }

    this.renderAll();

    document.addEventListener("selectionchange", () => this.onSelectionChange());
    document.addEventListener("click", (e) => this.onAnyClick(e));
    window.addEventListener("scroll", () => this.repositionCards(), {
      passive: true,
    });
    window.addEventListener("resize", () => {
      this.repositionCards();
      if (this.pendingRange && this.actionBar && !this.actionBar.hidden) {
        this.showActionBarFor(this.pendingRange);
      }
    });

    // Brighten the logged-out sign-in CTA once the reader scrolls past a
    // small threshold — the engagement signal the CSS dim-by-default is
    // waiting for. One-shot: removes itself once fired, and skipped
    // entirely for signed-in readers (the card isn't a CTA for them).
    // If the page loads already scrolled (deep-link to a #anchor),
    // reveal immediately so the card doesn't look broken.
    if (!this.identity) {
      const revealThreshold = 200;
      const reveal = () => {
        if (window.scrollY < revealThreshold) return;
        document.body.classList.add("cmt-identity-revealed");
        window.removeEventListener("scroll", reveal);
      };
      if (window.scrollY >= revealThreshold) {
        document.body.classList.add("cmt-identity-revealed");
      } else {
        window.addEventListener("scroll", reveal, { passive: true });
      }
    }
  }

  // ===== Indexing =====

  private async indexArticle() {
    if (!this.articleRoot) return;
    await this.indexRoot(this.articleRoot, "article");
  }

  private async indexDrawer(drawer: HTMLElement) {
    this.drawerRoot = drawer;
    await this.indexRoot(drawer, "narration");
  }

  private async indexRoot(root: HTMLElement, context: Context) {
    const blocks: BlockInfo[] = [];
    let counter = 0;
    for (const el of walkBlocks(root, BLOCK_TAGS)) {
      // In the narration drawer the walker stops at the <li> wrapping each
      // segment (LI is a block tag), but that <li> also holds the play
      // button whose <time> clock ("0:11") would otherwise leak into the
      // block's text, hash, offsets, and quote. Re-target to the inner
      // spoken-text <p> so anchors cover only the spoken words. No-op
      // outside the drawer — article blocks have no .spoken-text child.
      const block = el.querySelector<HTMLElement>(".spoken-text") ?? el;
      const stableId = block.id && block.id.length > 0
        ? `id:${block.id}`
        : `${context}:__b-${counter}`;
      block.dataset.commentBlockId = stableId;
      block.dataset.commentContext = context;
      const text = block.textContent ?? "";
      const hash = await sha256(normalizeText(text));
      const info: BlockInfo = { id: stableId, element: block, context, hash, text };
      blocks.push(info);
      this.blocksById.set(stableId, info);
      counter++;
    }
    let gCounter = 0;
    for (const el of walkBlocks(root, GRAPHIC_ROOT_TAGS)) {
      const stableId = el.id && el.id.length > 0
        ? `id:${el.id}`
        : `${context}:__g-${gCounter}`;
      el.dataset.commentGraphicId = stableId;
      el.dataset.commentContext = context;
      this.graphicsById.set(stableId, el);
      gCounter++;
    }
    this.blocksByContext.set(context, blocks);
  }

  // ===== Document version =====

  // Server-authoritative "is the current user the post's author?"
  // signal. Sourced from the /post-version response so the answer
  // works in prod (where the source-only <meta name="author-email">
  // tag is stripped from served HTML and a DOM-based check would
  // return false). False until docVersion has been fetched; if the
  // fetch fails we stay non-author, which is the safe default.
  private isAuthorMode(): boolean {
    return this.docVersion?.isAuthor ?? false;
  }

  // One-shot at boot: fetch the post's current hash + (author-only)
  // history, compare to the last hash this user saw, and mount the
  // banner / history UI accordingly. Failures degrade gracefully —
  // a missing endpoint or rejected response just means no banner.
  private async initDocVersion(postPath: string) {
    const version = await fetchPostVersion(postPath);
    if (!version) return;
    this.docVersion = version;

    const lastSeen = getLastSeenVersion(postPath);
    // Banner only when the user has been here before AND the hash
    // changed. First-ever visits don't show the banner (there's
    // nothing to compare against).
    if (lastSeen && lastSeen !== version.currentHash) {
      this.previousVersionHash = lastSeen;
    }
    // Bump last-seen immediately — the banner gets one render-cycle
    // of visibility, the user notices, and on next reload it's gone.
    // Persisting on dismiss-only would risk users missing the
    // banner if they re-open the page in two tabs.
    setLastSeenVersion(postPath, version.currentHash);

    this.renderVersionUI();
  }

  // (Re-)mount the banner + history elements. Idempotent — wipes
  // and replaces. Cards live in the same column but in absolute
  // positioning, so the inserted-after-header pattern doesn't
  // disturb their layout (we account for the inserted heights in
  // `repositionCards`).
  private renderVersionUI() {
    if (!this.column) return;
    this.versionBannerEl?.remove();
    this.versionBannerEl = null;
    this.versionHistoryEl?.remove();
    this.versionHistoryEl = null;

    let insertAfter: Element | null = this.identityHeader;

    if (this.previousVersionHash && this.docVersion) {
      const banner = document.createElement("div");
      banner.className = "cmt-version-banner";
      banner.setAttribute("role", "status");

      const text = document.createElement("p");
      text.className = "cmt-version-banner-text";
      text.textContent =
        "The post has been updated since your last visit. " +
        "Some comments may no longer apply.";
      banner.appendChild(text);

      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "cmt-version-banner-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        banner.remove();
        this.versionBannerEl = null;
        this.repositionCards();
      });
      banner.appendChild(dismiss);

      insertAfter!.after(banner);
      insertAfter = banner;
      this.versionBannerEl = banner;
    }

    if (this.docVersion?.history && this.docVersion.history.length > 0) {
      const details = document.createElement("details");
      details.className = "cmt-version-history";

      const summary = document.createElement("summary");
      summary.className = "cmt-version-history-summary";
      const count = this.docVersion.history.length;
      summary.textContent = `Document versions (${count})`;
      details.appendChild(summary);

      const list = document.createElement("ol");
      list.className = "cmt-version-history-list";
      for (const entry of this.docVersion.history) {
        const li = document.createElement("li");
        li.className = "cmt-version-history-item";
        const time = document.createElement("time");
        time.dateTime = entry.builtAt;
        time.textContent = new Date(entry.builtAt).toLocaleString();
        const hash = document.createElement("code");
        hash.className = "cmt-version-history-hash";
        hash.textContent = entry.hash.slice(0, 8);
        hash.title = entry.hash;
        const isCurrent = entry.hash === this.docVersion.currentHash;
        if (isCurrent) li.classList.add("cmt-version-history-current");
        li.appendChild(time);
        li.appendChild(document.createTextNode(" "));
        li.appendChild(hash);
        if (isCurrent) {
          const tag = document.createElement("span");
          tag.className = "cmt-version-history-tag";
          tag.textContent = "current";
          li.appendChild(document.createTextNode(" "));
          li.appendChild(tag);
        }
        list.appendChild(li);
      }
      details.appendChild(list);

      insertAfter!.after(details);
      this.versionHistoryEl = details;
    }

    this.repositionCards();
  }

  // Author-only at-a-glance counter of unresolved threads, mounted in
  // the column header. The intent is "did I miss any comments?"
  // surfacing — without it the author has to scroll the whole post to
  // be sure. Hidden for non-authors and when there's no thread at all
  // (a fresh post showing "0 unresolved" is just noise). When the post
  // has threads we keep it mounted even at 0 so the author sees the
  // explicit confirmation that everything's been dealt with. Clicks
  // cycle through the unresolved threads in document order.
  private renderUnresolvedCount() {
    if (!this.column) return;
    const author = this.isAuthorMode();
    const totalThreads = this.snapshot.length;
    if (!author || totalThreads === 0) {
      this.unresolvedCountEl?.remove();
      this.unresolvedCountEl = null;
      this.lastUnresolvedIds = [];
      this.unresolvedCycleIndex = 0;
      return;
    }

    const unresolved = this.snapshot.filter((t) => !this.threadIsResolved(t));
    const count = unresolved.length;

    if (!this.unresolvedCountEl) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmt-unresolved-count";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.jumpToNextUnresolved();
      });
      // Mount after the version history (when present), else after the
      // version banner, else after the identity header. Mirrors the
      // insertion order renderVersionUI uses so the column header reads
      // top-to-bottom: identity → banner → version history → unresolved.
      const insertAfter: Element =
        this.versionHistoryEl ?? this.versionBannerEl ?? this.identityHeader!;
      insertAfter.after(btn);
      this.unresolvedCountEl = btn;
    }

    const el = this.unresolvedCountEl;
    if (count === 0) {
      el.dataset.state = "clear";
      el.textContent = "All comments resolved";
      el.title = "No unresolved threads on this post";
      el.disabled = true;
    } else {
      el.dataset.state = "pending";
      el.textContent = `${count} unresolved comment${count === 1 ? "" : "s"}`;
      el.title = "Jump to the next unresolved comment";
      el.disabled = false;
    }
  }

  // Step through unresolved threads in document order on each click.
  // The set is recomputed every call (poll/mutation may have shifted
  // it) and the cycle index is reset whenever the membership changes
  // so we never index off the end.
  private jumpToNextUnresolved() {
    const ordered = this.snapshot
      .filter((t) => !this.threadIsResolved(t))
      .map((t) => ({ thread: t, top: this.computeAnchorTop(t) ?? Infinity }))
      .sort((a, b) => a.top - b.top)
      .map((x) => x.thread);
    if (ordered.length === 0) return;

    const ids = ordered.map((t) => t.id);
    const sameSet =
      ids.length === this.lastUnresolvedIds.length &&
      ids.every((id, i) => id === this.lastUnresolvedIds[i]);
    if (!sameSet) {
      this.lastUnresolvedIds = ids;
      this.unresolvedCycleIndex = 0;
    }

    const target = ordered[this.unresolvedCycleIndex % ordered.length]!;
    this.unresolvedCycleIndex =
      (this.unresolvedCycleIndex + 1) % ordered.length;

    // Surface the card if the author had previously hidden it, so
    // clicking the badge always brings them to something visible.
    if (this.hiddenCardIds.has(target.id)) {
      this.hiddenCardIds.delete(target.id);
      this.renderAll();
    }
    this.scrollAnchorIntoView(target);
    this.scrollCardIntoView(target.id);
  }

  // ===== Mobile popover + hide-all FAB =====

  // Set/clear the "currently visible popover" on mobile. A no-op on
  // desktop — the column layout shows every non-hidden card anyway.
  // Also unhides the card if the user had previously dismissed it
  // via "Hide", since on mobile there's no other way to bring it
  // back than tapping the highlight.
  private setActiveCard(threadId: string | null): void {
    if (this.activeCardId) {
      const prev = this.cardEls.get(this.activeCardId);
      if (prev) {
        prev.removeAttribute("data-mobile-active");
        this.clearMobileCardPosition(prev);
      }
    }
    this.activeCardId = threadId;
    this.activeMobilePosition = null;
    // Body class drives the mobile identity-bar hide while a popover
    // is open — keeps the top of the viewport clear when the popover
    // computes a placement near it.
    document.body.classList.toggle("cmt-mobile-popover-active", !!threadId);
    if (!threadId) return;
    if (this.hiddenCardIds.has(threadId)) {
      this.hiddenCardIds.delete(threadId);
      // Card was skipped on the previous render; rebuild so it
      // actually exists in `cardEls` before we tag it active.
      this.renderAll();
    }
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.setAttribute("data-mobile-active", "true");
    // Compute the popover's placement against the tapped anchor's
    // current rect. Done before focus() because focusing a textarea
    // on iOS pops the soft keyboard, which shrinks the visual
    // viewport and would otherwise corrupt the rect math.
    this.activeMobilePosition = this.computeMobilePopoverPosition(threadId);
    this.applyMobileCardPosition(card);
    // Auto-focus the textarea so the user can start typing
    // immediately — matches the desktop draft-focus behavior.
    const ta = card.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
    ta?.focus();
  }

  // Clear any inline positioning we wrote on a card. Called when a
  // card is dropped from active — leaving stale inline `top` etc.
  // around would conflict with the next render (and with the
  // desktop-column layout if the user resizes the viewport).
  private clearMobileCardPosition(card: HTMLElement): void {
    card.style.top = "";
    card.style.bottom = "";
    card.style.maxHeight = "";
  }

  // Apply `activeMobilePosition` to the given card. Always sets BOTH
  // top and bottom so a stale value from a different render mode
  // (e.g. an inline `top` left over from desktop `repositionCards`)
  // is overwritten, not partially shadowed by CSS.
  private applyMobileCardPosition(card: HTMLElement): void {
    const pos = this.activeMobilePosition;
    if (!pos) {
      // Fallback to the CSS default (bottom-sheet at bottom: 80px).
      this.clearMobileCardPosition(card);
      return;
    }
    if (pos.top !== undefined) {
      card.style.top = pos.top;
      card.style.bottom = "auto";
    } else if (pos.bottom !== undefined) {
      card.style.bottom = pos.bottom;
      card.style.top = "auto";
    }
    card.style.maxHeight = pos.maxHeight;
  }

  // Decide where to anchor the popover relative to the tapped
  // element. Prefer placing it *below* the anchor (matches Google
  // Docs / native iOS contextual popovers); flip to above if there's
  // more usable room there. Both placements respect the bottom-end
  // dock area (so the popover doesn't get hidden behind the player)
  // and the viewport's top margin. Returns null if we can't resolve
  // an anchor element — caller falls back to the CSS default.
  private computeMobilePopoverPosition(threadId: string): {
    top?: string;
    bottom?: string;
    maxHeight: string;
  } | null {
    const thread = this.snapshot.find((t) => t.id === threadId)
      ?? this.drafts.find((t) => t.id === threadId);
    if (!thread) return null;

    let anchorEl: HTMLElement | null = null;
    if (isTextTarget(thread.target)) {
      anchorEl = document.querySelector<HTMLElement>(
        `.cmt-highlight[data-thread-id="${CSS.escape(threadId)}"]`,
      );
      if (!anchorEl) {
        const firstSeg = textTargetParts(thread.target).blocks[0];
        if (firstSeg) {
          anchorEl = this.blocksById.get(firstSeg.id)?.element ?? null;
        }
      }
    } else {
      anchorEl = this.graphicsById.get(graphicTargetId(thread.target)) ?? null;
    }
    if (!anchorEl) return null;

    // Resolve the anchor's geometry, then delegate the placement math to
    // the pure helper in ./commentsDom.ts. Splitting the two halves means
    // the unit tests can fuzz the math without faking
    // `getBoundingClientRect()` on every variant.
    return computePopoverPositionForRect(anchorEl.getBoundingClientRect(), {
      viewportHeight: window.innerHeight,
      // Reserve room at the bottom for the narrator's "Listen" pill plus
      // player dock area. The dock's measured height is published by
      // narrator.ts as `--narrate-dock-height`; we read it back here so
      // the reservation tracks the actual dock size.
      dockHeight: this.dockHeightPx(),
    });
  }

  private mountHideAllFab(): void {
    // Read the persisted pref via the pure helper — handles
    // unavailable / throwing storage and the "anything other than '1'
    // means visible" rule.
    this.highlightsHidden = loadHighlightsHidden(
      typeof localStorage !== "undefined" ? localStorage : null,
    );

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "cmt-hide-all-fab";
    fab.setAttribute("aria-label", "Toggle comment highlights");
    fab.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setHighlightsHidden(!this.highlightsHidden);
    });
    document.body.appendChild(fab);
    this.hideAllFab = fab;
    this.applyHighlightsHidden();
  }

  private setHighlightsHidden(hidden: boolean): void {
    this.highlightsHidden = hidden;
    if (typeof localStorage !== "undefined") {
      // Persist via the pure helper. The fire-and-forget API matches the
      // capture-controls pattern in narrator.ts: in-memory state is
      // authoritative for the live session; storage is the next-page-load
      // contract.
      saveHighlightsHidden(localStorage, hidden);
    }
    this.applyHighlightsHidden();
    // Dismiss any popover when hiding — otherwise the overlay
    // remains on top of the dimmed article, which looks broken.
    if (hidden && this.activeCardId) this.setActiveCard(null);
  }

  private applyHighlightsHidden(): void {
    document.body.classList.toggle(
      "cmt-highlights-hidden",
      this.highlightsHidden,
    );
    if (this.hideAllFab) {
      this.hideAllFab.setAttribute(
        "aria-pressed",
        String(this.highlightsHidden),
      );
      this.hideAllFab.title = this.highlightsHidden
        ? "Show comment highlights"
        : "Hide comment highlights";
    }
  }

  // ===== Column =====

  private mountColumn() {
    const col = document.createElement("aside");
    col.id = "cmt-column";
    col.className = "cmt-column";
    col.setAttribute("role", "complementary");
    col.setAttribute("aria-label", "Comments");
    document.body.appendChild(col);
    this.column = col;

    // Flow element that reserves bottom scroll room (sized in
    // repositionCards). Must be in normal flow — not inside the
    // absolutely-positioned column — so it actually extends the
    // document's scrollHeight.
    const spacer = document.createElement("div");
    spacer.id = "cmt-bottom-spacer";
    spacer.setAttribute("aria-hidden", "true");
    document.body.appendChild(spacer);
    this.bottomSpacer = spacer;

    // Zero-size absolutely-positioned probe sharing the cards'
    // containing block. Cards' `top` is relative to the column's
    // positioning origin, not the document, and that origin isn't
    // reliably the column's own box top (the article's top margin
    // shifts it). We measure the origin off this probe so card tops can
    // be converted from document coordinates (what anchors give us) into
    // the column-relative coordinates `style.top` actually wants — see
    // repositionCards.
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;";
    col.appendChild(probe);
    this.columnProbe = probe;

    // The identity header sits above the cards. It lives outside the
    // column's normal absolutely-positioned card flow so it doesn't get
    // shoved around by `repositionCards`.
    const header = document.createElement("div");
    header.className = "cmt-identity";
    col.appendChild(header);
    this.identityHeader = header;
  }

  // Render the "Signed in as X" / "Sign in to comment" pane. Called once
  // at boot; would be re-called on a future identity change (we'd need
  // to add a re-init flow for that).
  private renderIdentityHeader() {
    const h = this.identityHeader;
    if (!h) return;
    h.innerHTML = "";

    // Mobile-only dismiss × — hidden by CSS on desktop. Click flips
    // `body.cmt-identity-dismissed` which the mobile media query reads
    // to hide the bar for the session. Deliberately NOT persisted: a
    // returning reader who's never signed in should see the
    // affordance again on the next page load.
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "cmt-identity-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.title = "Dismiss until next reload";
    dismiss.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      document.body.classList.add("cmt-identity-dismissed");
    });
    h.appendChild(dismiss);

    if (this.identity) {
      const avatar = this.buildAvatar(this.identity.picture, this.identity.name ?? this.identity.email);
      const name = document.createElement("span");
      name.className = "cmt-identity-name";
      name.textContent = this.identity.name ?? this.identity.email;
      name.title = this.identity.email;
      const out = document.createElement("button");
      out.type = "button";
      out.className = "cmt-identity-signout";
      out.textContent = "Sign out";
      out.addEventListener("click", (e) => {
        e.stopPropagation();
        signOut();
      });
      h.appendChild(avatar);
      h.appendChild(name);
      h.appendChild(out);
    } else {
      h.classList.add("cmt-identity-loggedout");
      const label = document.createElement("p");
      label.className = "cmt-identity-pitch";
      label.textContent = "Sign in to comment — so I can reply by email.";
      const buttons = document.createElement("div");
      buttons.className = "cmt-identity-providers";
      buttons.appendChild(this.buildProviderLink("google", "Sign in with Google"));
      buttons.appendChild(this.buildProviderLink("microsoft", "Sign in with Microsoft"));
      h.appendChild(label);
      h.appendChild(buttons);
      h.appendChild(this.buildPrivacyNotice());
    }
  }

  private buildProviderLink(provider: "google" | "microsoft", label: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = `cmt-identity-provider cmt-identity-provider-${provider}`;
    a.href = loginUrl(provider);
    a.textContent = label;
    return a;
  }

  // Just-in-time privacy notice rendered directly under the login
  // buttons. GDPR Art. 13 wants the legal basis (consent) and a
  // pointer to the full notice at the point of collection — exactly
  // here, where the user is about to OAuth in and have their name +
  // email + provider id recorded. The full Privacy Policy lives at
  // /privacy; we link to it rather than reproduce it inline. We
  // intentionally use textContent for the body so the link is the
  // only HTML node (no innerHTML splicing of attacker-influenced
  // strings — same posture as every other interpolation point in
  // this file).
  private buildPrivacyNotice(): HTMLElement {
    const wrap = document.createElement("p");
    wrap.className = "cmt-identity-privacy";
    wrap.appendChild(document.createTextNode(
      "Signing in records your name, email, and a provider account ID alongside your comments. See the ",
    ));
    const a = document.createElement("a");
    a.href = "/privacy";
    a.textContent = "Privacy Policy";
    wrap.appendChild(a);
    wrap.appendChild(document.createTextNode("."));
    return wrap;
  }

  // Small round avatar. Falls back to a colored initial if no picture
  // URL (Microsoft accounts often don't return one); also falls back if
  // the image errors at load.
  private buildAvatar(picture: string | null, name: string): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cmt-avatar";
    wrap.setAttribute("aria-hidden", "true");
    const initial = (name.trim()[0] ?? "?").toUpperCase();
    wrap.dataset.initial = initial;
    if (picture) {
      const img = document.createElement("img");
      img.src = picture;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove());
      wrap.appendChild(img);
    }
    return wrap;
  }

  // Combined resolved check: either the thread carries its own
  // resolvedAt (self-resolve via CommentStore) OR the per-post
  // resolutions store has an entry (author-resolve). Author wins
  // any tie at the display layer; both states equivalently hide.
  private threadIsResolved(thread: Thread): boolean {
    if (isResolved(thread)) return true;
    if (this.resolutions?.isResolved(thread.id)) return true;
    return false;
  }

  // Master render: redraws cards, highlights, and indicators from scratch.
  // Cheap enough at our scale (a handful of threads per post) that we
  // don't bother diffing.
  private renderAll() {
    if (!this.column) return;

    // Capture the composer the user is actively typing in, if any. This
    // method tears down and rebuilds every card below, and a poll tick
    // re-renders unconditionally (see `pollOnce`) every 60s and on tab
    // re-focus — wholly independent of any keystroke. Without this, that
    // teardown destroys the live textarea mid-sentence: focus jumps out
    // (the "randomly un-focuses" report) and, for a *reply* — whose
    // in-progress text, unlike a draft's, is never persisted — the typed
    // text is lost outright. We re-apply the captured value, caret, and
    // focus onto the freshly built card at the end of the render.
    const activeComposer = this.captureActiveComposer();

    // Highlights: wipe and re-apply (only for non-stale, non-resolved
    // text threads — resolved threads must leave no visual trace).
    document.querySelectorAll<HTMLElement>(".cmt-highlight").forEach((s) =>
      this.unwrap(s),
    );
    for (const thread of this.snapshot) {
      if (this.threadIsResolved(thread)) continue;
      if (isTextTarget(thread.target) && !this.threadIsStale(thread)) {
        this.highlightTextThread(thread);
      }
    }

    // Cards. Hidden saved threads are skipped entirely (their highlight
    // remains in the article so the user can click to bring them back).
    // Drafts can't be hidden — they don't have a recovery affordance.
    // STALE text threads also bypass the hide list: their highlight is no
    // longer drawn (the segments changed), so there'd be no way to bring
    // them back. Surfacing them unconditionally lets the user review and
    // decide whether to delete the now-orphaned thread.
    //
    // Surgical removal (vs. column.innerHTML = "") so the identity header
    // — also a child of the column — survives each render pass.
    for (const card of this.cardEls.values()) card.remove();
    this.cardEls.clear();
    const all: Thread[] = [...this.snapshot, ...this.drafts];
    for (const thread of all) {
      if (this.threadIsResolved(thread)) continue;
      const isStale = isTextTarget(thread.target)
        && this.threadIsStale(thread);
      if (this.hiddenCardIds.has(thread.id) && !isStale) continue;
      const card = this.buildCard(thread);
      this.column.appendChild(card);
      this.cardEls.set(thread.id, card);
    }

    // Re-apply the mobile "active popover" marker — `cardEls` was
    // just cleared, so the new card for `activeCardId` (if any)
    // needs the attribute again, and the inline positioning we
    // computed at tap time has to be restored (otherwise a
    // poll-driven re-render would snap the popover back to the CSS
    // default bottom-sheet position). If the active thread
    // vanished (e.g. resolved by the author between renders), drop
    // the state.
    if (this.activeCardId) {
      const card = this.cardEls.get(this.activeCardId);
      if (card) {
        card.setAttribute("data-mobile-active", "true");
        this.applyMobileCardPosition(card);
      } else {
        this.activeCardId = null;
        this.activeMobilePosition = null;
      }
    }

    // If the last-focused thread is no longer rendered (e.g. it was
    // resolved or hidden out from under us), drop the marker — a
    // future highlight click should be treated as a fresh navigate,
    // not as a phantom toggle.
    if (
      this.lastFocusedThreadId
      && !this.cardEls.has(this.lastFocusedThreadId)
    ) {
      this.lastFocusedThreadId = null;
    }

    this.updateGraphicIndicators();
    this.renderUnresolvedCount();
    this.repositionCards();

    this.restoreActiveComposer(activeComposer);
  }

  // Snapshot of an in-progress composer textarea, taken before a render
  // tears its card down so the rebuilt card can be restored to the same
  // state (text, caret, focus). See `renderAll` for why this matters.
  private captureActiveComposer(): {
    threadId: string;
    value: string;
    selectionStart: number;
    selectionEnd: number;
  } | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement)) return null;
    if (!el.classList.contains("cmt-reply-input")) return null;
    for (const [threadId, card] of this.cardEls) {
      if (card.contains(el)) {
        const end = el.value.length;
        return {
          threadId,
          value: el.value,
          selectionStart: el.selectionStart ?? end,
          selectionEnd: el.selectionEnd ?? end,
        };
      }
    }
    return null;
  }

  // Re-apply a captured composer onto its rebuilt card. The thread may be
  // gone (resolved/cancelled out from under the render) — then there's
  // nothing to restore and we no-op. For a reply this is also what carries
  // the typed text across the render, since reply bodies (unlike draft
  // bodies) aren't persisted in `draftBodies`.
  private restoreActiveComposer(
    state: ReturnType<CommentSystem["captureActiveComposer"]>,
  ) {
    if (!state) return;
    const card = this.cardEls.get(state.threadId);
    const ta = card?.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
    if (!ta) return;
    ta.value = state.value;
    // `preventScroll` so restoring focus doesn't yank the viewport to the
    // card on a background poll re-render while the user reads elsewhere.
    ta.focus({ preventScroll: true });
    try {
      ta.setSelectionRange(state.selectionStart, state.selectionEnd);
    } catch {
      // setSelectionRange throws on some input types / detached nodes;
      // focus alone is still the important part.
    }
  }

  // Build a single card. Cards reflect both saved threads and unsubmitted
  // drafts; we distinguish them via `data-draft="true"` so CSS can frame
  // drafts distinctly and so the composer's Cancel button can do the
  // right thing (discard the draft entirely vs. just clear the reply box).
  private buildCard(thread: Thread): HTMLElement {
    const isDraft = this.drafts.includes(thread);
    const isText = isTextTarget(thread.target);
    const isStale = !isDraft && isText && this.threadIsStale(thread);

    const isNarration = contextOf(thread.target) === "narration";

    const card = document.createElement("article");
    card.className = "cmt-card";
    card.dataset.threadId = thread.id;
    card.dataset.kind = isText ? "text" : "graphic";
    // Lets CSS tint narration comments distinctly from article ones.
    card.dataset.context = isNarration ? "narration" : "article";
    if (isDraft) card.dataset.draft = "true";
    if (isStale) card.dataset.stale = "true";

    // --- Anchor preview ---
    const preview = document.createElement("div");
    preview.className = "cmt-anchor-preview";
    if (isTextTarget(thread.target)) {
      const quote = document.createElement("span");
      quote.className = "cmt-quote-text";
      quote.textContent = textTargetParts(thread.target).quote;
      preview.appendChild(quote);
      if (isStale) {
        const tag = document.createElement("span");
        tag.className = "cmt-stale-tag";
        tag.textContent = "outdated";
        preview.appendChild(tag);
      }
      // Narration comments get an explicit speaker button to jump the
      // player to (and play) the segment they sit on — a deliberate
      // press, so reading the comment never starts audio by accident.
      // The button doubles as the visual marker that this is a comment
      // on the spoken track rather than the article.
      if (isNarration) {
        const speaker = document.createElement("button");
        speaker.type = "button";
        speaker.className = "cmt-play-narration";
        speaker.title = "Play this part of the narration";
        speaker.setAttribute("aria-label", "Play this part of the narration");
        speaker.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor"/>' +
          '<path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          "</svg>";
        speaker.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.playThreadAudio(thread);
        });
        preview.appendChild(speaker);
      }
    } else {
      const span = document.createElement("span");
      span.className = "cmt-quote-text";
      span.textContent = "Comment on graphic";
      preview.appendChild(span);
    }
    card.appendChild(preview);

    // --- Existing replies (excluding tombstoned deletes) ---
    const liveReplies = visibleReplies(thread);
    if (liveReplies.length > 0) {
      const list = document.createElement("ol");
      list.className = "cmt-reply-list";
      for (const reply of liveReplies) {
        list.appendChild(this.buildReplyLi(reply, thread));
      }
      card.appendChild(list);
    }

    // --- Composer ---
    card.appendChild(this.buildComposer(thread, isDraft, isStale));

    // Clicking anywhere on a card sets it as "active" so we can highlight
    // its anchor in the article. Doesn't capture clicks on buttons / the
    // textarea (those have their own handlers).
    card.addEventListener("click", (e) => {
      // Ignore clicks on interactive children — they bubble here but we
      // don't want to steal focus from textarea/buttons.
      const t = e.target as HTMLElement | null;
      if (t && t.closest("button, textarea")) return;
      this.scrollAnchorIntoView(thread);
    });

    return card;
  }

  private buildReplyLi(reply: Reply, thread: Thread): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "cmt-reply";

    const meta = document.createElement("div");
    meta.className = "cmt-reply-meta";
    const authorWrap = document.createElement("span");
    authorWrap.className = "cmt-reply-author-wrap";
    // Email is stored in the CRDT but deliberately not rendered to other
    // readers — only the blog author (future feature) needs it. Avatar +
    // name is the public face of each reply.
    const displayName = reply.authorName || reply.authorEmail || "Unknown";
    authorWrap.appendChild(this.buildAvatar(reply.authorPicture ?? null, displayName));
    const author = document.createElement("span");
    author.className = "cmt-reply-author";
    author.textContent = displayName;
    authorWrap.appendChild(author);
    const time = document.createElement("time");
    time.className = "cmt-reply-time";
    time.dateTime = new Date(reply.createdAt).toISOString();
    time.textContent = formatRelative(reply.createdAt);
    meta.appendChild(authorWrap);
    meta.appendChild(time);
    li.appendChild(meta);

    const text = document.createElement("p");
    text.className = "cmt-reply-text";
    text.textContent = reply.body;
    li.appendChild(text);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "cmt-reply-delete";
    del.setAttribute("aria-label", "Delete this comment");
    del.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteReply(thread, reply.id);
    });
    li.appendChild(del);

    return li;
  }

  private buildComposer(thread: Thread, isDraft: boolean, isStale: boolean): HTMLElement {
    const composer = document.createElement("div");
    composer.className = "cmt-composer";

    const ta = document.createElement("textarea");
    ta.className = "cmt-reply-input";
    ta.rows = isDraft ? 3 : 2;
    ta.placeholder = isDraft ? "Comment…" : "Reply…";
    // Restore any persisted in-progress body for this draft so a reload
    // (or a re-render from a poll tick) doesn't blank what the user was
    // typing. Saved threads always start with an empty reply field —
    // bodies are only persisted for unsubmitted drafts.
    if (isDraft) {
      const saved = this.draftBodies.get(thread.id);
      if (saved) ta.value = saved;
      // Persist every keystroke. The localStorage write is cheap and
      // synchronous; debouncing would only matter at thousand-keystroke
      // scales which we won't hit on a comment composer.
      ta.addEventListener("input", () => {
        this.draftBodies.set(thread.id, ta.value);
        this.persistDrafts();
      });
    }
    // Stop card-click bubbling from inside the textarea (would re-trigger
    // anchor scrolling on every click while typing).
    ta.addEventListener("click", (e) => e.stopPropagation());
    composer.appendChild(ta);

    const row = document.createElement("div");
    row.className = "cmt-reply-row";

    // Author-only: surface the thread id so the author can correlate this
    // card with the `id=<threadId>` lines /process-comments prints (and the
    // ids `resolve-threads` accepts). Readers never see it; drafts have no
    // exported id yet so we skip them. CSS pins it to the row's left edge
    // (margin-right:auto), so it reads as "to the left of Hide". Click copies.
    if (!isDraft && this.isAuthorMode()) {
      const id = document.createElement("button");
      id.type = "button";
      id.className = "cmt-thread-id";
      id.textContent = thread.id;
      id.title = "Thread ID (click to copy) — matches the id= lines in /process-comments";
      id.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard
          ?.writeText(thread.id)
          .then(() => {
            const prev = id.textContent;
            id.textContent = "copied";
            window.setTimeout(() => {
              id.textContent = prev;
            }, 1000);
          })
          .catch(() => {});
      });
      row.appendChild(id);
    }

    // Drafts can't be recovered (no anchor highlight to click), so Cancel
    // discards. Non-stale saved threads keep their highlight, so Cancel
    // just hides the card. STALE saved threads have no recovery
    // affordance (the highlight is no longer drawn) — we omit the button
    // entirely rather than offer a Hide that traps the comment.
    if (isDraft || !isStale) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cmt-reply-cancel";
      cancel.textContent = isDraft ? "Cancel" : "Hide";
      cancel.title = isDraft
        ? "Discard this draft"
        : "Hide this card (click the highlight to bring it back)";
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isDraft) {
          this.drafts = this.drafts.filter((t) => t.id !== thread.id);
          this.draftBodies.delete(thread.id);
          this.persistDrafts();
          this.renderAll();
        } else {
          this.hiddenCardIds.add(thread.id);
          this.renderAll();
        }
      });
      row.appendChild(cancel);
    }

    // Resolve — decisive, permanent dismiss. Available on every saved
    // thread (including stale, where it's often *the* right action).
    // Routing splits into two paths:
    //   - Own thread (we're the original commenter): write the
    //     resolution into our CommentDoc (`store.resolveThread`).
    //   - Foreign thread (we're the post author resolving a reader's
    //     comment): write a per-post resolution entry — only the
    //     author can do this, and only the post author's session is
    //     authorized server-side. Visible to both the author and the
    //     original commenter on next poll.
    // Hidden entirely for non-author readers on foreign threads
    // because they can't see foreign threads in the first place; the
    // condition still guards against unauthorized clicks just in
    // case.
    const ownThread = !isDraft && this.store?.ownsThread(thread.id);
    const canAuthorResolve =
      !isDraft && !ownThread && !!this.identity && this.isAuthorMode();
    if (!isDraft && (ownThread || canAuthorResolve)) {
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "cmt-reply-resolve";
      resolve.textContent = "Resolve";
      resolve.title = ownThread
        ? "Resolve this thread — hides it permanently and queues a delete to sync to the server"
        : "Resolve this commenter's thread — marks it resolved for them too";
      resolve.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.store) return;
        // Also drop any session-only "hide" mark so the thread isn't
        // stuck in the hidden set forever after being resolved.
        this.hiddenCardIds.delete(thread.id);
        if (ownThread) {
          this.store.resolveThread(thread.id, Date.now());
          this.refreshSnapshotAndRender();
        } else if (this.resolutions && this.identity) {
          const envelope: ResolutionEnvelope = {
            threadId: thread.id,
            resolvedAt: Date.now(),
            resolverId: this.identity.userId,
            resolverName: this.identity.name ?? this.identity.email,
          };
          // Fire-and-forget; the store's onChange hook re-renders
          // when the local cache updates (after the PUT lands).
          // Errors are logged inside the store.
          this.resolutions
            .resolve(envelope)
            .catch((err) => console.warn("author resolve failed:", err));
        }
      });
      row.appendChild(resolve);
    }

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "cmt-reply-submit";
    submit.textContent = isDraft ? "Comment" : "Reply";
    const doSubmit = () => {
      if (!this.store || !this.identity) return;
      const body = ta.value.trim();
      if (!body) return;
      const reply: Reply = {
        id: uid(),
        body,
        createdAt: Date.now(),
        authorId: this.identity.userId,
        authorName: this.identity.name ?? this.identity.email,
        authorEmail: this.identity.email,
        ...(this.identity.picture && { authorPicture: this.identity.picture }),
      };
      if (isDraft) {
        // Promote draft → persisted thread. Single Automerge change
        // would be tidier here, but the public store API has separate
        // ops; we accept two ops for the v1 case since it's a fresh
        // thread no one else has touched yet.
        this.store.addThread(thread.id, thread.target, thread.createdAt);
        this.store.addReply(thread.id, reply);
        this.drafts = this.drafts.filter((t) => t.id !== thread.id);
        this.draftBodies.delete(thread.id);
        this.persistDrafts();
      } else {
        this.store.addReply(thread.id, reply);
      }
      ta.value = "";
      this.refreshSnapshotAndRender();
    };
    submit.addEventListener("click", (e) => {
      e.stopPropagation();
      doSubmit();
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        doSubmit();
      }
    });

    row.appendChild(submit);
    composer.appendChild(row);
    return composer;
  }

  private deleteReply(thread: Thread, replyId: string) {
    if (!this.store) return;
    const reply = thread.replies.find((r) => r.id === replyId);
    if (!reply || isDeleted(reply)) return;
    // Tombstoning + the auto-resolve-on-last-delete bundling is all
    // handled atomically inside CommentStore.deleteReply so future
    // server sync sees one coherent CRDT change per user action.
    this.store.deleteReply(thread.id, replyId, Date.now());
    // The store auto-resolves the thread if this was the last visible
    // reply; clear the session-only "hide" mark in the same step so a
    // previously-hidden, now-resolved thread doesn't leave a dangling
    // entry in the set.
    this.hiddenCardIds.delete(thread.id);
    this.refreshSnapshotAndRender();
  }

  // One polling tick: pull any changes the server has accumulated
  // since last time and re-render if anything moved. The polling
  // controller calls this; the per-store hydrate + aggregate calls
  // are both idempotent set-diffs, so a no-op tick is cheap (1 LIST
  // per relevant user, no GETs, no DOM work beyond the snapshot
  // comparison).
  private async pollOnce(postPath: string): Promise<void> {
    if (!this.store || !this.sync || !this.identity) return;
    try {
      await this.sync.hydrate();
    } catch (err) {
      console.warn("poll: own hydrate failed:", err);
    }
    if (this.isAuthorMode()) {
      try {
        await aggregateOtherReaders(
          this.store,
          postPath,
          this.identity.userId,
          this.aggState,
        );
      } catch (err) {
        console.warn("poll: aggregate failed:", err);
      }
    }
    if (this.resolutions) {
      try {
        await this.resolutions.hydrate();
      } catch (err) {
        console.warn("poll: resolutions hydrate failed:", err);
      }
    }
    this.refreshSnapshotAndRender();
  }

  // Re-pull the JSON snapshot from the store and re-render. Called after
  // every mutation so the UI always reflects current doc state.
  private refreshSnapshotAndRender() {
    if (!this.store) return;
    this.snapshot = this.store.snapshot();
    this.renderAll();
  }

  // Player dock height (px) published by narrator.ts as the
  // `--narrate-dock-height` custom property, or 0 if absent.
  private dockHeightPx(): number {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--narrate-dock-height").trim();
    const n = raw ? parseFloat(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  // Vertically align each card with its anchor's top, then push later
  // cards down to avoid overlap. Stale text threads (no highlight) fall
  // back to their first segment's position; if even that segment is gone,
  // we stack them at the page bottom.
  private repositionCards() {
    if (!this.column) return;
    // Mobile uses fixed-overlay positioning driven entirely by CSS;
    // the column's normal stacked layout doesn't apply and a JS
    // `top` write would just be overridden. Drop any reserved bottom
    // room — the desktop spacer shouldn't linger after a resize down.
    if (this.isMobile) {
      if (this.bottomSpacer) this.bottomSpacer.style.height = "0px";
      return;
    }

    // Height of the document *without* our spacer, so the spacer math
    // below is stable (and so a bottom-stacked card's fallback target
    // doesn't chase the spacer it then grows).
    const spacerH = this.bottomSpacer?.offsetHeight ?? 0;
    const naturalHeight = document.documentElement.scrollHeight - spacerH;

    // The document Y at which a card's `top: 0` would render. `style.top`
    // is relative to the column's positioning origin, so we subtract this
    // from each anchor's document Y to align the card with its anchor
    // (without it, every card sits lower by the origin's offset).
    const originY = this.columnProbe
      ? this.columnProbe.getBoundingClientRect().top + window.scrollY
      : 0;

    const items: Array<{
      card: HTMLElement;
      thread: Thread;
      target: number;
    }> = [];
    for (const [tid, card] of this.cardEls) {
      const thread = this.snapshot.find((t) => t.id === tid)
        ?? this.drafts.find((t) => t.id === tid);
      if (!thread) continue;
      // computeAnchorTop is in document coords; convert to column-relative.
      const docTarget = this.computeAnchorTop(thread) ?? naturalHeight + 200;
      items.push({ card, thread, target: docTarget - originY });
    }
    items.sort((a, b) => a.target - b.target);

    // The identity header (and any version banner / history details
    // inserted between it and the cards) sits at the top of the
    // column in normal flow, but cards are absolutely positioned and
    // would otherwise stack starting at column-top = 0. Sum every
    // non-card child so the first card lands below them.
    const topReserved =
      (this.identityHeader?.offsetHeight ?? 0) +
      (this.versionBannerEl?.offsetHeight ?? 0) +
      (this.versionHistoryEl?.offsetHeight ?? 0) +
      (this.unresolvedCountEl?.offsetHeight ?? 0);
    let prevBottom = topReserved > 0 ? topReserved - CARD_GAP_PX : 0;
    for (const { card, target } of items) {
      const top = Math.max(target, prevBottom + CARD_GAP_PX);
      card.style.top = `${top}px`;
      // Use offsetHeight after the style.top write — height is independent
      // of top so reading offsetHeight here is safe.
      prevBottom = top + card.offsetHeight;
    }

    // The player dock is fixed to the viewport bottom, so a card whose
    // document position lands in the last dock-height band can never be
    // scrolled out from under it (worst case: a comment on the final
    // paragraph — there's nothing below to scroll into). Grow an invisible
    // spacer so the document scrolls far enough to lift the lowest card
    // clear of the dock + a margin.
    if (this.bottomSpacer) {
      // Measure the lowest card's bottom in *document* coordinates via
      // getBoundingClientRect — NOT `prevBottom`/`card.style.top`, which
      // are relative to the absolutely-positioned column and so understate
      // the true document position by the column's own offset (~the
      // article's top margin), leaving the reservation short and the card
      // still partly behind the dock.
      let lowestBottom = 0;
      for (const { card } of items) {
        const b = card.getBoundingClientRect().bottom + window.scrollY;
        if (b > lowestBottom) lowestBottom = b;
      }
      const needed = lowestBottom + this.dockHeightPx() + BOTTOM_CLEARANCE_PX;
      const spacer = Math.max(0, Math.ceil(needed - naturalHeight));
      if (spacer !== spacerH) this.bottomSpacer.style.height = `${spacer}px`;
    }
  }

  // The article element a narration comment refers to. A narration
  // segment's `<mark name="X"/>` pairs with an article `id="X"` (the same
  // mapping narrator.ts uses to highlight the article during playback), so
  // we resolve the comment's segment → its mark → the article element.
  // Narration cards align to *this* element rather than to their drawer
  // block — the drawer is a fixed-position panel, so drawer coordinates
  // make every narration card cluster around the current scroll position
  // and overflow once there are more than a few. Anchoring to the article
  // spreads them down the column exactly like article comments.
  //
  // Returns null when the mark has no paired article element. An author
  // can write a `<mark>` with no matching id (narrator.ts warns when it
  // happens) — those cards fall back to bottom-stacking. If a segment ever
  // maps to several article elements (not possible today: one mark, one
  // id), this returns the first one in document order.
  private narrationArticleAnchor(thread: Thread): HTMLElement | null {
    if (!this.articleRoot || !isTextTarget(thread.target)) return null;
    const firstBlockId = textTargetParts(thread.target).blocks[0]?.id;
    const block = firstBlockId ? this.blocksById.get(firstBlockId) : undefined;
    const markName = block?.element
      .closest<HTMLElement>(".spoken-segment")?.dataset.mark;
    if (!markName) return null;
    return this.articleRoot.querySelector<HTMLElement>(`#${CSS.escape(markName)}`);
  }

  private computeAnchorTop(thread: Thread): number | null {
    if (isTextTarget(thread.target)) {
      // Narration comments align to the article position their segment
      // refers to (see narrationArticleAnchor). No paired article element
      // → null → bottom-stack.
      if (contextOf(thread.target) === "narration") {
        const el = this.narrationArticleAnchor(thread);
        return el ? el.getBoundingClientRect().top + window.scrollY : null;
      }
      // Prefer the first highlight (matches exactly where the comment
      // points); fall back to the first segment block (works for stale
      // threads when the segment still exists, just with different text).
      const hl = document.querySelector<HTMLElement>(
        `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
      );
      if (hl) return hl.getBoundingClientRect().top + window.scrollY;
      const firstSeg = textTargetParts(thread.target).blocks[0];
      const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
      if (block) return block.element.getBoundingClientRect().top + window.scrollY;
      return null;
    }
    const el = this.graphicsById.get(graphicTargetId(thread.target));
    if (el) return el.getBoundingClientRect().top + window.scrollY;
    return null;
  }

  // Jump the player to the narration segment this comment sits on and
  // play. Reuses the segment's own play button (which seeks + plays), so
  // there's no coupling into the narrator module beyond the DOM the
  // comment system already reads. Triggered only by the explicit speaker
  // button on a narration card — never by a plain card click, so reading
  // a comment can't accidentally start audio.
  private playThreadAudio(thread: Thread) {
    if (!isTextTarget(thread.target)) return;
    const firstSeg = textTargetParts(thread.target).blocks[0];
    const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
    const seg = block?.element.closest<HTMLElement>(".spoken-segment");
    seg?.querySelector<HTMLButtonElement>(".spoken-play")?.click();
  }

  // Scroll the document so the anchor is visible, and briefly pulse it.
  // Used when the user clicks a card to jump to where it points. For a
  // narration comment that's the article element its segment refers to
  // (where the card is now positioned) — playback is on the separate
  // speaker button, so this gesture only navigates, never plays.
  private scrollAnchorIntoView(thread: Thread) {
    let target: HTMLElement | null = null;
    if (isTextTarget(thread.target)) {
      if (contextOf(thread.target) === "narration") {
        // Jump to the referred article element; fall back to the drawer
        // block if the mark has no paired article element.
        const firstSeg = textTargetParts(thread.target).blocks[0];
        const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
        target = this.narrationArticleAnchor(thread) ?? block?.element ?? null;
      } else {
        target = document.querySelector<HTMLElement>(
          `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
        );
        if (!target) {
          const firstSeg = textTargetParts(thread.target).blocks[0];
          const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
          target = block?.element ?? null;
        }
      }
    } else {
      target = this.graphicsById.get(graphicTargetId(thread.target)) ?? null;
    }
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("cmt-anchor-pulse");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      target!.classList.remove("cmt-anchor-pulse");
      this.pulseTimer = 0;
    }, 1200);
  }

  // Scroll the column so the given thread's card is visible, and pulse
  // it. Used when the user clicks on a highlight in the article.
  private scrollCardIntoView(threadId: string) {
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("cmt-card-pulse");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      card.classList.remove("cmt-card-pulse");
      this.pulseTimer = 0;
    }, 1200);
  }

  // ===== Selection → action bar =====

  private mountActionBar() {
    const bar = document.createElement("div");
    bar.className = "cmt-action-bar";
    bar.hidden = true;
    bar.innerHTML =
      '<button type="button" class="cmt-action-btn">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
      "<span>Comment</span></button>";
    // mousedown (not click) so the selection isn't lost to a focus event
    // before we capture it.
    bar.querySelector("button")!.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.addDraftForSelection();
    });
    document.body.appendChild(bar);
    this.actionBar = bar;
  }

  private onSelectionChange() {
    // No commenting without login — keep the action bar suppressed so
    // text selection in the article doesn't promise a feature the user
    // can't use. The login affordance lives in the column header.
    if (!this.identity) {
      this.hideActionBar();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideActionBar();
      return;
    }
    const range = sel.getRangeAt(0);
    // Ignore selections originating inside our own UI (column / cards).
    if (this.column && this.column.contains(range.startContainer)) {
      this.hideActionBar();
      return;
    }
    const startBlock = this.blockForNode(range.startContainer);
    const endBlock = this.blockForNode(range.endContainer);
    if (!startBlock || !endBlock || startBlock.context !== endBlock.context) {
      this.hideActionBar();
      return;
    }
    this.pendingRange = range.cloneRange();
    this.pendingStartBlock = startBlock;
    this.pendingEndBlock = endBlock;
    this.showActionBarFor(range);
  }

  private blockForNode(node: Node): BlockInfo | null {
    const block = findBlockFor(node);
    if (!block) return null;
    const id = block.dataset.commentBlockId;
    if (!id) return null;
    return this.blocksById.get(id) ?? null;
  }

  private showActionBarFor(range: Range) {
    if (!this.actionBar) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideActionBar();
      return;
    }
    this.actionBar.hidden = false;
    const barW = this.actionBar.offsetWidth || 110;
    const barH = this.actionBar.offsetHeight || 32;
    const top = window.scrollY + rect.top - barH - 8;
    let left = window.scrollX + rect.left + rect.width / 2 - barW / 2;
    left = Math.max(
      8,
      Math.min(left, window.scrollX + window.innerWidth - barW - 8),
    );
    this.actionBar.style.top = `${top}px`;
    this.actionBar.style.left = `${left}px`;
  }

  private hideActionBar() {
    if (this.actionBar) this.actionBar.hidden = true;
    this.pendingRange = null;
    this.pendingStartBlock = null;
    this.pendingEndBlock = null;
  }

  // ===== Compose new drafts =====

  // Serialize the current drafts + per-draft textarea bodies to
  // localStorage. Called after any mutation that adds, removes, or
  // edits a draft. The bodies map is filtered through the current
  // `drafts` array so a stray entry for a removed thread can't leak.
  private persistDrafts(): void {
    if (!this.draftsStorage) return;
    const entries = this.drafts.map((thread) => ({
      thread,
      body: this.draftBodies.get(thread.id) ?? "",
    }));
    this.draftsStorage.save(entries);
  }

  // Triggered by the "Comment" action-bar button after a text selection.
  // Captures the selection into a WA text target, creates an empty draft, and
  // adds a card for it in the column (auto-focused for typing).
  private addDraftForSelection() {
    if (!this.pendingRange || !this.pendingStartBlock || !this.pendingEndBlock) {
      return;
    }
    if (this.pendingStartBlock.context !== this.pendingEndBlock.context) return;

    const blocks = this.blocksByContext.get(this.pendingStartBlock.context) ?? [];
    const startIdx = blocks.indexOf(this.pendingStartBlock);
    const endIdx = blocks.indexOf(this.pendingEndBlock);
    if (startIdx === -1 || endIdx === -1) return;
    const [a, b] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    const touched = blocks.slice(a, b + 1);

    // Direction matters: the selection may be created in reverse, in
    // which case startContainer/endContainer is the *visual* end. The
    // anchor needs to store the forward-document order regardless.
    const rangeForwards = startIdx <= endIdx;
    const startBlock = rangeForwards ? this.pendingStartBlock : this.pendingEndBlock;
    const endBlock = rangeForwards ? this.pendingEndBlock : this.pendingStartBlock;
    const startNode = rangeForwards
      ? this.pendingRange.startContainer
      : this.pendingRange.endContainer;
    const startNodeOffset = rangeForwards
      ? this.pendingRange.startOffset
      : this.pendingRange.endOffset;
    const endNode = rangeForwards
      ? this.pendingRange.endContainer
      : this.pendingRange.startContainer;
    const endNodeOffset = rangeForwards
      ? this.pendingRange.endOffset
      : this.pendingRange.startOffset;

    const startOffset = offsetInBlock(startBlock.element, startNode, startNodeOffset);
    const endOffset = offsetInBlock(endBlock.element, endNode, endNodeOffset);

    // Build the quote from the anchored blocks' own text + offsets, not
    // from `range.toString()`. Across drawer segments the raw range would
    // splice in the next segment's play-button clock ("0:11") that sits
    // between the two <p>s in document order; slicing each block's clean
    // text avoids that and is the precise per-block anchored text anyway.
    const blockText = (b: BlockInfo) => b.element.textContent ?? "";
    const quote = touched.length === 1
      ? blockText(touched[0]!).slice(startOffset, endOffset)
      : [
          blockText(touched[0]!).slice(startOffset),
          ...touched.slice(1, -1).map(blockText),
          blockText(touched[touched.length - 1]!).slice(0, endOffset),
        ].join(" ");

    // Surrounding context for the TextQuoteSelector. We don't fuzzy
    // re-anchor today (the stale-anchor flow orphans + flags instead),
    // but storing prefix/suffix is cheap (~32 chars each) and keeps the
    // selector spec-meaningful + leaves the door open to fuzzy matching
    // later without another CRDT migration.
    const CTX = 32;
    const startText = startBlock.element.textContent ?? "";
    const endText = endBlock.element.textContent ?? "";
    const prefix = startText.slice(Math.max(0, startOffset - CTX), startOffset);
    const suffix = endText.slice(endOffset, endOffset + CTX);

    // Narration comments automatically pick up the audio time range of
    // the segment(s) they touch, from the generated mark timings the
    // narrator stamps onto each drawer segment (`data-time-ms`). Article
    // and graphic comments have no audio time and get nothing.
    const audioRange = this.pendingStartBlock.context === "narration"
      ? this.computeNarrationAudioRange(touched)
      : undefined;

    const target = makeTextTarget({
      context: this.pendingStartBlock.context,
      blocks: touched.map((blk) => ({ id: blk.id, hash: blk.hash })),
      startOffset,
      endOffset,
      quote,
      prefix,
      suffix,
      ...(audioRange ? { audioRange } : {}),
    });

    const draft: Thread = {
      id: uid(),
      target,
      replies: [],
      createdAt: Date.now(),
    };
    this.drafts.push(draft);
    this.persistDrafts();
    this.hideActionBar();
    this.renderAll();
    this.surfaceDraft(draft.id);
  }

  // Derive the audio time range [first segment start, next segment start)
  // for a narration selection, from the `data-time-ms` the narrator
  // stamps on each drawer segment (sourced from the generated manifest).
  // Returns null if the timings aren't present (e.g. audio not generated,
  // or the touched blocks aren't inside spoken segments). `endMs: null`
  // means the selection reaches the final segment and so runs open-ended
  // to the end of the audio.
  private computeNarrationAudioRange(
    touched: BlockInfo[],
  ): { startMs: number; endMs: number | null } | null {
    if (!this.drawerRoot || touched.length === 0) return null;
    // `walkBlocks` indexes the `<li>` wrapping each segment (LI is a
    // block tag and the walker stops there), so `.spoken-segment` is a
    // *descendant* of the commented block — look down. `closest` is kept
    // as a fallback in case a future layout nests the block inside the
    // segment instead.
    const segOf = (el: HTMLElement): HTMLElement | null =>
      el.querySelector<HTMLElement>(".spoken-segment[data-time-ms]")
        ?? el.closest<HTMLElement>(".spoken-segment");
    const firstSeg = segOf(touched[0]!.element);
    const lastSeg = segOf(touched[touched.length - 1]!.element);
    if (!firstSeg || !lastSeg) return null;
    const startMs = Number(firstSeg.dataset.timeMs);
    if (!Number.isFinite(startMs)) return null;
    // Document order == time order (marks are sorted), so the segment
    // immediately after the last touched one bounds the range.
    const segs = Array.from(
      this.drawerRoot.querySelectorAll<HTMLElement>(".spoken-segment[data-time-ms]"),
    );
    const nextSeg = segs[segs.indexOf(lastSeg) + 1];
    const endMs = nextSeg ? Number(nextSeg.dataset.timeMs) : NaN;
    return { startMs, endMs: Number.isFinite(endMs) ? endMs : null };
  }

  // Triggered by clicking the "+" comment button on a figure.
  private addDraftForGraphic(graphicEl: HTMLElement) {
    const id = graphicEl.dataset.commentGraphicId;
    const ctx = (graphicEl.dataset.commentContext as Context) ?? "article";
    if (!id) return;
    const draft: Thread = {
      id: uid(),
      target: makeGraphicTarget(ctx, id),
      replies: [],
      createdAt: Date.now(),
    };
    this.drafts.push(draft);
    this.persistDrafts();
    this.renderAll();
    this.surfaceDraft(draft.id);
  }

  // After creating a draft, get it in front of the user. On desktop
  // that means scrolling its column card into view; on mobile it
  // means promoting it to the active popover.
  private surfaceDraft(threadId: string) {
    if (this.isMobile) {
      this.setActiveCard(threadId);
      return;
    }
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const ta = card.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
    ta?.focus();
  }

  // ===== Stale detection =====

  private threadIsStale(thread: Thread): boolean {
    if (!isTextTarget(thread.target)) return false;
    // Pure check — see commentsStale.ts. The Map is supplied as-is; the
    // helper only reads `.hash` from each value so the BlockInfo's other
    // fields are irrelevant here.
    return compareSegmentHashes(
      textTargetParts(thread.target).blocks,
      this.blocksById,
    );
  }

  // ===== Highlight wrapping (DOM-mutating; reversed by `unwrap`) =====

  private highlightTextThread(thread: Thread) {
    if (!isTextTarget(thread.target)) return;
    const parts = textTargetParts(thread.target);
    const segs = parts.blocks;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const block = this.blocksById.get(seg.id);
      if (!block) return;
      const isFirst = i === 0;
      const isLast = i === segs.length - 1;
      const fullLen = block.element.textContent?.length ?? 0;
      const start = isFirst ? parts.startOffset : 0;
      const end = isLast ? parts.endOffset : fullLen;
      this.wrapRangeInBlock(block.element, start, end, thread.id);
    }
  }

  private wrapRangeInBlock(
    block: HTMLElement,
    start: number,
    end: number,
    threadId: string,
  ) {
    if (start >= end) return;
    const s = nodeAtOffset(block, start);
    const e = nodeAtOffset(block, end);
    if (!s || !e) return;
    const range = document.createRange();
    try {
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
    } catch {
      return;
    }
    this.wrapRange(range, threadId);
  }

  private wrapRange(range: Range, threadId: string) {
    const anchorEl =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    if (!anchorEl) return;
    const walker = document.createTreeWalker(anchorEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (range.intersectsNode(n)) textNodes.push(n);
    }
    if (textNodes.length === 0) return;
    for (const node of textNodes) {
      let target: Text = node;
      const nodeLen = target.nodeValue?.length ?? 0;
      const isStart = node === range.startContainer;
      const isEnd = node === range.endContainer;
      const startInNode = isStart ? range.startOffset : 0;
      const endInNode = isEnd ? range.endOffset : nodeLen;
      if (startInNode >= endInNode) continue;
      if (endInNode < nodeLen) target.splitText(endInNode);
      if (startInNode > 0) target = target.splitText(startInNode);
      const span = document.createElement("span");
      span.className = "cmt-highlight";
      span.dataset.threadId = threadId;
      target.parentNode!.insertBefore(span, target);
      span.appendChild(target);
    }
  }

  private unwrap(span: HTMLElement) {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  // ===== Graphics: hover trigger =====

  private installGraphicTriggers() {
    for (const [, el] of this.graphicsById) {
      // The "+" button (visible on hover) → creates a new draft. Only
      // mounted when logged in; without identity the comment-creation
      // path is fully closed off (mirrors the action-bar gate above).
      let btn: HTMLButtonElement | null = null;
      if (this.identity) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cmt-graphic-btn";
        btn.setAttribute("aria-label", "Comment on this graphic");
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.addDraftForGraphic(el);
        });
      }

      // Indicator badge (always visible when >0 threads on this graphic).
      // Click = unhide any hidden cards for the graphic, then scroll to
      // the first one. Mirrors the "click the highlight to bring text
      // threads back" affordance.
      const ind = document.createElement("button");
      ind.type = "button";
      ind.className = "cmt-graphic-indicator";
      ind.hidden = true; // updateGraphicIndicators() shows it when threads exist
      ind.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const gid = el.dataset.commentGraphicId;
        if (!gid) return;
        const matching = this.snapshot.filter(
          (t) => !this.threadIsResolved(t)
            && !isTextTarget(t.target)
            && graphicTargetId(t.target) === gid,
        );
        let didUnhide = false;
        for (const t of matching) {
          if (this.hiddenCardIds.has(t.id)) {
            this.hiddenCardIds.delete(t.id);
            didUnhide = true;
          }
        }
        if (didUnhide) this.renderAll();
        const first = matching[0];
        if (!first) return;
        if (this.isMobile) {
          // Same toggle behavior as the text-highlight tap: a second
          // tap on the same indicator closes the popover.
          if (this.activeCardId === first.id) {
            this.setActiveCard(null);
          } else {
            this.setActiveCard(first.id);
          }
        } else {
          // Desktop toggle (mirrors the highlight-click path):
          // navigate on first click, hide on the second.
          if (didUnhide) {
            this.scrollCardIntoView(first.id);
            this.lastFocusedThreadId = first.id;
          } else if (this.lastFocusedThreadId === first.id) {
            this.hiddenCardIds.add(first.id);
            this.lastFocusedThreadId = null;
            this.renderAll();
          } else {
            this.scrollCardIntoView(first.id);
            this.lastFocusedThreadId = first.id;
          }
        }
      });

      const cs = getComputedStyle(el);
      if (cs.position === "static") el.style.position = "relative";
      if (btn) el.appendChild(btn);
      el.appendChild(ind);
    }
  }

  // Keep each graphic's indicator badge in sync with the thread count.
  // Called from renderAll so it stays correct after submits / deletes.
  private updateGraphicIndicators() {
    for (const [gid, el] of this.graphicsById) {
      const count = this.snapshot.filter(
        (t) => !this.threadIsResolved(t)
          && !isTextTarget(t.target)
          && graphicTargetId(t.target) === gid,
      ).length;
      const ind = el.querySelector<HTMLElement>(".cmt-graphic-indicator");
      if (!ind) continue;
      if (count > 0) {
        ind.textContent = String(count);
        ind.title = `${count} comment${count === 1 ? "" : "s"} on this graphic`;
        ind.hidden = false;
      } else {
        ind.hidden = true;
      }
    }
  }

  // ===== Document click routing =====

  private onAnyClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // On mobile, a tap outside any card / highlight / control closes
    // the active popover. Check this BEFORE the highlight handling
    // so a tap on the highlight itself opens the popover (handled
    // below) rather than closing it.
    if (this.isMobile && this.activeCardId) {
      const insideCard = target.closest(".cmt-card");
      const onHighlight = target.closest(".cmt-highlight");
      const onGraphic = target.closest(
        ".cmt-graphic-btn, .cmt-graphic-indicator",
      );
      const onActionBar = target.closest(".cmt-action-bar");
      const onFab = target.closest(".cmt-hide-all-fab");
      if (!insideCard && !onHighlight && !onGraphic && !onActionBar && !onFab) {
        this.setActiveCard(null);
      }
    }

    // Click on a highlight → unhide its card (if hidden) and scroll to
    // it. When highlights are *nested* (multiple threads on the same
    // selection), we walk all enclosing `.cmt-highlight` ancestors and
    // unhide every one of them — so clicking a stacked span surfaces all
    // the overlapping threads at once, not just the innermost.
    const hl = target.closest<HTMLElement>(".cmt-highlight");
    if (!hl) return;
    const ids: string[] = [];
    let cur: HTMLElement | null = hl;
    while (cur) {
      if (cur.classList.contains("cmt-highlight") && cur.dataset.threadId) {
        ids.push(cur.dataset.threadId);
      }
      cur = cur.parentElement;
    }
    let didUnhide = false;
    for (const id of ids) {
      if (this.hiddenCardIds.has(id)) {
        this.hiddenCardIds.delete(id);
        didUnhide = true;
      }
    }
    if (didUnhide) this.renderAll();
    // Innermost (= the actual clicked span) is the one to surface.
    const innermost = ids[0];
    if (!innermost) return;
    if (this.isMobile) {
      // Popover model — tapping the active anchor's highlight again
      // toggles the popover closed. Without this, the only way to
      // dismiss it is tap-outside, which is fiddly on a phone (the
      // popover covers a sizeable strip of the screen). Tapping a
      // *different* highlight still switches the popover.
      if (this.activeCardId === innermost) {
        this.setActiveCard(null);
      } else {
        this.setActiveCard(innermost);
      }
    } else {
      // Column model: navigate-then-hide pattern.
      // - If the click just brought a hidden card back, scroll to it
      //   (no toggle — the user obviously wants to see it).
      // - Otherwise, if this is a second consecutive click on the
      //   same anchor, hide its card.
      // - Otherwise, scroll + mark as focused.
      if (didUnhide) {
        this.scrollCardIntoView(innermost);
        this.lastFocusedThreadId = innermost;
      } else if (this.lastFocusedThreadId === innermost) {
        this.hiddenCardIds.add(innermost);
        this.lastFocusedThreadId = null;
        this.renderAll();
      } else {
        this.scrollCardIntoView(innermost);
        this.lastFocusedThreadId = innermost;
      }
    }
  }
}

function boot() {
  new CommentSystem().init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
