// Comments: Google-Docs-style floating comments anchored to text selections
// (in the article body OR the spoken-script drawer) and to whole graphics
// (figures / images). v1 stores threads in localStorage keyed by the post's
// pathname — a future backend can sync from there.
//
// Text anchoring strategy
// -----------------------
// Every paragraph-level element inside a commentable root is a "segment".
// Each segment has a stable id (its DOM id if present, otherwise a
// synthesized `__b-<n>` index) and a sha256 of its normalized text content.
// A text anchor stores the *list* of segments the selection touches plus
// character offsets within the first and last segment. On render we re-hash
// each segment and mark the thread `outdated` when any hash mismatches —
// matching the user's "orphan + flag" preference.
//
// Graphic anchoring is far simpler: just the element id. The content of a
// graphic isn't text, so there's nothing to hash; if the graphic is
// replaced (same id, new contents) the comment intentionally follows.

const STORAGE_KEY_PREFIX = "blog-comments:";

type Context = "article" | "narration";

type TextAnchor = {
  kind: "text";
  context: Context;
  segments: Array<{ id: string; hash: string }>;
  startOffset: number;
  endOffset: number;
  // Verbatim text of the selection at creation time. Shown in the outdated-
  // comments list so the reader can find what the comment used to point at
  // even when the surrounding sentences have changed.
  quote: string;
};

type GraphicAnchor = {
  kind: "graphic";
  context: Context;
  id: string;
};

type Anchor = TextAnchor | GraphicAnchor;

type Reply = {
  id: string;
  body: string;
  createdAt: number;
  // No author/user fields in v1 (anonymous). Reserved for the future
  // backend-synced version where login provides identity.
};

type Thread = {
  id: string;
  anchor: Anchor;
  replies: Reply[];
  createdAt: number;
};

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

// Approximate vertical room occupied by the narration dock (chapter strip +
// Shikwasa player). The popover keeps clear of this band so it never sits
// under the player. If a post has no narrator dock the extra reserve is
// harmless slack.
const DOCK_RESERVE_PX = 160;

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

function storageKey(): string {
  return STORAGE_KEY_PREFIX + window.location.pathname;
}

function loadThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Thread[];
  } catch {
    return [];
  }
}

function saveThreads(threads: Thread[]): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(threads));
  } catch (err) {
    console.warn("Failed to persist comments:", err);
  }
}

// Walk descendants of `root` in document order, yielding elements matching
// `tagSet`. Doesn't recurse into matched elements (block tags are leaves in
// our authoring style).
function* walkBlocks(
  root: Element,
  tagSet: Set<string>,
): Generator<HTMLElement> {
  // Iterative DFS so we can short-circuit. Children pushed in reverse order
  // so popping yields them left-to-right.
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

// Returns the in-block character offset for a (node, offset) pair. We sum
// the text-node lengths encountered while walking through `block` up until
// we reach `node`. Element-targeted offsets (e.g., from clicking past a
// `<br>`) fall back to "end of nearest text content".
function offsetInBlock(block: HTMLElement, node: Node, offset: number): number {
  // If `node` is the block itself (range edge landed on element), interpret
  // `offset` as a child-element count and translate to text length.
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
  // Fallback: node wasn't inside the block (shouldn't happen if we picked
  // the block via closest()) — return end of text.
  return block.textContent?.length ?? 0;
}

// Inverse of offsetInBlock: returns the (textNode, offsetWithinNode) pair
// representing the given character offset measured from the block's start.
function nodeAtOffset(
  block: HTMLElement,
  charOffset: number,
): { node: Node; offset: number } | null {
  let remaining = charOffset;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const len = n.nodeValue?.length ?? 0;
    if (remaining <= len) {
      return { node: n, offset: remaining };
    }
    remaining -= len;
  }
  // Past the end → return last node at its end.
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
  return (el as Element).closest<HTMLElement>(
    "[data-comment-block-id]",
  );
}

function findGraphicFor(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
  if (!el) return null;
  return (el as Element).closest<HTMLElement>(
    "[data-comment-graphic-id]",
  );
}

class CommentSystem {
  private articleRoot: HTMLElement | null = null;
  private drawerRoot: HTMLElement | null = null;
  private threads: Thread[] = [];
  // Block index in document order, separated by context (article vs drawer).
  private blocksByContext = new Map<Context, BlockInfo[]>();
  private blocksById = new Map<string, BlockInfo>();
  private graphicsById = new Map<string, HTMLElement>();

  // Floating UI elements.
  private actionBar: HTMLDivElement | null = null;
  private popover: HTMLDivElement | null = null;
  private outdatedPill: HTMLButtonElement | null = null;

  // The pending selection captured when the action bar was shown.
  private pendingRange: Range | null = null;
  private pendingStartBlock: BlockInfo | null = null;
  private pendingEndBlock: BlockInfo | null = null;

  async init() {
    this.articleRoot = document.querySelector<HTMLElement>(
      "[data-narration-src]",
    );
    if (!this.articleRoot) return;

    await this.indexArticle();

    // The narrator drawer is appended asynchronously after fetching the
    // manifest. Watch for it; if it never arrives (e.g. manifest missing),
    // commenting still works on the article.
    const existing = document.querySelector<HTMLElement>(".narrate-drawer");
    if (existing) {
      await this.indexDrawer(existing);
    } else {
      const obs = new MutationObserver(async () => {
        const d = document.querySelector<HTMLElement>(".narrate-drawer");
        if (d) {
          obs.disconnect();
          await this.indexDrawer(d);
          await this.renderAllThreads();
        }
      });
      obs.observe(document.body, { childList: true, subtree: false });
    }

    this.threads = loadThreads();
    await this.renderAllThreads();

    this.mountActionBar();
    this.mountPopover();
    this.installGraphicTriggers();

    document.addEventListener("selectionchange", () => this.onSelectionChange());
    document.addEventListener("mousedown", (e) => this.onMaybeDismiss(e));
    document.addEventListener("click", (e) => this.onAnyClick(e));
    window.addEventListener("scroll", () => this.repositionFloating(), {
      passive: true,
    });
    window.addEventListener("resize", () => this.repositionFloating());
  }

  // ----- Indexing -----

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

    // Graphics: annotate each so it becomes a click target. The hover
    // button itself is mounted by `installGraphicTriggers` after the
    // popover/action bar exist.
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

  // ----- Selection → action bar -----

  private mountActionBar() {
    const bar = document.createElement("div");
    bar.className = "cmt-action-bar";
    bar.hidden = true;
    bar.innerHTML =
      '<button type="button" class="cmt-action-btn">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
      "<span>Comment</span></button>";
    bar.querySelector("button")!.addEventListener("mousedown", (e) => {
      // mousedown (not click) so the selection isn't lost to a focus event
      // before we capture it.
      e.preventDefault();
      this.openComposeForSelection();
    });
    document.body.appendChild(bar);
    this.actionBar = bar;
  }

  private onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideActionBar();
      return;
    }
    // Ignore selections initiated inside our own popover.
    const range = sel.getRangeAt(0);
    if (this.popover && this.popover.contains(range.startContainer)) {
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
    // Position above the top of the selection, clamped to viewport.
    const barW = this.actionBar.offsetWidth || 110;
    const barH = this.actionBar.offsetHeight || 32;
    const top = window.scrollY + rect.top - barH - 8;
    let left = window.scrollX + rect.left + rect.width / 2 - barW / 2;
    left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - barW - 8));
    this.actionBar.style.top = `${top}px`;
    this.actionBar.style.left = `${left}px`;
  }

  private hideActionBar() {
    if (this.actionBar) this.actionBar.hidden = true;
    this.pendingRange = null;
    this.pendingStartBlock = null;
    this.pendingEndBlock = null;
  }

  // ----- Compose / popover -----

  private mountPopover() {
    const pop = document.createElement("div");
    pop.className = "cmt-popover";
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Comments");
    pop.innerHTML =
      '<div class="cmt-popover-arrow" aria-hidden="true"></div>' +
      '<header class="cmt-popover-header">' +
      '<span class="cmt-popover-title">Comments</span>' +
      '<span class="cmt-draft-tag" hidden>Draft</span>' +
      '<button type="button" class="cmt-popover-close" aria-label="Close">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
      "</header>" +
      '<div class="cmt-popover-body"></div>' +
      '<footer class="cmt-popover-footer">' +
      '<textarea class="cmt-reply-input" rows="2" placeholder="Add a comment&hellip;"></textarea>' +
      '<div class="cmt-reply-row">' +
      '<button type="button" class="cmt-reply-cancel">Cancel</button>' +
      '<button type="button" class="cmt-reply-submit">Comment</button>' +
      "</div></footer>";
    pop.querySelector(".cmt-popover-close")!.addEventListener("click", () => {
      this.closePopover();
    });
    pop.querySelector(".cmt-reply-cancel")!.addEventListener("click", () => {
      this.closePopover();
    });
    pop.querySelector(".cmt-reply-submit")!.addEventListener("click", () => {
      this.submitReply();
    });
    // Cmd/Ctrl+Enter to submit
    const input = pop.querySelector<HTMLTextAreaElement>(".cmt-reply-input")!;
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submitReply();
      }
    });
    // Surface a "Draft" badge in the header whenever the textarea has
    // content — clarifies that the popover is staying open *because* of
    // unsaved work (click-outside is silently refused, see onMaybeDismiss).
    input.addEventListener("input", () => this.updateDraftIndicator());
    document.body.appendChild(pop);
    this.popover = pop;
  }

  private async openComposeForSelection() {
    if (!this.pendingRange || !this.pendingStartBlock || !this.pendingEndBlock) {
      return;
    }
    if (this.pendingStartBlock.context !== this.pendingEndBlock.context) return;

    // Determine the ordered list of segments spanned and offsets.
    const blocks = this.blocksByContext.get(this.pendingStartBlock.context) ?? [];
    const startIdx = blocks.indexOf(this.pendingStartBlock);
    const endIdx = blocks.indexOf(this.pendingEndBlock);
    if (startIdx === -1 || endIdx === -1) return;
    const [a, b] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    const touched = blocks.slice(a, b + 1);

    const rangeForwards = startIdx <= endIdx;
    const startBlock = rangeForwards ? this.pendingStartBlock : this.pendingEndBlock;
    const endBlock = rangeForwards ? this.pendingEndBlock : this.pendingStartBlock;
    const startNode = rangeForwards ? this.pendingRange.startContainer : this.pendingRange.endContainer;
    const startNodeOffset = rangeForwards ? this.pendingRange.startOffset : this.pendingRange.endOffset;
    const endNode = rangeForwards ? this.pendingRange.endContainer : this.pendingRange.startContainer;
    const endNodeOffset = rangeForwards ? this.pendingRange.endOffset : this.pendingRange.startOffset;

    const startOffset = offsetInBlock(startBlock.element, startNode, startNodeOffset);
    const endOffset = offsetInBlock(endBlock.element, endNode, endNodeOffset);

    const quote = this.pendingRange.toString();

    const anchor: TextAnchor = {
      kind: "text",
      context: this.pendingStartBlock.context,
      segments: touched.map((b) => ({ id: b.id, hash: b.hash })),
      startOffset,
      endOffset,
      quote,
    };

    // Build a new (empty) thread; the user's first reply is added on submit.
    const thread: Thread = {
      id: uid(),
      anchor,
      replies: [],
      createdAt: Date.now(),
    };
    this.openPopoverForThread(thread, /*isNew=*/ true);
    this.hideActionBar();
  }

  private openComposeForGraphic(graphicEl: HTMLElement) {
    const id = graphicEl.dataset.commentGraphicId;
    const ctx = (graphicEl.dataset.commentContext as Context) ?? "article";
    if (!id) return;
    const anchor: GraphicAnchor = { kind: "graphic", context: ctx, id };
    const existing = this.threads.find(
      (t) => t.anchor.kind === "graphic" && t.anchor.id === id,
    );
    if (existing) {
      this.openPopoverForThread(existing, false);
      return;
    }
    const thread: Thread = {
      id: uid(),
      anchor,
      replies: [],
      createdAt: Date.now(),
    };
    this.openPopoverForThread(thread, true);
  }

  // The thread currently displayed in the popover. `isNewThread` means the
  // thread isn't yet persisted — the submit handler will append it on save.
  private currentThread: Thread | null = null;
  private currentIsNew = false;

  private openPopoverForThread(thread: Thread, isNew: boolean) {
    if (!this.popover) return;
    this.currentThread = thread;
    this.currentIsNew = isNew;
    // Footer may have been hidden by the outdated-list view; restore.
    const footer = this.popover.querySelector<HTMLElement>(".cmt-popover-footer");
    if (footer) footer.style.display = "";
    const input = this.popover.querySelector<HTMLTextAreaElement>(
      ".cmt-reply-input",
    );
    if (input) input.value = "";
    this.updateDraftIndicator();
    this.renderPopover();
    this.popover.hidden = false;
    this.repositionPopover();
    input?.focus();
  }

  private closePopover() {
    if (!this.popover) return;
    this.popover.hidden = true;
    this.currentThread = null;
    this.currentIsNew = false;
    // If user cancelled before adding any reply, the thread isn't in
    // `this.threads` so there's nothing to clean up.
  }

  private renderPopover() {
    if (!this.popover || !this.currentThread) return;
    const body = this.popover.querySelector<HTMLDivElement>(
      ".cmt-popover-body",
    )!;
    const submitBtn = this.popover.querySelector<HTMLButtonElement>(
      ".cmt-reply-submit",
    )!;
    body.innerHTML = "";

    // Anchor preview (quote or "graphic")
    const preview = document.createElement("div");
    preview.className = "cmt-anchor-preview";
    if (this.currentThread.anchor.kind === "text") {
      const stale = this.threadIsStale(this.currentThread);
      preview.innerHTML =
        `<span class="cmt-quote-text"></span>` +
        (stale ? '<span class="cmt-stale-tag">outdated</span>' : "");
      preview.querySelector(".cmt-quote-text")!.textContent =
        this.currentThread.anchor.quote;
    } else {
      preview.innerHTML =
        '<span class="cmt-quote-text">Comment on graphic</span>';
    }
    body.appendChild(preview);

    if (this.currentThread.replies.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cmt-empty";
      empty.textContent = this.currentIsNew
        ? "Start the thread below."
        : "No comments yet.";
      body.appendChild(empty);
    } else {
      const list = document.createElement("ol");
      list.className = "cmt-reply-list";
      for (const reply of this.currentThread.replies) {
        const li = document.createElement("li");
        li.className = "cmt-reply";
        const meta = document.createElement("div");
        meta.className = "cmt-reply-meta";
        meta.innerHTML =
          '<span class="cmt-reply-author">Anonymous</span>' +
          `<time class="cmt-reply-time" datetime="${new Date(reply.createdAt).toISOString()}">${formatRelative(reply.createdAt)}</time>`;
        const text = document.createElement("p");
        text.className = "cmt-reply-text";
        text.textContent = reply.body;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "cmt-reply-delete";
        del.setAttribute("aria-label", "Delete this comment");
        del.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        del.addEventListener("click", () => this.deleteReply(reply.id));
        li.appendChild(meta);
        li.appendChild(text);
        li.appendChild(del);
        list.appendChild(li);
      }
      body.appendChild(list);
    }

    submitBtn.textContent = this.currentThread.replies.length === 0 ? "Comment" : "Reply";
  }

  private submitReply() {
    if (!this.popover || !this.currentThread) return;
    const input = this.popover.querySelector<HTMLTextAreaElement>(
      ".cmt-reply-input",
    )!;
    const body = input.value.trim();
    if (!body) return;
    const reply: Reply = {
      id: uid(),
      body,
      createdAt: Date.now(),
    };
    this.currentThread.replies.push(reply);
    // First save: register the thread.
    if (this.currentIsNew) {
      this.threads.push(this.currentThread);
      this.currentIsNew = false;
    }
    saveThreads(this.threads);
    input.value = "";
    this.updateDraftIndicator();
    this.renderPopover();
    this.renderAllThreads();
  }

  private deleteReply(replyId: string) {
    if (!this.currentThread) return;
    this.currentThread.replies = this.currentThread.replies.filter(
      (r) => r.id !== replyId,
    );
    if (this.currentThread.replies.length === 0) {
      // No replies left → remove the entire thread.
      this.threads = this.threads.filter((t) => t.id !== this.currentThread!.id);
      saveThreads(this.threads);
      this.closePopover();
      this.renderAllThreads();
      return;
    }
    saveThreads(this.threads);
    this.renderPopover();
    this.renderAllThreads();
  }

  // ----- Rendering existing threads (highlights + outdated pill) -----

  private async renderAllThreads() {
    // Clear all existing highlight spans first so re-renders are clean.
    document
      .querySelectorAll<HTMLElement>(".cmt-highlight")
      .forEach((s) => this.unwrap(s));
    document
      .querySelectorAll<HTMLElement>(".cmt-graphic-indicator")
      .forEach((n) => n.remove());

    const outdated: Thread[] = [];
    for (const thread of this.threads) {
      if (thread.anchor.kind === "graphic") {
        const el = this.graphicsById.get(thread.anchor.id);
        if (el) this.addGraphicIndicator(el, thread);
        else outdated.push(thread);
        continue;
      }
      if (this.threadIsStale(thread)) {
        outdated.push(thread);
        continue;
      }
      this.highlightTextThread(thread);
    }
    this.updateOutdatedPill(outdated);
  }

  private threadIsStale(thread: Thread): boolean {
    if (thread.anchor.kind !== "text") return false;
    for (const seg of thread.anchor.segments) {
      const block = this.blocksById.get(seg.id);
      if (!block) return true;
      if (block.hash !== seg.hash) return true;
    }
    return false;
  }

  private highlightTextThread(thread: Thread) {
    if (thread.anchor.kind !== "text") return;
    const segs = thread.anchor.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const block = this.blocksById.get(seg.id);
      if (!block) return; // bail; treated stale at top-level
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
    // For ranges that cross multiple text nodes, surroundContents throws.
    // Walk and wrap each fully-contained text node, plus partial start/end.
    this.wrapRange(range, threadId);
  }

  private wrapRange(range: Range, threadId: string) {
    // Collect every text node the range touches (we then wrap each — partial
    // for start/end, full for the middle). `intersectsNode` keeps us out of
    // the historically-confusing `compareBoundaryPoints` constant ordering.
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
      // splitText returns the second half; we always end up wrapping the
      // middle piece (the part that fell inside the range).
      if (endInNode < nodeLen) target.splitText(endInNode);
      if (startInNode > 0) target = target.splitText(startInNode);
      const span = document.createElement("span");
      span.className = "cmt-highlight";
      span.dataset.threadId = threadId;
      target.parentNode!.insertBefore(span, target);
      span.appendChild(target);
    }
  }

  // Replace a highlight span with its children. Splits and merges adjacent
  // text nodes so subsequent re-wraps see a flat tree.
  private unwrap(span: HTMLElement) {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  // ----- Graphics: hover trigger + indicator -----

  private installGraphicTriggers() {
    for (const [id, el] of this.graphicsById) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmt-graphic-btn";
      btn.setAttribute("aria-label", "Comment on this graphic");
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openComposeForGraphic(el);
      });
      // Make the graphic a positioned container so the button can sit in
      // its top-right corner. We don't want to disturb authored styles, so
      // only set position when it's currently 'static'.
      const cs = getComputedStyle(el);
      if (cs.position === "static") el.style.position = "relative";
      el.appendChild(btn);
    }
  }

  private addGraphicIndicator(el: HTMLElement, thread: Thread) {
    const dot = document.createElement("span");
    dot.className = "cmt-graphic-indicator";
    dot.dataset.threadId = thread.id;
    dot.title = `${thread.replies.length} comment${thread.replies.length === 1 ? "" : "s"}`;
    dot.textContent = String(thread.replies.length);
    el.appendChild(dot);
  }

  // ----- Outdated comments pill (bottom-left) -----

  private updateOutdatedPill(outdated: Thread[]) {
    if (outdated.length === 0) {
      this.outdatedPill?.remove();
      this.outdatedPill = null;
      return;
    }
    if (!this.outdatedPill) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmt-outdated-pill";
      btn.addEventListener("click", () => this.showOutdatedList(outdated));
      document.body.appendChild(btn);
      this.outdatedPill = btn;
    }
    this.outdatedPill.textContent = `${outdated.length} outdated comment${outdated.length === 1 ? "" : "s"}`;
    this.outdatedPill.dataset.count = String(outdated.length);
  }

  private showOutdatedList(outdated: Thread[]) {
    // Reuse the popover layout: pop it open with no anchor, showing the
    // collection of orphaned threads. Clicking one opens it for review /
    // deletion.
    if (!this.popover) return;
    this.currentThread = null;
    this.currentIsNew = false;
    const body = this.popover.querySelector<HTMLDivElement>(
      ".cmt-popover-body",
    )!;
    const footer = this.popover.querySelector<HTMLElement>(
      ".cmt-popover-footer",
    )!;
    body.innerHTML = "";
    footer.style.display = "none";
    const heading = document.createElement("div");
    heading.className = "cmt-anchor-preview";
    heading.innerHTML = '<span class="cmt-stale-tag">outdated</span><span class="cmt-quote-text">These threads no longer match the document.</span>';
    body.appendChild(heading);
    const list = document.createElement("ol");
    list.className = "cmt-reply-list cmt-outdated-list";
    for (const thread of outdated) {
      const li = document.createElement("li");
      li.className = "cmt-reply cmt-outdated-item";
      const quote = thread.anchor.kind === "text"
        ? `"${thread.anchor.quote}"`
        : "(graphic)";
      const firstBody = thread.replies[0]?.body ?? "(empty)";
      const meta = document.createElement("div");
      meta.className = "cmt-reply-meta";
      meta.innerHTML = `<span class="cmt-reply-author">${formatRelative(thread.createdAt)}</span><span class="cmt-quote-text"></span>`;
      meta.querySelector(".cmt-quote-text")!.textContent = quote;
      const text = document.createElement("p");
      text.className = "cmt-reply-text";
      text.textContent = firstBody;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "cmt-reply-delete";
      open.setAttribute("aria-label", "Open this outdated thread");
      open.textContent = "Open";
      open.addEventListener("click", () => {
        footer.style.display = "";
        this.openPopoverForThread(thread, false);
      });
      li.appendChild(meta);
      li.appendChild(text);
      li.appendChild(open);
      list.appendChild(li);
    }
    body.appendChild(list);
    this.popover.hidden = false;
    // Position centered near the bottom-left pill.
    const pillRect = this.outdatedPill?.getBoundingClientRect();
    if (pillRect) {
      this.popover.style.top = `${window.scrollY + pillRect.top - this.popover.offsetHeight - 12}px`;
      this.popover.style.left = `${window.scrollX + pillRect.left}px`;
    }
  }

  // ----- Floating positioning + dismissal -----

  private repositionPopover() {
    if (!this.popover || this.popover.hidden || !this.currentThread) return;
    const thread = this.currentThread;
    let rect: DOMRect | null = null;
    if (thread.anchor.kind === "text") {
      const highlights = document.querySelectorAll<HTMLElement>(
        `.cmt-highlight[data-thread-id="${CSS.escape(thread.id)}"]`,
      );
      const firstHl = highlights[0];
      if (firstHl) {
        rect = firstHl.getBoundingClientRect();
      } else if (this.pendingRange && this.currentIsNew) {
        rect = this.pendingRange.getBoundingClientRect();
      } else {
        // Fall back to the first segment's bounding box.
        const firstSeg = thread.anchor.segments[0];
        const seg = firstSeg ? this.blocksById.get(firstSeg.id) : undefined;
        if (seg) rect = seg.element.getBoundingClientRect();
      }
    } else {
      const el = this.graphicsById.get(thread.anchor.id);
      if (el) rect = el.getBoundingClientRect();
    }
    if (!rect) return;
    const popW = this.popover.offsetWidth || 320;
    const popH = this.popover.offsetHeight || 180;

    // Prefer to the right of the selection when there's room; else left.
    const margin = 12;
    const viewportW = window.innerWidth;
    const spaceRight = viewportW - rect.right;
    const spaceLeft = rect.left;
    let left: number;
    if (spaceRight >= popW + margin) {
      left = window.scrollX + rect.right + margin;
    } else if (spaceLeft >= popW + margin) {
      left = window.scrollX + rect.left - popW - margin;
    } else {
      // Center horizontally if neither side fits.
      left = window.scrollX + Math.max(8, (viewportW - popW) / 2);
    }
    let top = window.scrollY + rect.top;
    // Keep the popover within the viewport vertically, leaving room at the
    // bottom for the narration dock (chapter strip + Shikwasa player).
    const viewportTop = window.scrollY + 8;
    const viewportBottom =
      window.scrollY + window.innerHeight - popH - DOCK_RESERVE_PX;
    top = Math.max(viewportTop, Math.min(top, viewportBottom));
    this.popover.style.top = `${top}px`;
    this.popover.style.left = `${left}px`;
  }

  private repositionFloating() {
    this.repositionPopover();
    if (this.actionBar && !this.actionBar.hidden && this.pendingRange) {
      this.showActionBarFor(this.pendingRange);
    }
  }

  private onMaybeDismiss(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Don't dismiss if click is inside the popover, action bar, or any
    // commentable highlight / graphic button.
    if (
      this.popover && this.popover.contains(target)
    ) return;
    if (this.actionBar && this.actionBar.contains(target)) return;
    if (target.closest(".cmt-highlight")) return;
    if (target.closest(".cmt-graphic-btn")) return;
    if (target.closest(".cmt-graphic-indicator")) return;
    if (target.closest(".cmt-outdated-pill")) return;
    if (this.popover && !this.popover.hidden) {
      // Preserve unsubmitted drafts — losing typed content to a stray
      // click-outside is the kind of thing that erodes trust in the tool.
      // The popover stays open with a "Draft" badge until the user either
      // submits, clicks Cancel, or clicks the X (both explicit discards).
      if (this.popoverHasDraft()) {
        this.flashDraft();
        return;
      }
      this.closePopover();
    }
  }

  private onAnyClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const hl = target.closest<HTMLElement>(".cmt-highlight");
    if (hl) {
      e.preventDefault();
      const tid = hl.dataset.threadId;
      // Already showing this thread → no-op.
      if (this.currentThread && this.currentThread.id === tid) return;
      // Switching threads with an unsubmitted draft would wipe it (we
      // share one textarea across all popovers); refuse and nudge the
      // user back to the draft.
      if (this.popoverHasDraft()) {
        this.flashDraft();
        this.popover?.querySelector<HTMLTextAreaElement>(
          ".cmt-reply-input",
        )?.focus();
        return;
      }
      const thread = this.threads.find((t) => t.id === tid);
      if (thread) this.openPopoverForThread(thread, false);
      return;
    }
    const ind = target.closest<HTMLElement>(".cmt-graphic-indicator");
    if (ind) {
      e.preventDefault();
      const tid = ind.dataset.threadId;
      if (this.currentThread && this.currentThread.id === tid) return;
      if (this.popoverHasDraft()) {
        this.flashDraft();
        this.popover?.querySelector<HTMLTextAreaElement>(
          ".cmt-reply-input",
        )?.focus();
        return;
      }
      const thread = this.threads.find((t) => t.id === tid);
      if (thread) this.openPopoverForThread(thread, false);
      return;
    }
  }

  // True if the popover is currently displayed AND its composer textarea
  // contains anything that the user would lose on dismiss.
  private popoverHasDraft(): boolean {
    if (!this.popover || this.popover.hidden) return false;
    const input = this.popover.querySelector<HTMLTextAreaElement>(
      ".cmt-reply-input",
    );
    return !!(input && input.value.trim().length > 0);
  }

  private updateDraftIndicator() {
    if (!this.popover) return;
    const tag = this.popover.querySelector<HTMLElement>(".cmt-draft-tag");
    if (!tag) return;
    tag.hidden = !this.popoverHasDraft();
  }

  // Brief animation that draws attention to the draft badge when the user
  // tries (and the system refuses) to dismiss the popover.
  private flashDraft() {
    if (!this.popover) return;
    const tag = this.popover.querySelector<HTMLElement>(".cmt-draft-tag");
    if (!tag) return;
    tag.classList.remove("cmt-flash");
    // Force reflow so re-adding the class restarts the animation.
    void tag.offsetWidth;
    tag.classList.add("cmt-flash");
  }
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const min = 60_000;
  if (diff < min) return "just now";
  if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function boot() {
  new CommentSystem().init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
