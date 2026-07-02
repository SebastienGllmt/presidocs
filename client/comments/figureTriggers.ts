// methodology.md → Comments — per-figure comment triggers: the hover "+" button
// that opens a graphic draft and the always-on indicator badge that surfaces /
// cycles the graphic's threads, plus the badge count sync.

import type { CommentSystem } from "../comments.ts";
import { graphicTargetId, isTextTarget } from "../commentsStore.ts";
import { anchorNameForGraphic } from "./highlights.ts";

export class FigureTriggers {
  constructor(private readonly sys: CommentSystem) {}

  installGraphicTriggers() {
    for (const [gid, el] of this.sys.index.graphicsById) {
      // Stamp the graphic root as a CSS anchor so cards on this
      // graphic can `position-anchor` to it without JS layout math.
      el.style.setProperty("anchor-name", anchorNameForGraphic(gid));

      // The "+" button (visible on hover) → creates a new draft. Only
      // mounted when logged in; without identity the comment-creation
      // path is fully closed off (mirrors the action-bar gate above).
      let btn: HTMLButtonElement | null = null;
      if (this.sys.identity) {
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
          this.sys.draftMgr.addDraftForGraphic(el);
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
        const matching = this.sys.snapshot.filter(
          (t) => !this.sys.threadIsResolved(t)
            && !isTextTarget(t.target)
            && graphicTargetId(t.target) === gid,
        );
        let didUnhide = false;
        for (const t of matching) {
          if (this.sys.hiddenCardIds.has(t.id)) {
            this.sys.hiddenCardIds.delete(t.id);
            didUnhide = true;
          }
        }
        if (didUnhide) this.sys.renderAll();
        const first = matching[0];
        if (!first) return;
        if (this.sys.isMobile) {
          // Same toggle behavior as the text-highlight tap: a second
          // tap on the same indicator closes the popover.
          if (this.sys.activeCardId === first.id) {
            this.sys.setActiveCard(null);
          } else {
            this.sys.setActiveCard(first.id);
          }
        } else {
          // Desktop toggle (mirrors the highlight-click path):
          // navigate on first click, hide on the second.
          if (didUnhide) {
            this.sys.scrollCardIntoView(first.id);
            this.sys.lastFocusedThreadId = first.id;
          } else if (this.sys.lastFocusedThreadId === first.id) {
            this.sys.hiddenCardIds.add(first.id);
            this.sys.lastFocusedThreadId = null;
            this.sys.renderAll();
          } else {
            this.sys.scrollCardIntoView(first.id);
            this.sys.lastFocusedThreadId = first.id;
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
  updateGraphicIndicators() {
    for (const [gid, el] of this.sys.index.graphicsById) {
      const count = this.sys.snapshot.filter(
        (t) => !this.sys.threadIsResolved(t)
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
}
