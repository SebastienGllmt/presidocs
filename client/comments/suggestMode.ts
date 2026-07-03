// methodology.md → Comments — in-place suggestion mode (proposal 65, increment
// 2). A rail toggle turns article blocks editable; clicking one makes it
// `contenteditable`, the reader edits the text directly (with real WYSIWYG
// bold/italic via Ctrl/Cmd+B/I), and committing runs §3's capture-against-
// original path: snapshot before edit, serialize the edited content to
// text-with-`<em>`/`<strong>`, diff it against the original, REVERT the DOM (a
// suggestion never changes what anyone reads), and anchor against the original
// PLAIN text. Enter POSTS the suggestion (deliberate "done"); clicking away
// keeps it as a recoverable DRAFT; Esc reverts with nothing; a no-op is silent.
//
// Desktop-only (mobile never gets contenteditable — it keeps increment 1's
// pill). The draft this produces is exactly an increment-1 suggestion draft, so
// the card, diff preview, note box, submit, export, and tint are all reused —
// the only difference is the proposed text may carry `<em>`/`<strong>` markup.

import type { CommentSystem } from "../comments.ts";
import { makeTextTarget, type Thread } from "../commentsStore.ts";
import { setCommentBarActive } from "../citationLink.ts";
import { diffWindow } from "./blockEdit.ts";
import { plainOffset, serializeEmphasis, snapWindowToEmphasisTags } from "./emphasis.ts";
import { findBlockFor } from "./highlights.ts";
import { uid } from "./util.ts";
import type { BlockInfo } from "./blockIndex.ts";

const CTX = 32; // TextQuoteSelector prefix/suffix length, matching draftManager

export class SuggestMode {
  constructor(private readonly sys: CommentSystem) {}

  active = false;
  private toggleBtn: HTMLButtonElement | null = null;

  // Live editing-session state. Non-null only between click-to-edit and
  // Enter/blur/Esc.
  private editingBlock: BlockInfo | null = null;
  private originalText = "";
  private pristineClone: HTMLElement | null = null;

  // True while a block is being edited — the orchestrator defers background
  // (poll) renders during a session so a re-render can't split the text node
  // under the caret (same guard shape as the IME-composition one).
  isEditing(): boolean {
    return this.editingBlock !== null;
  }

  // Mount the rail toggle + the article click delegation. Safe to call once at
  // boot. (`contenteditable` is universally supported; mobile is excluded via
  // CSS + the isMobile guard in onArticleClick, not a feature test.)
  mount(rail: HTMLElement): void {
    // Login gate mirrors commenting (§11): logged out, the toggle doesn't
    // render at all — the rail's identity header right above it carries the
    // sign-in pitch. Identity is loaded before mountColumn runs and only
    // changes at boot, so a mount-time check is sufficient.
    if (!this.sys.identity) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cmt-suggest-toggle";
    btn.setAttribute("aria-pressed", "false");
    btn.title =
      "Toggle suggestion mode — click a paragraph to propose an edit in place. Ctrl/Cmd+B and +I add bold/italic.";
    this.renderToggleLabel(btn);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
    rail.appendChild(btn);
    this.toggleBtn = btn;

    // Click delegation: in suggestion mode, a click on an article text block
    // starts (or hands off to native caret movement within) an edit session.
    this.sys.articleRoot?.addEventListener("click", (e) => this.onArticleClick(e));
  }

  private renderToggleLabel(btn: HTMLButtonElement): void {
    btn.textContent = this.active ? "Suggesting: on" : "Suggest an edit";
  }

  toggle(): void {
    // Committing any in-flight edit before flipping keeps the block state
    // clean — toggling the mode off mid-edit isn't a deliberate submit, so the
    // work survives as a draft.
    if (this.active && this.editingBlock) this.endSession("draft");
    this.active = !this.active;
    document.body.classList.toggle("cmt-suggest-mode", this.active);
    // Hold the citation generator down for the whole mode (see selectionBar):
    // selecting words while editing must not trigger slow text-fragment gen.
    setCommentBarActive(this.active);
    if (this.toggleBtn) {
      this.toggleBtn.setAttribute("aria-pressed", String(this.active));
      this.renderToggleLabel(this.toggleBtn);
    }
  }

  private onArticleClick(e: MouseEvent): void {
    if (!this.active || this.sys.isMobile || !this.sys.identity) return;
    const target = e.target as Node | null;
    if (!target) return;
    const blockEl = findBlockFor(target);
    if (!blockEl) return;
    // Only article prose — never the narration drawer or inside a figure.
    if (blockEl.closest("figure")) return;
    const id = blockEl.dataset.commentBlockId;
    const info = id ? this.sys.index.blocksById.get(id) : null;
    if (!info || info.context !== "article") return;
    // A previewed block shows applied suggestion text, not the published
    // original — editing it would diff/anchor against the wrong basis (the
    // same reason captureSelection suppresses commenting there). Toggle the
    // preview off to edit.
    if (this.sys.preview.isPreviewing(info.id)) return;
    // Already editing this block → let the browser handle the caret move.
    if (this.editingBlock === info) return;
    this.startSession(info);
  }

  private startSession(block: BlockInfo): void {
    if (this.editingBlock) this.endSession("draft"); // commit any previous block
    this.editingBlock = block;
    const el = block.element;
    this.originalText = el.textContent ?? "";
    // Clone the block so the commit can revert every keystroke (§3). Existing
    // comment highlights inside it stay put — visible during the session and
    // reconciled by the swap-back + re-render — so their cards don't lose their
    // anchor and jump. (The freeze that once looked like a highlight problem was
    // really the citation generator; see selectionBar / this.toggle.)
    this.pristineClone = el.cloneNode(true) as HTMLElement;

    // Rich contenteditable so Ctrl/Cmd+B/I render REAL bold/italic (the reader
    // sees formatting, not tags). Prefer semantic tags over inline styles.
    el.setAttribute("contenteditable", "true");
    try {
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      /* not all engines expose this toggle; the serializer handles styles too */
    }
    el.classList.add("cmt-editing");
    el.addEventListener("beforeinput", this.onBeforeInput);
    el.addEventListener("keydown", this.onKeyDown);
    el.addEventListener("paste", this.onPaste);
    el.addEventListener("blur", this.onBlur);
    // Focus without scroll-jumping; the caret lands from the click that got us
    // here (or at the start, which is fine for a short paragraph edit).
    el.focus({ preventScroll: true });
  }

  // Block-scoped on purpose: no paragraph splits/merges (which would wreck the
  // single-block anchor). Structural rewrites stay plain comments.
  private onBeforeInput = (e: Event): void => {
    const inputType = (e as InputEvent).inputType;
    if (inputType === "insertParagraph" || inputType === "insertLineBreak" || inputType === "insertFromDrop") {
      e.preventDefault();
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ctrl/Cmd+B / +I: apply REAL bold/italic (rendered live). We normalize the
    // resulting markup to `<em>`/`<strong>` when serializing on commit.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b") {
        e.preventDefault();
        document.execCommand("bold");
        return;
      }
      if (k === "i") {
        e.preventDefault();
        document.execCommand("italic");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter is a deliberate "I'm done" → POST the suggestion.
      e.preventDefault();
      this.endSession("submit");
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.endSession("cancel");
    }
  };

  private onBlur = (): void => {
    // Clicking away is NOT a deliberate submit — capture the edit as a
    // recoverable DRAFT (the reader can then tweak/submit or cancel it).
    // Idempotent via the null check (Enter already ended the session by the
    // time its removeAttribute triggers blur).
    this.endSession("draft");
  };

  // Force plain-text paste: rich clipboard HTML would inject spans/styles/other
  // markup we'd have to sanitize. Only Ctrl/Cmd+B/I introduce emphasis.
  private onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) document.execCommand("insertText", false, text);
  };

  // Finish editing: strip contenteditable, REVERT the DOM to its pristine clone
  // (the published article must not change), and — for a real edit — turn the
  // minimal changed window into a suggestion. `mode` decides its fate:
  //   - "submit": post it directly (Enter — a deliberate "done").
  //   - "draft":  keep it as a recoverable draft (blur — clicked away).
  //   - "cancel": discard, revert only (Esc).
  private endSession(mode: "submit" | "draft" | "cancel"): void {
    const block = this.editingBlock;
    if (!block) return;
    this.editingBlock = null; // reentrancy guard (blur + keydown can both fire)

    const commit = mode !== "cancel";
    const el = block.element;
    // Serialize the edited content (with emphasis) and the original BEFORE
    // reverting the DOM — the diff runs on these `<em>`/`<strong>` forms so a
    // formatting-only change (identical textContent) still registers.
    const editedRich = commit ? serializeEmphasis(el) : "";
    const originalRich = commit && this.pristineClone ? serializeEmphasis(this.pristineClone) : "";
    el.removeEventListener("beforeinput", this.onBeforeInput);
    el.removeEventListener("keydown", this.onKeyDown);
    el.removeEventListener("paste", this.onPaste);
    el.removeEventListener("blur", this.onBlur);
    el.removeAttribute("contenteditable");
    el.classList.remove("cmt-editing");
    // Swap the pristine clone's children back in — undoing every keystroke in
    // the published DOM. `renderAll` below re-wraps highlights from scratch.
    if (this.pristineClone) el.replaceChildren(...Array.from(this.pristineClone.childNodes));
    this.pristineClone = null;

    const original = this.originalText;
    this.originalText = "";

    // The char-level trim can cut mid-tag when emphasis changes at the same
    // text position (em→strong leaves "strong>a</strong"); snap the window
    // out to whole tags so the proposed text always carries balanced markup.
    const rawWin = commit ? diffWindow(originalRich, editedRich) : null;
    const win = rawWin ? snapWindowToEmphasisTags(originalRich, editedRich, rawWin) : null;
    if (!win) {
      // Esc, or a no-op edit → nothing to propose; just redraw (restores
      // highlights + flushes any poll deferred during the session).
      this.sys.refreshSnapshotAndRender();
      return;
    }

    // The window is in the serialized string; map its ends back to PLAIN offsets
    // so the anchor/quote/highlight stay plain-text (what the segment hashes and
    // process-comments locate against). The proposed text keeps the tags.
    const identity = this.sys.identity!;
    const start = plainOffset(originalRich, win.start);
    const end = plainOffset(originalRich, win.end);
    const quote = original.slice(start, end);
    const target = makeTextTarget({
      context: "article",
      blocks: [{ id: block.id, hash: block.hash }],
      startOffset: start,
      endOffset: end,
      quote,
      prefix: original.slice(Math.max(0, start - CTX), start),
      suffix: original.slice(end, end + CTX),
    });
    const suggestion = {
      proposed: win.replacement,
      authorId: identity.userId,
      authorName: identity.name ?? identity.email,
      authorEmail: identity.email,
      ...(identity.picture && { authorPicture: identity.picture }),
    };
    if (mode === "submit" && this.sys.store) {
      // Enter → post directly. The saved card opens with the reply box focused
      // for an optional note.
      const threadId = uid();
      this.sys.store.addThread(threadId, target, Date.now(), suggestion);
      this.sys.refreshSnapshotAndRender();
      this.sys.draftMgr.surface(threadId);
    } else {
      // Clicked away (blur), or a submit without a ready store → a recoverable
      // draft the reader can tweak, submit, or cancel.
      this.sys.draftMgr.addPreparedDraft({
        id: uid(),
        target,
        replies: [],
        createdAt: Date.now(),
        suggestion,
      });
    }
  }
}
