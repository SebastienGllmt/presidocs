// methodology.md → Comments — draft lifecycle: the unsubmitted, localStorage-
// persisted threads and their per-textarea body buffers, plus the create /
// discard / surface flows. Consumes SelectionBar's `pending*` handoff.

import type { CommentSystem } from "../comments.ts";
import {
  makeGraphicTarget,
  makeTextTarget,
  type Context,
  type Thread,
} from "../commentsStore.ts";
import { DraftsStorage } from "../draftsStorage.ts";
import { offsetInBlock } from "./highlights.ts";
import { scrollBehavior, uid } from "./util.ts";
import type { BlockInfo } from "./blockIndex.ts";

export class DraftManager {
  constructor(private readonly sys: CommentSystem) {}

  // Drafts — a freshly composed thread that the user hasn't submitted
  // yet. Promoted to the store on first reply, removed on Cancel.
  // Deliberately not in the CRDT: drafts shouldn't sync to a server
  // (or to the user's other devices) until the user commits. They DO
  // persist to localStorage so closing the tab doesn't lose work; see
  // `draftsStorage` and `draftBodies` below for the per-textarea
  // body-of-typing buffer that pairs with each draft thread.
  drafts: Thread[] = [];
  // In-progress textarea contents for each draft, keyed by thread id.
  // Updated on every keystroke (via the `input` event) and persisted
  // alongside `drafts`. Carries through reloads so the user sees their
  // half-typed comment when they come back.
  draftBodies = new Map<string, string>();
  // In-progress reply text for SAVED threads, keyed by thread id. The
  // saved-thread analogue of `draftBodies`: it lets a half-typed reply
  // survive a `renderAll()` card rebuild (e.g. the user starts a reply,
  // then opens a NEW comment — which selects article text, blurring the
  // reply box, so the focus-based capture/restore in `renderAll` can't
  // rescue it). Restored in `buildComposer`, written on every keystroke,
  // cleared on submit. Session-only and deliberately NOT in
  // `draftsStorage`: an unsent reply has no draft thread to belong to,
  // and persisting it would need a storage-schema change for little gain.
  replyBodies = new Map<string, string>();
  // Persistence handle for `drafts` + `draftBodies`. Null until identity
  // is loaded — the storage key embeds the userId so we can't construct
  // it before login, matching how `CommentStore` is scoped.
  private storage: DraftsStorage | null = null;

  // Drafts persist to localStorage under a (post, user) key so a
  // half-typed comment survives reloads. Loaded synchronously since
  // localStorage reads are cheap; the in-memory Thread + body
  // structures are restored before the first render so the cards
  // appear immediately rather than popping in after.
  loadPersisted(postPath: string, userId: string): void {
    this.storage = new DraftsStorage(postPath, userId);
    for (const entry of this.storage.load()) {
      this.drafts.push(entry.thread);
      if (entry.body) this.draftBodies.set(entry.thread.id, entry.body);
    }
  }

  // Serialize the current drafts + per-draft textarea bodies to
  // localStorage. Called after any mutation that adds, removes, or
  // edits a draft. The bodies map is filtered through the current
  // `drafts` array so a stray entry for a removed thread can't leak.
  // Discard an unsubmitted draft entirely — drop the thread, its
  // in-progress body, and persist the removal, then re-render. Shared by
  // the composer's "Cancel" button and the Esc-on-empty light-dismiss.
  discardDraft(threadId: string): void {
    this.drafts = this.drafts.filter((t) => t.id !== threadId);
    this.draftBodies.delete(threadId);
    this.persistDrafts();
    // If this draft was the open mobile popover, close it properly —
    // `preventDefault` on the Esc keydown suppresses the platform's own
    // light-dismiss, so without this `activeCardId` would linger as open.
    if (this.sys.activeCardId === threadId) this.sys.setActiveCard(null);
    this.sys.renderAll();
  }

  persistDrafts(): void {
    if (!this.storage) return;
    const entries = this.drafts.map((thread) => ({
      thread,
      body: this.draftBodies.get(thread.id) ?? "",
    }));
    this.storage.save(entries);
  }

  // Triggered by the "Comment" action-bar button after a text selection.
  // Captures the selection into a WA text target, creates an empty draft, and
  // adds a card for it in the column (auto-focused for typing).
  addDraftForSelection() {
    if (!this.sys.selection.pendingRange || !this.sys.selection.pendingStartBlock || !this.sys.selection.pendingEndBlock) {
      return;
    }
    if (this.sys.selection.pendingStartBlock.context !== this.sys.selection.pendingEndBlock.context) return;

    const blocks = this.sys.index.blocksByContext.get(this.sys.selection.pendingStartBlock.context) ?? [];
    const startIdx = blocks.indexOf(this.sys.selection.pendingStartBlock);
    const endIdx = blocks.indexOf(this.sys.selection.pendingEndBlock);
    if (startIdx === -1 || endIdx === -1) return;
    const [a, b] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    const touched = blocks.slice(a, b + 1);

    // Direction matters: the selection may be created in reverse, in
    // which case startContainer/endContainer is the *visual* end. The
    // anchor needs to store the forward-document order regardless.
    const rangeForwards = startIdx <= endIdx;
    const startBlock = rangeForwards ? this.sys.selection.pendingStartBlock : this.sys.selection.pendingEndBlock;
    const endBlock = rangeForwards ? this.sys.selection.pendingEndBlock : this.sys.selection.pendingStartBlock;
    const startNode = rangeForwards
      ? this.sys.selection.pendingRange.startContainer
      : this.sys.selection.pendingRange.endContainer;
    const startNodeOffset = rangeForwards
      ? this.sys.selection.pendingRange.startOffset
      : this.sys.selection.pendingRange.endOffset;
    const endNode = rangeForwards
      ? this.sys.selection.pendingRange.endContainer
      : this.sys.selection.pendingRange.startContainer;
    const endNodeOffset = rangeForwards
      ? this.sys.selection.pendingRange.endOffset
      : this.sys.selection.pendingRange.startOffset;

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
    const audioRange = this.sys.selection.pendingStartBlock.context === "narration"
      ? this.computeNarrationAudioRange(touched)
      : undefined;

    const target = makeTextTarget({
      context: this.sys.selection.pendingStartBlock.context,
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
    this.sys.selection.hideActionBar();
    this.sys.renderAll();
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
    if (!this.sys.index.drawerRoot || touched.length === 0) return null;
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
      this.sys.index.drawerRoot.querySelectorAll<HTMLElement>(".spoken-segment[data-time-ms]"),
    );
    const nextSeg = segs[segs.indexOf(lastSeg) + 1];
    const endMs = nextSeg ? Number(nextSeg.dataset.timeMs) : NaN;
    return { startMs, endMs: Number.isFinite(endMs) ? endMs : null };
  }

  // Triggered by clicking the "+" comment button on a figure.
  addDraftForGraphic(graphicEl: HTMLElement) {
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
    this.sys.renderAll();
    this.surfaceDraft(draft.id);
  }

  // After creating a draft, get it in front of the user. On desktop
  // that means scrolling its column card into view; on mobile it
  // means promoting it to the active popover.
  private surfaceDraft(threadId: string) {
    if (this.sys.isMobile) {
      this.sys.setActiveCard(threadId);
      return;
    }
    const card = this.sys.cardEls.get(threadId);
    if (!card) return;
    card.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    const ta = card.querySelector<HTMLTextAreaElement>(".cmt-reply-input");
    // `preventScroll`: the card is already brought into view by the line
    // above; without this, focus() does its own scroll-into-view and can
    // fight/override that (and yank to the top if the card hasn't anchored).
    ta?.focus({ preventScroll: true });
  }
}
