// methodology.md → Comments — the floating selection action bar (desktop) and
// the shared selection-capture used by both the bar and the mobile compose
// flow. Owns the `pending*` selection handoff that DraftManager consumes.

import type { CommentSystem } from "../comments.ts";
// The action bar hosts a "Copy link" button alongside "Comment" — see
// citationLink.ts. `setCommentBarActive` tells the standalone citation button to
// step aside so a logged-in reader sees one bar, not two competing dark pills.
import {
  citationForRange,
  isInspectableSelectionNode,
  prewarmCitationGenerator,
  setCommentBarActive,
} from "../citationLink.ts";
import { copyToClipboard } from "../clipboard.ts";
import { findBlockFor } from "./highlights.ts";
import type { BlockInfo } from "./blockIndex.ts";

// A validated article-text selection: the range plus the comment-blocks its
// ends fall in (same context). Returned by `captureSelection`; feeds both the
// desktop action bar and the mobile compose flow.
export type SelectionCapture = {
  range: Range;
  startBlock: BlockInfo;
  endBlock: BlockInfo;
};

export class SelectionBar {
  constructor(private readonly sys: CommentSystem) {}

  // Floating bar that appears above a text selection: a "Comment" pill and a
  // sibling "Copy link" pill (the citation deep-link, generated lazily).
  actionBar: HTMLDivElement | null = null;
  private copyLinkBtn: HTMLButtonElement | null = null;
  pendingRange: Range | null = null;
  pendingStartBlock: BlockInfo | null = null;
  pendingEndBlock: BlockInfo | null = null;
  // Timer that resets the copy-link button's "Copied!" feedback.
  private citationFeedbackTimer: number | null = null;

  mountActionBar() {
    const bar = document.createElement("div");
    bar.className = "cmt-action-bar";
    bar.hidden = true;
    bar.innerHTML =
      '<button type="button" class="cmt-action-btn cmt-action-comment">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
      "<span>Comment</span></button>" +
      // Citation deep-link, shown alongside Comment from the moment the bar
      // appears (the icon mirrors the standalone button's quote-mark; see
      // citationLink.ts). The link is generated on click, not speculatively.
      '<button type="button" class="cmt-action-btn cmt-action-copylink" ' +
      'aria-label="Copy a link to the selected text" title="Copy a link to the selected text">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M9.5 13.5a3 3 0 0 0 4.5.3l2.5-2.5a3 3 0 0 0-4.3-4.3l-1.2 1.2M14.5 10.5a3 3 0 0 0-4.5-.3L7.5 12.7a3 3 0 0 0 4.3 4.3l1.2-1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<span class="cmt-action-copylink-label">Copy link</span></button>';
    // mousedown (not click) so the selection isn't lost to a focus event
    // before we capture it.
    const commentBtn = bar.querySelector<HTMLButtonElement>(".cmt-action-comment")!;
    commentBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.sys.draftMgr.addDraftForSelection();
    });
    const copyBtn = bar.querySelector<HTMLButtonElement>(".cmt-action-copylink")!;
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void this.copyCitationFromBar();
    });
    this.copyLinkBtn = copyBtn;
    document.body.appendChild(bar);
    this.actionBar = bar;
  }

  // Generate the citation link for the current selection and copy it. Done on
  // CLICK, not speculatively per selection — so nothing expensive runs on the
  // (continuous) selectionchange path, and "Copy link" shows alongside "Comment"
  // from the start instead of popping in after a generation. The generator chunk
  // is pre-warmed when the bar appears (see showActionBarFor), so this await is
  // just the synchronous generateFragment; the clipboard write stays well within
  // the gesture's transient-activation window either way.
  private async copyCitationFromBar() {
    const copyBtn = this.copyLinkBtn;
    const range = this.pendingRange;
    if (!copyBtn || !range || !this.sys.articleRoot) return;
    const choice = await citationForRange(range.cloneRange(), this.sys.articleRoot);
    // citationForRange returns a section fallback for almost any selection;
    // the clean page URL is only a last resort (selection before any heading).
    const href = choice?.href ?? `${location.origin}${location.pathname}`;
    const ok = await copyToClipboard(href);
    if (!ok) return;
    const label = copyBtn.querySelector(".cmt-action-copylink-label");
    if (label) label.textContent = "Copied!";
    copyBtn.classList.add("cmt-action-copied");
    if (this.citationFeedbackTimer !== null) window.clearTimeout(this.citationFeedbackTimer);
    this.citationFeedbackTimer = window.setTimeout(() => {
      if (label) label.textContent = "Copy link";
      copyBtn.classList.remove("cmt-action-copied");
      this.citationFeedbackTimer = null;
    }, 1200);
  }

  // Validate the current selection as a commentable article-text range. Pure
  // (no identity / no side effects) so it can drive both the desktop action
  // bar and the mobile button-press compose capture. Returns null unless the
  // selection is non-empty, lands outside our own UI, and both ends sit in
  // comment-blocks of the same context.
  captureSelection(): SelectionCapture | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    // Some `selectionchange` events anchor in nodes we can't safely touch (e.g.
    // native-anonymous media/seek-bar content); both `.contains()` below and the
    // `blockForNode` tree-walk would throw on them. See isInspectableSelectionNode.
    if (!isInspectableSelectionNode(range.startContainer) || !isInspectableSelectionNode(range.endContainer)) {
      return null;
    }
    // Ignore selections originating inside our own UI (column / cards / menu).
    if (this.sys.column?.contains(range.startContainer)) return null;
    if (this.sys.menuEl?.contains(range.startContainer)) return null;
    const startBlock = this.blockForNode(range.startContainer);
    const endBlock = this.blockForNode(range.endContainer);
    if (!startBlock || !endBlock || startBlock.context !== endBlock.context) {
      return null;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { range: range.cloneRange(), startBlock, endBlock };
  }

  onSelectionChange() {
    const capture = this.captureSelection();

    // Mobile: no floating action bar — the corner button is the
    // entry point. Just reflect whether there's something to comment on so the
    // button can pulse ("comment on what you selected"). The actual range is
    // grabbed at button-press time (pointerdown), since reaching for the button
    // collapses this selection. Shown logged-out too — the menu routes to
    // sign-in (JIT). The body class drives the pulse cue (CSS, reduced-motion
    // aware).
    if (this.sys.isMobile) {
      document.body.classList.toggle("cmt-has-selection", !!capture);
      return;
    }

    // Desktop: no commenting without login — keep the action bar suppressed so
    // text selection doesn't promise a feature the user can't use (the column
    // header carries the sign-in affordance).
    if (!this.sys.identity || !capture) {
      this.hideActionBar();
      return;
    }
    this.pendingRange = capture.range;
    this.pendingStartBlock = capture.startBlock;
    this.pendingEndBlock = capture.endBlock;
    this.showActionBarFor(capture.range);
  }

  private blockForNode(node: Node): BlockInfo | null {
    const block = findBlockFor(node);
    if (!block) return null;
    const id = block.dataset.commentBlockId;
    if (!id) return null;
    return this.sys.index.blocksById.get(id) ?? null;
  }

  showActionBarFor(range: Range) {
    if (!this.actionBar) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideActionBar();
      return;
    }
    this.actionBar.hidden = false;
    // Tell the standalone citation button to step aside — this bar now hosts the
    // "Copy link" action — and pre-warm the generator chunk so the on-click copy
    // is instant (generation itself happens on click, not here).
    setCommentBarActive(true);
    prewarmCitationGenerator();
    this.positionActionBar(range);
  }

  // Centre the bar above the selection. Re-run when the bar's width changes
  // (e.g. the "Copy link" button appears after async generation) so it stays
  // centred. Absolute coords keep it anchored as the page scrolls.
  private positionActionBar(range: Range) {
    if (!this.actionBar || this.actionBar.hidden) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
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

  hideActionBar() {
    if (this.actionBar) this.actionBar.hidden = true;
    // Release the standalone citation button to act again, and clear any
    // lingering "Copied!" feedback so the next selection's bar starts clean.
    setCommentBarActive(false);
    if (this.citationFeedbackTimer !== null) {
      window.clearTimeout(this.citationFeedbackTimer);
      this.citationFeedbackTimer = null;
    }
    if (this.copyLinkBtn) {
      this.copyLinkBtn.classList.remove("cmt-action-copied");
      const label = this.copyLinkBtn.querySelector(".cmt-action-copylink-label");
      if (label) label.textContent = "Copy link";
    }
    this.pendingRange = null;
    this.pendingStartBlock = null;
    this.pendingEndBlock = null;
  }
}
