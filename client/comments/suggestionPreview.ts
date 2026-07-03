// methodology.md → Comments — per-paragraph "preview suggested edits" (proposal
// 65 addendum). A gutter toggle (author-only, any build) flips a block between
// the published original and a DISPLAY-ONLY view with its suggestions applied
// (emphasis rendered). The canonical layer is never touched: the block's
// index-time hash still drives stale-detection, and reverting restores the exact
// original DOM. Read-only while previewed — you can't comment on text that isn't
// the anchor basis (selectionBar suppresses it); toggle back to comment.
//
// v1 rules (see the proposal addendum): applies every single-block, non-stale,
// non-resolved suggestion on the block, right-to-left so offsets stay valid;
// overlapping suggestions just apply in that order (approximate — the real apply
// is process-comments). Multi-block suggestions are skipped here.

import type { CommentSystem } from "../comments.ts";
import { isTextTarget, textTargetParts, type TextTarget, type Thread } from "../commentsStore.ts";
import { parseEmphasis } from "./emphasis.ts";
import { nodeAtOffset, unwrap } from "./highlights.ts";
import type { BlockInfo } from "./blockIndex.ts";

// Gutter buttons that live inside a block but must survive a content swap with
// their listeners intact — detached before the swap, re-appended after.
const AFFORDANCE_SEL = ".paragraph-id-copy, .cmt-preview-toggle";

const EYE_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
  '<circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';

export class SuggestionPreview {
  constructor(private readonly sys: CommentSystem) {}

  // blockId → content-only clone captured when preview turned on (exact revert).
  private cloned = new Map<string, HTMLElement>();
  // blockId → its gutter toggle button (kept across renders / content swaps).
  private toggles = new Map<string, HTMLButtonElement>();

  isPreviewing(blockId: string): boolean {
    return this.cloned.has(blockId);
  }

  previewedBlockIds(): string[] {
    return [...this.cloned.keys()];
  }

  // Single-block, drawable suggestions anchored to this block. Includes DRAFT
  // suggestions (created in-place / via the pill but not yet submitted) as well
  // as saved ones — the author wants to preview a proposed edit whether or not
  // it's been posted.
  private suggestionsFor(blockId: string): Thread[] {
    return [...this.sys.snapshot, ...this.sys.draftMgr.drafts].filter((t) => {
      if (!t.suggestion || !isTextTarget(t.target)) return false;
      if (this.sys.threadIsResolved(t) || this.sys.threadIsStale(t)) return false;
      const blocks = textTargetParts(t.target).blocks;
      return blocks.length === 1 && blocks[0]!.id === blockId;
    });
  }

  private toggle(block: BlockInfo): void {
    if (this.isPreviewing(block.id)) this.revert(block);
    else this.apply(block);
    // Re-render so cards re-anchor to the block, highlights re-derive, and the
    // toggle's pressed state refreshes.
    this.sys.refreshSnapshotAndRender();
  }

  private apply(block: BlockInfo): void {
    const suggestions = this.suggestionsFor(block.id);
    if (suggestions.length === 0) return;
    const el = block.element;
    const affordances = detach(el);
    // Content-only clone (affordances removed) → restore never reintroduces a
    // listener-less button.
    this.cloned.set(block.id, el.cloneNode(true) as HTMLElement);
    // Clean text nodes so offset math + range replacement are unambiguous.
    el.querySelectorAll<HTMLElement>(".cmt-highlight").forEach((s) => unwrap(s));
    // Apply right-to-left so an earlier suggestion's offsets stay valid.
    const ordered = suggestions
      // suggestionsFor() has already guaranteed a single-block TextTarget.
      .map((t) => ({ t, parts: textTargetParts(t.target as TextTarget) }))
      .sort((a, b) => b.parts.startOffset - a.parts.startOffset);
    for (const { t, parts } of ordered) {
      const s = nodeAtOffset(el, parts.startOffset);
      const e = nodeAtOffset(el, parts.endOffset);
      if (!s || !e) continue;
      const range = document.createRange();
      try {
        range.setStart(s.node, s.offset);
        range.setEnd(e.node, e.offset);
      } catch {
        continue;
      }
      range.deleteContents();
      const proposed = t.suggestion!.proposed;
      if (proposed) {
        const span = document.createElement("span");
        span.className = "cmt-preview-ins";
        span.append(...parseEmphasis(proposed));
        range.insertNode(span);
      }
    }
    el.classList.add("cmt-previewing");
    reattach(el, affordances);
  }

  private revert(block: BlockInfo): void {
    const el = block.element;
    const affordances = detach(el);
    const clone = this.cloned.get(block.id);
    if (clone) el.replaceChildren(...Array.from(clone.childNodes));
    el.classList.remove("cmt-previewing");
    this.cloned.delete(block.id);
    reattach(el, affordances);
  }

  // Ensure a gutter toggle on every article block that has a drawable suggestion
  // (or is currently previewed), author-only; drop it from any that don't.
  // Called from renderAll.
  renderToggles(): void {
    const want = new Set<string>();
    if (this.sys.isAuthorMode()) {
      for (const block of this.sys.index.blocksByContext.get("article") ?? []) {
        if (this.suggestionsFor(block.id).length > 0 || this.isPreviewing(block.id)) {
          want.add(block.id);
          this.ensureToggle(block);
        }
      }
    }
    for (const [id, btn] of this.toggles) {
      if (!want.has(id)) {
        if (this.isPreviewing(id)) {
          const b = this.sys.index.blocksById.get(id);
          if (b) this.revert(b); // suggestion vanished from under a live preview
        }
        btn.remove();
        this.toggles.delete(id);
      }
    }
  }

  private ensureToggle(block: BlockInfo): void {
    let btn = this.toggles.get(block.id);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmt-preview-toggle";
      btn.innerHTML = EYE_SVG;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(block);
      });
      block.element.classList.add("has-cmt-preview-toggle");
      block.element.appendChild(btn);
      this.toggles.set(block.id, btn);
    } else if (!block.element.contains(btn)) {
      block.element.appendChild(btn);
    }
    const on = this.isPreviewing(block.id);
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("is-on", on);
    btn.title = on ? "Showing suggested edits — click for the original" : "Preview suggested edits applied";
    btn.setAttribute("aria-label", btn.title);
  }
}

function detach(el: HTMLElement): HTMLElement[] {
  const list = [...el.querySelectorAll<HTMLElement>(AFFORDANCE_SEL)].filter((a) => a.parentElement === el);
  for (const a of list) a.remove();
  return list;
}

function reattach(el: HTMLElement, list: HTMLElement[]): void {
  for (const a of list) el.appendChild(a);
}
