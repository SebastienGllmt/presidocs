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
  isTextTarget,
  contextOf,
  textTargetParts,
  graphicTargetId,
  type Thread,
} from "./commentsStore.ts";
import {
  loadIdentity,
  signOut,
  type Identity,
} from "./identity.ts";
import { CommentSync } from "./commentsSync.ts";
import { aggregateOtherReaders } from "./commentsAggregator.ts";
import { CommentPolling } from "./commentsPolling.ts";
import { ResolutionStore } from "./resolutionsStore.ts";
import { compareSegmentHashes } from "./commentsStale.ts";
import { scrollBehavior, uid } from "./comments/util.ts";
import {
  anchorNameForText,
  unwrap,
  wrapRangeInBlock,
} from "./comments/highlights.ts";
import {
  buildAvatar,
  buildProviderLink,
  buildPrivacyNotice,
} from "./comments/identityUi.ts";
import {
  BlockIndex,
  requestDrawerBody,
} from "./comments/blockIndex.ts";
import { SelectionBar } from "./comments/selectionBar.ts";
import { DraftManager } from "./comments/draftManager.ts";
import { VersionBanner } from "./comments/versionBanner.ts";
import { UnresolvedNav } from "./comments/unresolvedNav.ts";
import { CardRenderer } from "./comments/cards.ts";
import { FigureTriggers } from "./comments/figureTriggers.ts";
import { MobileMenu } from "./comments/mobileMenu.ts";

// Build-time define (Bun.build `define` map) — `undefined` under the fast
// `bun run dev` server, `"false"` in built/dev:edge/prod. Used only to gate
// the dev-only e2e test seam (`installTestHooks`); see swRegister.ts for the
// same pattern. Never true in a shipped bundle.
declare const __BUN_DEV__: boolean | undefined;

// BLOCK_TAGS, normalizeText, walkBlocks live in ./commentsDom.ts (imported
// by ./comments/blockIndex.ts) — extracting them gave the indexer's leaf-tag
// set, whitespace rule, and document-order walker a place to be tested
// without instantiating the whole CommentSystem.

// Extra gap kept between the lowest card's bottom and the player dock
// when reserving bottom scroll room, so a bottom card never sits flush
// against the dock.
const BOTTOM_CLEARANCE_PX = 24;

// Below this viewport width the column doesn't fit alongside the
// article. Each card carries `popover="auto"`; CSS Anchor Positioning
// places the open popover against its tapped highlight (with a
// bottom-sheet fallback when the anchor's edges are cramped).
const MOBILE_BREAKPOINT_PX = 1099;

export class CommentSystem {
  // Collaborator owning the block/graphic index (article + drawer roots) and
  // the narrator↔comments drawer-body handshake. Constructed inert; the
  // orchestrator and collaborators read its maps via `this.index` /
  // `this.sys.index`.
  readonly index = new BlockIndex();
  // Selection action bar + the shared selection capture; owns the `pending*`
  // handoff DraftManager consumes. Constructed inert.
  readonly selection = new SelectionBar(this);
  // Draft lifecycle (create / discard / persist / surface) + the per-textarea
  // body buffers. Constructed inert.
  readonly draftMgr = new DraftManager(this);
  // Document-version banner + history disclosure. Constructed inert.
  readonly version = new VersionBanner(this);
  // Author-only unresolved-count badge + cycle navigation. Constructed inert.
  readonly unresolvedNav = new UnresolvedNav(this);
  // Card rendering (preview + replies + composer/mutation routing). Inert.
  readonly cards = new CardRenderer(this);
  // Per-figure comment triggers + indicator badges. Constructed inert.
  readonly figures = new FigureTriggers(this);
  // Mobile button + one-menu popover + highlight-toggle. Constructed inert.
  readonly menu = new MobileMenu(this);

  articleRoot: HTMLElement | null = null;

  // Logged-in user, or null when not authenticated. The UI gates every
  // comment-creation path on this being non-null. Loaded once at boot
  // from /auth/me; not refreshed mid-session (an expired cookie at
  // mid-session falls back to "still appears logged in locally," which is
  // harmless given comments only write to localStorage in v1).
  identity: Identity | null = null;

  // The CRDT store owns persistence + merge semantics. `snapshot` is a
  // cached plain-JSON view of the store's threads, refreshed after every
  // mutation. The UI reads from `snapshot`; mutations route through the
  // store. Stays null when not logged in — the store is keyed by user id,
  // so we can't create it until identity is known.
  store: CommentStore | null = null;
  snapshot: Thread[] = [];

  // Owns the network push/pull for the logged-in user's blob. Lives
  // alongside the store so a single mutation triggers persist (in the
  // store) and a server PUT (here). Null when not logged in.
  private sync: CommentSync | null = null;

  // Visibility-gated periodic polling. Re-runs hydrate (own user) and
  // the aggregator (author only) on a fixed interval while the tab is
  // focused. Null when not logged in.
  private polling: CommentPolling | null = null;

  // Per-post resolutions doc — author-only writes, all-logged-in
  // reads. Threads marked as resolved here are filtered out of the
  // render alongside threads with their own resolvedAt timestamp.
  // Hydrate-and-poll like the CommentStore. Null when not logged in.
  resolutions: ResolutionStore | null = null;

  // Below the mobile breakpoint, cards render as fixed-position
  // overlays (popovers) rather than as a stacked column. Tracked
  // via a `MediaQueryList` listener so a window resize across the
  // breakpoint flips the layout live.
  isMobile = false;
  // Mobile-only: id of the thread/draft currently displayed as the
  // popover. Null when nothing is open. Switches on highlight /
  // graphic-indicator tap and on draft creation; cleared on
  // tap-outside (driven by the card's native `toggle` event so the
  // platform's light-dismiss and ESC stay in sync with our state).
  activeCardId: string | null = null;
  // Desktop-only: id of the thread most recently focused via a
  // highlight or graphic-indicator click. A second consecutive click
  // on the same anchor toggles its card hidden. Reset on explicit
  // Hide/Resolve/Cancel, on clicks that brought a hidden card back
  // (so the user gets one tap to navigate before the next would
  // re-hide), and on focusing a different anchor.
  lastFocusedThreadId: string | null = null;

  // Header in the column showing "Signed in as ..." or the login pane
  // when not authenticated. Rendered once at init, re-rendered on
  // identity change (currently only at boot).
  identityHeader: HTMLElement | null = null;
  // The fixed top-of-gutter rail that hosts the permanent header surfaces
  // (identity card, version banner, version history, unresolved count). The
  // stack pass treats its occupied band as an obstacle so top-of-article
  // cards cascade below it instead of being occluded by it.
  private railEl: HTMLElement | null = null;
  // Thread ids whose card the user has temporarily hidden via "Cancel".
  // Session-only (deliberately not persisted) — a reload brings every
  // card back, so you can't accidentally lose track of comments by
  // hiding them all and forgetting. Restored by clicking the anchor's
  // highlight (text) or graphic indicator (figures).
  hiddenCardIds = new Set<string>();

  // The right-margin column hosting all cards. One card per thread/draft.
  column: HTMLElement | null = null;
  // Invisible flow element appended to <body> that grows just enough to
  // give scroll room below the lowest comment card, so a card can always
  // be scrolled clear of the viewport-fixed player dock (see
  // `updateBottomSpacer`). 0 height when not needed.
  private bottomSpacer: HTMLElement | null = null;
  cardEls = new Map<string, HTMLElement>();
  // Block elements we stamped `anchor-name` on as the fallback
  // anchor for stale text threads (whose highlights are gone).
  // Tracked so the next render can clear them before re-stamping —
  // unlike highlight spans, blocks are reused across renders and
  // a stale stamp would otherwise persist after the thread is
  // deleted or revived.
  private staleAnchorBlocks = new Set<HTMLElement>();

  // Set while a card is being scrolled-to / pulsed, used to suppress the
  // reposition pass from fighting the smooth-scroll.
  private pulseTimer = 0;

  // Render-coalescing state for the involuntary (background-poll) render
  // path — see `backgroundRender`. `lastRenderSignature` is a digest of
  // everything `renderAll` draws, captured at the end of each render, so a
  // poll that pulled nothing new can skip the teardown entirely. `composing`
  // tracks whether the user is mid-IME-composition in a composer textarea
  // (set via composition events in `buildComposer`); a background render that
  // lands during composition is deferred to `compositionend` via
  // `pendingBackgroundRender` rather than tearing down the live textarea (and
  // dropping the pre-commit conversion text with it).
  private lastRenderSignature: string | null = null;
  composing = false;
  pendingBackgroundRender = false;

  async init() {
    this.articleRoot = document.querySelector<HTMLElement>(
      "[data-narration-src]",
    );
    if (!this.articleRoot) return;

    await this.indexArticle();

    // Load identity first — the comment store is keyed on user id, so
    // without a logged-in user there's nothing to load. Identity also gates
    // the spoken-script DRAWER: it's only indexed/painted when logged in (a
    // logged-out reader sees no comments and can't create any). So the
    // logged-in branch below requests + indexes the drawer, and a logged-out
    // reader never touches it — which lets the narrator keep the drawer body
    // deferred off the boot path (and off the Lighthouse trace). The drawer is
    // also built lazily, so we no longer race a `MutationObserver` for it; see
    // `indexDrawerWhenReady`.
    this.identity = await loadIdentity();

    this.mountColumn();
    this.selection.mountActionBar();
    this.menu.mountCommentsButton();
    this.menu.mountMenu();
    this.figures.installGraphicTriggers();
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
      if (!this.isMobile) {
        this.setActiveCard(null);
        this.menu.hideMenu();
        document.body.classList.remove("cmt-has-selection");
      }
      // Cards built for the previous breakpoint either have or lack
      // `popover="auto"`. Reconcile so the next tap-to-open path
      // works without a full re-render. Also re-point each card's anchor:
      // desktop anchors to its highlight (`top: anchor(top)`); mobile anchors
      // under the button (`position-area` dropdown).
      for (const card of this.cardEls.values()) {
        card.popover = this.isMobile ? "auto" : null;
        this.applyCardAnchor(card);
      }
      this.updateBottomSpacer();
    });

    if (this.identity) {
      // Narration comments live in the narrator's spoken-script drawer, whose
      // body is built lazily off the boot path. Request + index it in the
      // background (then re-render), so it's ready for narration comments
      // without blocking the article comments rendered below on the narrator's
      // lazy boot. Fire-and-forget — a non-narrated / opt-out post just never
      // produces a drawer and the request times out harmlessly.
      void this.indexDrawerWhenReady();

      // Spin up the CRDT-backed store. This is the only place we await
      // Automerge's WASM load — once `create()` returns the store is
      // fully hydrated and all UI handlers can safely call its mutation
      // methods.
      const postPath = window.location.pathname;
      this.store = await CommentStore.create(postPath, this.identity.userId);

      this.draftMgr.loadPersisted(postPath, this.identity.userId);

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
      await this.version.initDocVersion(postPath);

      // Author-only: refresh every other reader's blob in the background.
      // Fire-and-forget (not awaited) so the first render isn't gated on
      // the reader fan-out — the store already re-hydrated the persisted
      // aggregate in `create()`, so that first render shows everyone's
      // comments and the correct unresolved count from localStorage; this
      // pass only pulls deltas (and re-renders if any landed). The first
      // session on a device, with nothing cached, is the one that waits.
      if (this.isAuthorMode()) {
        aggregateOtherReaders(this.store, postPath, this.identity.userId)
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

    this.installTestHooks();

    document.addEventListener("selectionchange", () => this.selection.onSelectionChange());
    document.addEventListener("click", (e) => this.onAnyClick(e));
    // Because boot is deferred (this module loads lazily on first engagement),
    // the reader may already have a selection when we start (the very gesture
    // that triggered the load, or a test's programmatic Range). Evaluate it once
    // so the action bar appears for
    // a selection that predates our listener. Fully guarded — no-ops unless the
    // selection is genuine and the reader is signed in.
    this.selection.onSelectionChange();
    // No scroll listener — CSS Anchor Positioning re-evaluates
    // `anchor()` on every scroll frame in C++, so cards stay aligned
    // to their anchors without JS layout work.
    window.addEventListener("resize", () => {
      // Base card placement is anchor-driven (CSS, no JS), but a resize can
      // reflow card heights (text re-wraps), which changes which cards overlap
      // — so re-run the stack pass — and the bottom spacer's reservation
      // depends on viewport math (dock-height + lowest-card position). The
      // action-bar follows its pending range below.
      this.adjustCardStacking();
      this.updateBottomSpacer();
      if (this.selection.pendingRange && this.selection.actionBar && !this.selection.actionBar.hidden) {
        this.selection.showActionBarFor(this.selection.pendingRange);
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
    await this.index.indexRoot(this.articleRoot, "article");
  }

  // Logged-in only: ask the narrator to build its (deferred) drawer body,
  // wait for it, then index + render so narration comments anchor. Background
  // task — the article comments don't wait on it.
  private async indexDrawerWhenReady(): Promise<void> {
    const drawer = await requestDrawerBody();
    if (!drawer) return; // no drawer (opt-out / non-narrated post) — article-only
    await this.index.indexDrawer(drawer);
    this.renderAll();
  }

  // ===== Document version =====

  // Server-authoritative "is the current user the post's author?"
  // signal. Sourced from the /post-version response so the answer
  // works in prod (where the source-only <meta name="author-email">
  // tag is stripped from served HTML and a DOM-based check would
  // return false). False until docVersion has been fetched; if the
  // fetch fails we stay non-author, which is the safe default.
  isAuthorMode(): boolean {
    return this.version.docVersion?.isAuthor ?? false;
  }

  // ===== Mobile popover + hide-all FAB =====

  // Set/clear the "currently visible popover" on mobile. A no-op on
  // desktop — the column layout shows every non-hidden card anyway.
  // Also unhides the card if the user had previously dismissed it
  // via "Hide", since on mobile there's no other way to bring it
  // back than tapping the highlight.
  //
  // Placement is handled by CSS Anchor Positioning + the Popover
  // API's top-layer rendering; light-dismiss, ESC, and focus return
  // come from the platform. We only own `activeCardId` (for the
  // tap-same-highlight-to-close gesture) and the body class.
  setActiveCard(threadId: string | null): void {
    if (this.activeCardId) {
      this.cardEls.get(this.activeCardId)?.hidePopover(); // no-op if closed
    }
    this.activeCardId = threadId;
    if (!threadId) return;
    if (this.hiddenCardIds.has(threadId)) {
      this.hiddenCardIds.delete(threadId);
      // Card was skipped on the previous render; rebuild so it
      // actually exists in `cardEls` before we tag it active.
      this.renderAll();
    }
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.showPopover();
    // Auto-focus the textarea so the user can start typing
    // immediately — matches the desktop draft-focus behavior.
    // `preventScroll`: the card is a top-layer popover; focusing into it
    // must not scroll the underlying document.
    card.querySelector<HTMLTextAreaElement>(".cmt-reply-input")?.focus({ preventScroll: true });
  }

  // Point a card at the right anchor for the current layout: desktop anchors to
  // its own highlight/graphic (`top: anchor(top)`); mobile anchors under the
  // button so it drops down as part of the one menu surface.
  applyCardAnchor(card: HTMLElement): void {
    if (this.isMobile) {
      card.style.setProperty("position-anchor", "--cmt-comments-btn");
    } else {
      const own = card.dataset.anchorName;
      if (own) card.style.setProperty("position-anchor", own);
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
    // `updateBottomSpacer`). Must be in normal flow — not inside
    // the absolutely-positioned column — so it actually extends
    // the document's scrollHeight.
    const spacer = document.createElement("div");
    spacer.id = "cmt-bottom-spacer";
    spacer.setAttribute("aria-hidden", "true");
    document.body.appendChild(spacer);
    this.bottomSpacer = spacer;

    // Permanent "header" surfaces — the identity card, the version banner,
    // the version-history disclosure, and the unresolved-count button — live
    // in a rail pinned to the top of the gutter (desktop) so they hold their
    // place as the article scrolls. The rail is the ONE positioned box here:
    // cards must not share a positioned ancestor (they're abs-positioned and
    // anchor to their highlights), so they hang off the unpositioned column
    // directly, while the rail keeps the header surfaces out of the document
    // flow that would otherwise drop them to the bottom of the page. The
    // version/unresolved surfaces insert themselves after the identity header
    // (see `renderVersionUI` / `renderUnresolvedCount`), so they land in the
    // rail too.
    const rail = document.createElement("div");
    rail.className = "cmt-rail";
    col.appendChild(rail);
    this.railEl = rail;

    const header = document.createElement("div");
    header.className = "cmt-identity";
    rail.appendChild(header);
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
      const avatar = buildAvatar(this.identity.picture, this.identity.name ?? this.identity.email);
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
      buttons.appendChild(buildProviderLink("google", "Sign in with Google"));
      buttons.appendChild(buildProviderLink("microsoft", "Sign in with Microsoft"));
      h.appendChild(label);
      h.appendChild(buttons);
      h.appendChild(buildPrivacyNotice());
    }
  }

  // Combined resolved check: either the thread carries its own
  // resolvedAt (self-resolve via CommentStore) OR the per-post
  // resolutions store has an entry (author-resolve). Author wins
  // any tie at the display layer; both states equivalently hide.
  threadIsResolved(thread: Thread): boolean {
    if (isResolved(thread)) return true;
    if (this.resolutions?.isResolved(thread.id)) return true;
    return false;
  }

  // Master render: redraws cards, highlights, and indicators from scratch.
  // Cheap enough at our scale (a handful of threads per post) that we
  // don't bother diffing.
  renderAll() {
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
    // DRAFTS are included: a draft's card anchors to its highlight via
    // `position-anchor` / `anchor(top)`, so without a highlight element the
    // anchor can't resolve and the card falls to the top of the page — which
    // is what made composing a new comment yank the viewport to the top. A
    // fresh draft is never resolved and never stale (its hashes were just
    // captured), so it passes both guards.
    document.querySelectorAll<HTMLElement>(".cmt-highlight").forEach((s) =>
      unwrap(s),
    );
    for (const thread of [...this.snapshot, ...this.draftMgr.drafts]) {
      if (this.threadIsResolved(thread)) continue;
      if (isTextTarget(thread.target) && !this.threadIsStale(thread)) {
        this.highlightTextThread(thread);
      }
    }

    // A multi-segment thread produces N `.cmt-highlight` spans (one
    // per text node spanned by `wrapRange`). CSS Anchor Positioning
    // needs a single anchor element per name, so we stamp
    // `anchor-name` on the FIRST highlight per thread in document
    // order — matches the existing `querySelector` semantics in
    // `computeAnchorTop`. The unwrap pass above already removed the
    // previous render's spans, so this is always a fresh stamp.
    const anchoredThreads = new Set<string>();
    document.querySelectorAll<HTMLElement>(".cmt-highlight").forEach((span) => {
      const tid = span.dataset.threadId;
      if (!tid || anchoredThreads.has(tid)) return;
      // Narration highlights live in the drawer, but their card anchors to the
      // paired *article* element (stamped in `buildCard` via
      // `narrationArticleAnchor`). Stamping the drawer span too would put the
      // same `anchor-name` on two elements; the spec's "last in DOM order"
      // tiebreak could then resolve `anchor()` to the drawer span — which is
      // `display:none` while the drawer is closed, collapsing the card to the
      // fallback. Leave drawer highlights visual-only.
      if (span.closest(".narrate-drawer")) return;
      anchoredThreads.add(tid);
      span.style.setProperty("anchor-name", anchorNameForText(tid));
    });

    // Stale text threads have no highlight (the segments changed and
    // we deliberately don't draw an unsafe highlight). Without an
    // anchor the card would fall through to `top: anchor(top, 0px)`
    // and pile up at the column top. Stamp `anchor-name` on the
    // first segment block instead so the stale card still aligns
    // with where the thread used to point — matches the prior
    // `repositionCards` fallback. Multiple stale threads on the
    // same first block compose via `anchor-name`'s comma-separated
    // list syntax. We track stamped blocks so the next render can
    // reset them before re-stamping.
    for (const el of this.staleAnchorBlocks) {
      el.style.removeProperty("anchor-name");
    }
    this.staleAnchorBlocks.clear();
    for (const thread of this.snapshot) {
      if (!isTextTarget(thread.target)) continue;
      if (!this.threadIsStale(thread)) continue;
      if (anchoredThreads.has(thread.id)) continue;
      const firstSeg = textTargetParts(thread.target).blocks[0];
      const block = firstSeg ? this.index.blocksById.get(firstSeg.id) : undefined;
      if (!block) continue;
      const name = anchorNameForText(thread.id);
      const existing = block.element.style.getPropertyValue("anchor-name");
      block.element.style.setProperty(
        "anchor-name",
        existing && existing !== "none" ? `${existing}, ${name}` : name,
      );
      this.staleAnchorBlocks.add(block.element);
      anchoredThreads.add(thread.id);
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
    const all: Thread[] = [...this.snapshot, ...this.draftMgr.drafts];
    for (const thread of all) {
      if (this.threadIsResolved(thread)) continue;
      const isStale = isTextTarget(thread.target)
        && this.threadIsStale(thread);
      if (this.hiddenCardIds.has(thread.id) && !isStale) continue;
      const card = this.cards.buildCard(thread);
      this.column.appendChild(card);
      this.cardEls.set(thread.id, card);
    }

    // Re-open the mobile popover after a rebuild — `cardEls` was
    // just cleared, so the new card for `activeCardId` (if any) is
    // a fresh element and starts in the closed state. Call
    // `showPopover()` to restore it; the toggle handler keeps
    // `activeCardId` in sync if the platform later light-dismisses.
    // If the active thread vanished (e.g. resolved between renders),
    // drop the state.
    if (this.activeCardId) {
      const card = this.cardEls.get(this.activeCardId);
      if (card) {
        card.showPopover();
      } else {
        this.activeCardId = null;
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

    this.figures.updateGraphicIndicators();
    this.unresolvedNav.renderUnresolvedCount();
    this.menu.updateCommentsBtnCount(
      this.snapshot.filter((t) => !this.threadIsResolved(t)).length,
    );
    this.adjustCardStacking();
    this.updateBottomSpacer();

    this.restoreActiveComposer(activeComposer);

    // Record what we just drew so the background-poll path can skip a render
    // that wouldn't change anything (see `backgroundRender`).
    this.lastRenderSignature = this.computeRenderSignature();
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
        await aggregateOtherReaders(this.store, postPath, this.identity.userId);
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
    this.backgroundRender();
  }

  // The involuntary re-render entry point: the poll calls this (never
  // `renderAll` directly), as does the dev test seam. Unlike a render driven
  // by the user's own mutation, a background render can land while the user is
  // mid-sentence in a composer — so it carries two guards a mutation render
  // doesn't need:
  //   1. If the user is mid-IME-composition, defer until `compositionend` —
  //      tearing the textarea down mid-conversion drops the uncommitted
  //      pre-edit text (which lives only in the DOM, not in `.value`). This
  //      matters most for CJK input.
  //   2. If nothing the render draws has changed since the last render
  //      (the common case — a 60s tick that pulled no new comments), skip the
  //      teardown entirely. This is the "no DOM work beyond the snapshot
  //      comparison" the poll comment promises.
  // Either guard leaving work undone is safe: the next genuine change (or the
  // deferred run on `compositionend`) renders it.
  backgroundRender(): void {
    if (!this.store) return;
    if (this.composing) {
      this.pendingBackgroundRender = true;
      return;
    }
    this.snapshot = this.store.snapshot();
    if (this.computeRenderSignature() === this.lastRenderSignature) return;
    this.renderAll();
  }

  // A digest of everything `renderAll` draws, so the background path can tell
  // a no-op poll from one that actually moved something. Covers the card set
  // and each card's render-affecting state: draft/resolved/stale/hidden flags
  // and the reply list (ids + tombstone state, so a new or deleted reply is a
  // change). Author mode and the version banner gate header surfaces, so they
  // count too. Deliberately excludes in-progress textarea bodies (drafts'
  // bodies live in `draftBodies` and the textarea handles its own text — a
  // keystroke must not force a column rebuild) and layout-only state (stack
  // offsets, scroll), which a poll never changes.
  private computeRenderSignature(): string {
    const parts: string[] = [
      this.isAuthorMode() ? "a1" : "a0",
      this.version.previousVersionHash ? "v1" : "v0",
    ];
    for (const thread of [...this.snapshot, ...this.draftMgr.drafts]) {
      const isDraft = this.draftMgr.drafts.includes(thread);
      const flags =
        (isDraft ? "d" : "") +
        (this.threadIsResolved(thread) ? "r" : "") +
        (!isDraft && isTextTarget(thread.target) && this.threadIsStale(thread) ? "s" : "") +
        (this.hiddenCardIds.has(thread.id) ? "h" : "");
      const replies = thread.replies
        .map((r) => r.id + (isDeleted(r) ? "x" : ""))
        .join(".");
      parts.push(`${thread.id}:${flags}:${replies}`);
    }
    return parts.join("|");
  }

  // Dev/test-only seam: a handle for the real-browser e2e suite to drive the
  // two render paths deterministically. No user gesture produces a background
  // no-op render, and waiting on the real 60s poll in a test is flaky — so the
  // suite calls these instead. Gated on the dev define, so it's absent from
  // every built/prod bundle (`__BUN_DEV__` is `"false"` there).
  private installTestHooks(): void {
    if (!(typeof __BUN_DEV__ === "undefined" || __BUN_DEV__)) return;
    (window as unknown as { __cmtTest?: Record<string, () => void> }).__cmtTest = {
      // Unconditional full re-render — exercises the capture/restore of the
      // focused composer that a delta-bearing background render relies on.
      forceRender: () => this.renderAll(),
      // The guarded involuntary path: skips on no-delta, defers during IME.
      backgroundRender: () => this.backgroundRender(),
    };
  }

  // Re-pull the JSON snapshot from the store and re-render. Called after
  // every mutation so the UI always reflects current doc state.
  refreshSnapshotAndRender() {
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

  // Grow an invisible spacer below the article so the lowest comment
  // card can be scrolled clear of the viewport-fixed player dock
  // (otherwise a card on the final paragraph stays stuck behind the
  // dock with nothing below to scroll into).
  //
  // Card placement itself is handled by CSS Anchor Positioning —
  // `top: anchor(top)` in the desktop rule and `position-area` in the
  // mobile popover rule. Scroll-tracking, cross-element flipping,
  // anchor resolution all happen in the layout engine. This pass only
  // reads the resulting geometry to size the spacer.
  updateBottomSpacer() {
    if (!this.column || !this.bottomSpacer) return;
    // Mobile is popover-based; cards render in the top layer when
    // open and don't extend the document flow. No spacer needed.
    if (this.isMobile) {
      if (this.bottomSpacer.style.height !== "0px") {
        this.bottomSpacer.style.height = "0px";
      }
      return;
    }
    // Height of the document *without* our spacer, so the spacer math
    // below is stable (and so we don't recursively chase the spacer
    // we then grow).
    const spacerH = this.bottomSpacer.offsetHeight;
    const naturalHeight = document.documentElement.scrollHeight - spacerH;
    let lowestBottom = 0;
    for (const card of this.cardEls.values()) {
      const b = card.getBoundingClientRect().bottom + window.scrollY;
      if (b > lowestBottom) lowestBottom = b;
    }
    const needed = lowestBottom + this.dockHeightPx() + BOTTOM_CLEARANCE_PX;
    const spacer = Math.max(0, Math.ceil(needed - naturalHeight));
    if (spacer !== spacerH) this.bottomSpacer.style.height = `${spacer}px`;
  }

  // Collision handling for the desktop column. Cards CSS-anchor to their
  // highlights (`top: anchor(top)`), so two comments on the same — or
  // overlapping — text resolve to the same top and render on top of each
  // other. This pass reads each card's BASE anchored position, walks them
  // top-down, and pushes any card that would overlap the one above it down via
  // `--cmt-stack-offset`, so they cascade like Google-Docs margin notes.
  // Document-relative card positions don't change on scroll (cards scroll with
  // the page, the anchor re-resolves in the compositor), so this only needs to
  // run per render and on resize — never per scroll frame.
  //
  // The pinned header rail (identity card, version banner / history,
  // unresolved count) shares the cards' gutter, so a card anchored near the top
  // of the article would otherwise rest under it. We seed the cascade with the
  // rail's occupied band so those cards fall below it. The rail is
  // `position: fixed`, so its viewport rect already IS its document position at
  // scrollY=0 (the resting reference) — we deliberately do NOT add `scrollY` to
  // it. That keeps the seed scroll-invariant, just like the cards' own
  // positions, so the pass stays a per-render / per-resize job.
  adjustCardStacking(): void {
    const cards = [...this.cardEls.values()];
    // Mobile cards are top-layer popovers (one at a time) — never stacked in
    // flow, and the rail is hidden there. Clear any offset a prior desktop
    // render may have left behind.
    if (this.isMobile || cards.length === 0) {
      for (const card of cards) card.style.removeProperty("--cmt-stack-offset");
      return;
    }

    // Measure each card's base (anchored, zero-offset) top. Suppress the `top`
    // transition first so a synchronous read can't catch a mid-animation value,
    // and zero any existing offset so we read the true anchored position.
    const order = new Map(cards.map((c, i) => [c, i] as const));
    for (const card of cards) {
      card.style.transition = "none";
      card.style.setProperty("--cmt-stack-offset", "0px");
    }
    const measured = cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { card, top: r.top + window.scrollY, height: r.height };
    });
    // Top-to-bottom; ties broken by document order (cardEls insertion order).
    measured.sort((a, b) => a.top - b.top || order.get(a.card)! - order.get(b.card)!);

    const GAP_PX = 8;
    // Seed the cascade with the rail's bottom edge (scroll-0 document Y; see
    // the note above on why `scrollY` is not added). `-Infinity` when the rail
    // is absent or collapsed, leaving card-vs-card stacking unchanged.
    let lastBottom = this.railObstacleBottom();
    for (const m of measured) {
      const offset = m.top < lastBottom + GAP_PX ? lastBottom + GAP_PX - m.top : 0;
      m.card.style.setProperty("--cmt-stack-offset", `${Math.round(offset)}px`);
      lastBottom = m.top + offset + m.height;
    }

    // Restore the transition next frame so later position changes (a future
    // render, an anchor shifting on reflow) animate, while this placement stays
    // instant — no slide-in flicker on first paint.
    requestAnimationFrame(() => {
      for (const card of cards) card.style.removeProperty("transition");
    });
  }

  // Bottom edge of the pinned header rail, as a seed for the stack cascade —
  // the scroll-0 document Y below which top-anchored cards must fall so they
  // don't rest under the rail. The rail is `position: fixed`, so its viewport
  // rect already is its scroll-0 document position; we return it as-is (no
  // `scrollY`) to keep the value scroll-invariant. Returns `-Infinity` (a
  // no-op seed) when the rail is missing or collapsed to nothing — e.g. every
  // surface hidden (the identity bar dismissed) or measured before layout —
  // so an empty rail never nudges otherwise-clear cards.
  private railObstacleBottom(): number {
    const r = this.railEl?.getBoundingClientRect();
    return r && r.height > 0 ? r.bottom : -Infinity;
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
  narrationArticleAnchor(thread: Thread): HTMLElement | null {
    if (!this.articleRoot || !isTextTarget(thread.target)) return null;
    const firstBlockId = textTargetParts(thread.target).blocks[0]?.id;
    const block = firstBlockId ? this.index.blocksById.get(firstBlockId) : undefined;
    const markName = block?.element
      .closest<HTMLElement>(".spoken-segment")?.dataset.mark;
    if (!markName) return null;
    return this.articleRoot.querySelector<HTMLElement>(`#${CSS.escape(markName)}`);
  }

  computeAnchorTop(thread: Thread): number | null {
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
      const block = firstSeg ? this.index.blocksById.get(firstSeg.id) : undefined;
      if (block) return block.element.getBoundingClientRect().top + window.scrollY;
      return null;
    }
    const el = this.index.graphicsById.get(graphicTargetId(thread.target));
    if (el) return el.getBoundingClientRect().top + window.scrollY;
    return null;
  }

  // Jump the player to the narration segment this comment sits on and
  // play. Reuses the segment's own play button (which seeks + plays), so
  // there's no coupling into the narrator module beyond the DOM the
  // comment system already reads. Triggered only by the explicit speaker
  // button on a narration card — never by a plain card click, so reading
  // a comment can't accidentally start audio.
  playThreadAudio(thread: Thread) {
    if (!isTextTarget(thread.target)) return;
    const firstSeg = textTargetParts(thread.target).blocks[0];
    const block = firstSeg ? this.index.blocksById.get(firstSeg.id) : undefined;
    const seg = block?.element.closest<HTMLElement>(".spoken-segment");
    seg?.querySelector<HTMLButtonElement>(".spoken-play")?.click();
  }

  // Scroll the document so the anchor is visible, and briefly pulse it.
  // Used when the user clicks a card to jump to where it points. For a
  // narration comment that's the article element its segment refers to
  // (where the card is now positioned) — playback is on the separate
  // speaker button, so this gesture only navigates, never plays.
  scrollAnchorIntoView(thread: Thread) {
    let target: HTMLElement | null = null;
    if (isTextTarget(thread.target)) {
      if (contextOf(thread.target) === "narration") {
        // Jump to the referred article element; fall back to the drawer
        // block if the mark has no paired article element.
        const firstSeg = textTargetParts(thread.target).blocks[0];
        const block = firstSeg ? this.index.blocksById.get(firstSeg.id) : undefined;
        target = this.narrationArticleAnchor(thread) ?? block?.element ?? null;
      } else {
        target = document.querySelector<HTMLElement>(
          `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
        );
        if (!target) {
          const firstSeg = textTargetParts(thread.target).blocks[0];
          const block = firstSeg ? this.index.blocksById.get(firstSeg.id) : undefined;
          target = block?.element ?? null;
        }
      }
    } else {
      target = this.index.graphicsById.get(graphicTargetId(thread.target)) ?? null;
    }
    if (!target) return;
    target.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    target.classList.add("cmt-anchor-pulse");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      target!.classList.remove("cmt-anchor-pulse");
      this.pulseTimer = 0;
    }, 1200);
  }

  // Scroll the column so the given thread's card is visible, and pulse
  // it. Used when the user clicks on a highlight in the article.
  scrollCardIntoView(threadId: string) {
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    card.classList.add("cmt-card-pulse");
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      card.classList.remove("cmt-card-pulse");
      this.pulseTimer = 0;
    }, 1200);
  }

  // ===== Stale detection =====

  threadIsStale(thread: Thread): boolean {
    if (!isTextTarget(thread.target)) return false;
    // Pure check — see commentsStale.ts. The Map is supplied as-is; the
    // helper only reads `.hash` from each value so the BlockInfo's other
    // fields are irrelevant here.
    return compareSegmentHashes(
      textTargetParts(thread.target).blocks,
      this.index.blocksById,
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
      const block = this.index.blocksById.get(seg.id);
      if (!block) return;
      const isFirst = i === 0;
      const isLast = i === segs.length - 1;
      const fullLen = block.element.textContent?.length ?? 0;
      const start = isFirst ? parts.startOffset : 0;
      const end = isLast ? parts.endOffset : fullLen;
      wrapRangeInBlock(block.element, start, end, thread.id);
    }
  }

  // ===== Document click routing =====

  private onAnyClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Tap-outside-to-dismiss on mobile is handled by the Popover
    // API's light-dismiss (an `auto` popover closes on any
    // pointerdown outside it). The `toggle` event listener wired
    // in `buildCard` syncs `activeCardId` when that happens, so we
    // don't need to inspect the click target here.

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

// Entry point. NOT self-invoking: `client/commentsLoader.ts` is the tiny module
// the post loads eagerly; it `import()`s this one (emitted as its own chunk) and
// calls `boot()` on first reader engagement / idle, keeping this ~150 KB off the
// critical FCP/TBT path. So this file must export the starter and run nothing on
// import. (Architecture: methodology.md → Comments, "Loading: a lazy boot".)
export function boot(): void {
  new CommentSystem().init();
}
