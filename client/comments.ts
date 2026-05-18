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
  type Anchor,
  type Context,
  type GraphicAnchor,
  type Reply,
  type TextAnchor,
  type Thread,
} from "./commentsStore.ts";
import {
  loadIdentity,
  loginUrl,
  signOut,
  type Identity,
} from "./identity.ts";

type BlockInfo = {
  id: string;
  element: HTMLElement;
  context: Context;
  hash: string;
  text: string;
};

const BLOCK_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "LI", "BLOCKQUOTE", "PRE", "FIGCAPTION",
]);
// v1: only `<figure>` is a commentable graphic. The authoring convention
// (per methodology.md) wraps each graphic in a figure with an id, and that
// lets us attach an HTML button child without worrying about SVG namespace
// or `<img>` being a void element. Standalone <svg>/<img>/<canvas> would
// need a wrapper before we could place the trigger; we can add that later.
const GRAPHIC_ROOT_TAGS = new Set(["FIGURE"]);

// Cards stack with this much vertical space between them when collision-
// avoidance pushes a later card past its preferred anchor-aligned top.
const CARD_GAP_PX = 8;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Walk descendants of `root` in document order, yielding elements matching
// `tagSet`. Doesn't recurse into matched elements (block tags are leaves in
// our authoring style).
function* walkBlocks(
  root: Element,
  tagSet: Set<string>,
): Generator<HTMLElement> {
  const stack: Element[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node !== root) {
      if (node.tagName === "SCRIPT" || node.tagName === "STYLE") continue;
      if (tagSet.has(node.tagName)) {
        yield node as HTMLElement;
        continue;
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]!);
    }
  }
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

  // Header in the column showing "Signed in as ..." or the login pane
  // when not authenticated. Rendered once at init, re-rendered on
  // identity change (currently only at boot).
  private identityHeader: HTMLElement | null = null;
  // In-memory drafts — a freshly composed thread that the user hasn't
  // submitted yet. Promoted to the store on first reply, removed on
  // Cancel. Deliberately not in the CRDT: drafts shouldn't sync to a
  // server (or to the user's other devices) until the user commits.
  private drafts: Thread[] = [];
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
    this.installGraphicTriggers();
    this.renderIdentityHeader();

    if (this.identity) {
      // Spin up the CRDT-backed store. This is the only place we await
      // Automerge's WASM load — once `create()` returns the store is
      // fully hydrated and all UI handlers can safely call its mutation
      // methods.
      this.store = await CommentStore.create(
        window.location.pathname,
        this.identity.userId,
      );
      this.snapshot = this.store.snapshot();
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
      const stableId = el.id && el.id.length > 0
        ? `id:${el.id}`
        : `${context}:__b-${counter}`;
      el.dataset.commentBlockId = stableId;
      el.dataset.commentContext = context;
      const text = el.textContent ?? "";
      const hash = await sha256(normalizeText(text));
      const info: BlockInfo = { id: stableId, element: el, context, hash, text };
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

  // ===== Column =====

  private mountColumn() {
    const col = document.createElement("aside");
    col.id = "cmt-column";
    col.className = "cmt-column";
    col.setAttribute("role", "complementary");
    col.setAttribute("aria-label", "Comments");
    document.body.appendChild(col);
    this.column = col;

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
    }
  }

  private buildProviderLink(provider: "google" | "microsoft", label: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = `cmt-identity-provider cmt-identity-provider-${provider}`;
    a.href = loginUrl(provider);
    a.textContent = label;
    return a;
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

  // Master render: redraws cards, highlights, and indicators from scratch.
  // Cheap enough at our scale (a handful of threads per post) that we
  // don't bother diffing.
  private renderAll() {
    if (!this.column) return;

    // Highlights: wipe and re-apply (only for non-stale, non-resolved
    // text threads — resolved threads must leave no visual trace).
    document.querySelectorAll<HTMLElement>(".cmt-highlight").forEach((s) =>
      this.unwrap(s),
    );
    for (const thread of this.snapshot) {
      if (isResolved(thread)) continue;
      if (thread.anchor.kind === "text" && !this.threadIsStale(thread)) {
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
      if (isResolved(thread)) continue;
      const isStale = thread.anchor.kind === "text"
        && this.threadIsStale(thread);
      if (this.hiddenCardIds.has(thread.id) && !isStale) continue;
      const card = this.buildCard(thread);
      this.column.appendChild(card);
      this.cardEls.set(thread.id, card);
    }

    this.updateGraphicIndicators();
    this.repositionCards();
  }

  // Build a single card. Cards reflect both saved threads and unsubmitted
  // drafts; we distinguish them via `data-draft="true"` so CSS can frame
  // drafts distinctly and so the composer's Cancel button can do the
  // right thing (discard the draft entirely vs. just clear the reply box).
  private buildCard(thread: Thread): HTMLElement {
    const isDraft = this.drafts.includes(thread);
    const isStale = !isDraft && thread.anchor.kind === "text"
      && this.threadIsStale(thread);

    const card = document.createElement("article");
    card.className = "cmt-card";
    card.dataset.threadId = thread.id;
    card.dataset.kind = thread.anchor.kind;
    if (isDraft) card.dataset.draft = "true";
    if (isStale) card.dataset.stale = "true";

    // --- Anchor preview ---
    const preview = document.createElement("div");
    preview.className = "cmt-anchor-preview";
    if (thread.anchor.kind === "text") {
      const quote = document.createElement("span");
      quote.className = "cmt-quote-text";
      quote.textContent = thread.anchor.quote;
      preview.appendChild(quote);
      if (isStale) {
        const tag = document.createElement("span");
        tag.className = "cmt-stale-tag";
        tag.textContent = "outdated";
        preview.appendChild(tag);
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
    // Stop card-click bubbling from inside the textarea (would re-trigger
    // anchor scrolling on every click while typing).
    ta.addEventListener("click", (e) => e.stopPropagation());
    composer.appendChild(ta);

    const row = document.createElement("div");
    row.className = "cmt-reply-row";

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
          this.renderAll();
        } else {
          this.hiddenCardIds.add(thread.id);
          this.renderAll();
        }
      });
      row.appendChild(cancel);
    }

    // Resolve — decisive, permanent dismiss. Available on every saved
    // thread (including stale, where it's often *the* right action). Not
    // shown on drafts: there's nothing to resolve yet, and Cancel already
    // covers "throw this away."
    if (!isDraft) {
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "cmt-reply-resolve";
      resolve.textContent = "Resolve";
      resolve.title =
        "Resolve this thread — hides it permanently and queues a delete to sync to the server";
      resolve.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.store) return;
        // Also drop any session-only "hide" mark so the thread isn't
        // stuck in the hidden set forever after being resolved.
        this.hiddenCardIds.delete(thread.id);
        this.store.resolveThread(thread.id, Date.now());
        this.refreshSnapshotAndRender();
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
        this.store.addThread(thread.id, thread.anchor, thread.createdAt);
        this.store.addReply(thread.id, reply);
        this.drafts = this.drafts.filter((t) => t.id !== thread.id);
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

  // Re-pull the JSON snapshot from the store and re-render. Called after
  // every mutation so the UI always reflects current doc state.
  private refreshSnapshotAndRender() {
    if (!this.store) return;
    this.snapshot = this.store.snapshot();
    this.renderAll();
  }

  // Vertically align each card with its anchor's top, then push later
  // cards down to avoid overlap. Stale text threads (no highlight) fall
  // back to their first segment's position; if even that segment is gone,
  // we stack them at the page bottom.
  private repositionCards() {
    if (!this.column) return;

    const items: Array<{
      card: HTMLElement;
      thread: Thread;
      target: number;
    }> = [];
    const docHeight = document.documentElement.scrollHeight;
    for (const [tid, card] of this.cardEls) {
      const thread = this.snapshot.find((t) => t.id === tid)
        ?? this.drafts.find((t) => t.id === tid);
      if (!thread) continue;
      const target = this.computeAnchorTop(thread) ?? docHeight + 200;
      items.push({ card, thread, target });
    }
    items.sort((a, b) => a.target - b.target);

    // The identity header sits at the top of the column in normal flow,
    // but cards are absolutely positioned and would otherwise stack
    // starting at column-top = 0. Start `prevBottom` past the header so
    // the first card lands below it instead of behind it.
    const headerHeight = this.identityHeader?.offsetHeight ?? 0;
    let prevBottom = headerHeight > 0 ? headerHeight - CARD_GAP_PX : 0;
    for (const { card, target } of items) {
      const top = Math.max(target, prevBottom + CARD_GAP_PX);
      card.style.top = `${top}px`;
      // Use offsetHeight after the style.top write — height is independent
      // of top so reading offsetHeight here is safe.
      prevBottom = top + card.offsetHeight;
    }
  }

  private computeAnchorTop(thread: Thread): number | null {
    if (thread.anchor.kind === "text") {
      // Prefer the first highlight (matches exactly where the comment
      // points); fall back to the first segment block (works for stale
      // threads when the segment still exists, just with different text).
      const hl = document.querySelector<HTMLElement>(
        `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
      );
      if (hl) return hl.getBoundingClientRect().top + window.scrollY;
      const firstSeg = thread.anchor.segments[0];
      const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
      if (block) return block.element.getBoundingClientRect().top + window.scrollY;
      return null;
    }
    const el = this.graphicsById.get(thread.anchor.id);
    if (el) return el.getBoundingClientRect().top + window.scrollY;
    return null;
  }

  // Scroll the article so the anchor is visible, and briefly pulse the
  // matching highlight / graphic. Used when the user clicks on a card to
  // jump back to its anchor in the document.
  private scrollAnchorIntoView(thread: Thread) {
    let target: HTMLElement | null = null;
    if (thread.anchor.kind === "text") {
      target = document.querySelector<HTMLElement>(
        `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
      );
      if (!target) {
        const firstSeg = thread.anchor.segments[0];
        const block = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
        target = block?.element ?? null;
      }
    } else {
      target = this.graphicsById.get(thread.anchor.id) ?? null;
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

  // Triggered by the "Comment" action-bar button after a text selection.
  // Captures the selection into a TextAnchor, creates an empty draft, and
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
    const quote = this.pendingRange.toString();

    const anchor: TextAnchor = {
      kind: "text",
      context: this.pendingStartBlock.context,
      segments: touched.map((blk) => ({ id: blk.id, hash: blk.hash })),
      startOffset,
      endOffset,
      quote,
    };

    const draft: Thread = {
      id: uid(),
      anchor,
      replies: [],
      createdAt: Date.now(),
    };
    this.drafts.push(draft);
    this.hideActionBar();
    this.renderAll();
    this.focusDraft(draft.id);
  }

  // Triggered by clicking the "+" comment button on a figure.
  private addDraftForGraphic(graphicEl: HTMLElement) {
    const id = graphicEl.dataset.commentGraphicId;
    const ctx = (graphicEl.dataset.commentContext as Context) ?? "article";
    if (!id) return;
    const anchor: GraphicAnchor = { kind: "graphic", context: ctx, id };
    const draft: Thread = {
      id: uid(),
      anchor,
      replies: [],
      createdAt: Date.now(),
    };
    this.drafts.push(draft);
    this.renderAll();
    this.focusDraft(draft.id);
  }

  private focusDraft(threadId: string) {
    const card = this.cardEls.get(threadId);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    const ta = card.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
    ta?.focus();
  }

  // ===== Stale detection =====

  private threadIsStale(thread: Thread): boolean {
    if (thread.anchor.kind !== "text") return false;
    for (const seg of thread.anchor.segments) {
      const block = this.blocksById.get(seg.id);
      if (!block) return true;
      if (block.hash !== seg.hash) return true;
    }
    return false;
  }

  // ===== Highlight wrapping (DOM-mutating; reversed by `unwrap`) =====

  private highlightTextThread(thread: Thread) {
    if (thread.anchor.kind !== "text") return;
    const segs = thread.anchor.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const block = this.blocksById.get(seg.id);
      if (!block) return;
      const isFirst = i === 0;
      const isLast = i === segs.length - 1;
      const fullLen = block.element.textContent?.length ?? 0;
      const start = isFirst ? thread.anchor.startOffset : 0;
      const end = isLast ? thread.anchor.endOffset : fullLen;
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
          (t) => !isResolved(t)
            && t.anchor.kind === "graphic"
            && t.anchor.id === gid,
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
        if (first) this.scrollCardIntoView(first.id);
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
        (t) => !isResolved(t)
          && t.anchor.kind === "graphic"
          && t.anchor.id === gid,
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
    // Innermost (= the actual clicked span) scrolls to keep the focal
    // card most prominent.
    const innermost = ids[0];
    if (innermost) this.scrollCardIntoView(innermost);
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
