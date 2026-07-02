// methodology.md → Comments — author-only unresolved-thread counter in the
// column header + the click-to-cycle navigation through unresolved threads and
// unsent drafts in document order.

import type { CommentSystem } from "../comments.ts";

export class UnresolvedNav {
  constructor(private readonly sys: CommentSystem) {}

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

  // Author-only at-a-glance counter of unresolved threads, mounted in
  // the column header. The intent is "did I miss any comments?"
  // surfacing — without it the author has to scroll the whole post to
  // be sure. Hidden for non-authors and when there's nothing to report
  // (no saved thread AND no unsent draft — a bare "0 unresolved" on a
  // fresh post is just noise). When the post has threads we keep it
  // mounted even at 0 so the author sees explicit confirmation that
  // everything's been dealt with; it also calls out unsent drafts via a
  // "(+N draft)" suffix (or "N unsent drafts" when nothing's posted yet)
  // so a half-written-but-never-submitted comment can't masquerade as
  // done. Clicks cycle through the unresolved threads and unsent drafts in
  // document order.
  renderUnresolvedCount() {
    if (!this.sys.column) return;
    const author = this.sys.isAuthorMode();
    const totalThreads = this.sys.snapshot.length;
    const drafts = this.sys.draftMgr.drafts.length;
    // Show the badge for the author whenever there's something to report: any
    // saved thread, OR any unsent draft. The draft case surfaces a "you have
    // unposted comments" nudge even before the first one is published — the
    // exact trap where a half-written comment that was never submitted looks
    // done but doesn't count. Nothing at all → no badge (a bare "0 unresolved"
    // on a fresh post is just noise).
    if (!author || (totalThreads === 0 && drafts === 0)) {
      this.unresolvedCountEl?.remove();
      this.unresolvedCountEl = null;
      this.lastUnresolvedIds = [];
      this.unresolvedCycleIndex = 0;
      return;
    }

    const unresolved = this.sys.snapshot.filter((t) => !this.sys.threadIsResolved(t));
    const count = unresolved.length;
    const draftNote = drafts > 0
      ? ` (+${drafts} draft${drafts === 1 ? "" : "s"})`
      : "";

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
        this.sys.version.versionHistoryEl ?? this.sys.version.versionBannerEl ?? this.sys.identityHeader!;
      insertAfter.after(btn);
      this.unresolvedCountEl = btn;
    }

    const el = this.unresolvedCountEl;
    if (totalThreads === 0) {
      // Only unsent drafts exist — nothing has been posted yet. The cycle
      // still visits them, so the badge stays clickable.
      el.dataset.state = "drafts";
      el.textContent = `${drafts} unsent draft${drafts === 1 ? "" : "s"}`;
      el.title = "Jump to the next unsent draft";
      el.disabled = false;
    } else if (count === 0) {
      el.dataset.state = "clear";
      el.textContent = "All comments resolved" + draftNote;
      // Resolved threads aren't in the cycle, but unsent drafts are — so the
      // badge stays clickable iff there's still a draft to jump to.
      el.title = drafts > 0
        ? "No unresolved threads; jump to the next unsent draft"
        : "No unresolved threads on this post";
      el.disabled = drafts === 0;
    } else {
      el.dataset.state = "pending";
      el.textContent =
        `${count} unresolved comment${count === 1 ? "" : "s"}` + draftNote;
      el.title = "Jump to the next unresolved comment";
      el.disabled = false;
    }
  }

  // Step through unresolved threads AND unsent drafts in document order on
  // each click. Drafts are full Thread objects (just not in the CRDT), so they
  // carry their own highlight + card and slot into the same document-order
  // walk — including them keeps the cycle honest with the badge, which already
  // counts drafts in its "(+N draft)" suffix. The set is recomputed every call
  // (poll/mutation may have shifted it) and the cycle index is reset whenever
  // the membership changes so we never index off the end.
  private jumpToNextUnresolved() {
    const ordered = [
      ...this.sys.snapshot.filter((t) => !this.sys.threadIsResolved(t)),
      ...this.sys.draftMgr.drafts,
    ]
      .map((t) => ({ thread: t, top: this.sys.computeAnchorTop(t) ?? Infinity }))
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
    if (this.sys.hiddenCardIds.has(target.id)) {
      this.sys.hiddenCardIds.delete(target.id);
      this.sys.renderAll();
    }
    this.sys.scrollAnchorIntoView(target);
    this.sys.scrollCardIntoView(target.id);
  }
}
