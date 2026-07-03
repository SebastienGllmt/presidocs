// methodology.md → Comments → Responsive — the mobile top-right button and the
// one menu popover it opens (identity / sign-in / compose-entry / highlight
// toggle), plus the highlight-visibility pref and the button's thread-count
// badge. Desktop uses the column instead, so all of this is CSS-hidden ≥1100px.

import type { CommentSystem } from "../comments.ts";
import { signOut } from "../identity.ts";
import { loadHighlightsHidden, saveHighlightsHidden } from "../commentsDom.ts";
import { buildAvatar, buildPrivacyNotice, buildProviderLink } from "./identityUi.ts";
import type { SelectionCapture } from "./selectionBar.ts";

export class MobileMenu {
  constructor(private readonly sys: CommentSystem) {}

  // Mobile-only: the single small top-right button — the only
  // comments chrome at rest. Tapping it opens `menuEl`; it pulses while a
  // selection is held (the "comment on what you selected" cue) and carries a
  // thread-count badge.
  private commentsBtn: HTMLButtonElement | null = null;
  private commentsBtnCount: HTMLElement | null = null;
  // The one menu popover the button opens — identity / sign-in / compose-entry
  // / highlight-toggle. Threads and drafts use their own `.cmt-card` popovers
  // (re-anchored under the button on mobile), so the menu only hosts the
  // non-thread surfaces; visually they all drop down from the same place.
  menuEl: HTMLElement | null = null;
  // The article-text selection captured at button-press time (pointerdown,
  // before the tap collapses it), so "Leave comment on selection" targets what
  // the reader had selected when they reached for the button. Null when the
  // button was pressed with no live selection. Consumed by `composeFromMenu`.
  private menuComposeCapture: SelectionCapture | null = null;
  // Highlight-visibility state, mirrored on `body.cmt-highlights-hidden`.
  // Toggled from a menu item on mobile (was the FAB's one-tap job).
  private highlightsHidden = false;

  // The one small top-right button. Mobile-only (CSS hides it ≥1100px, where
  // the column is the affordance). Tapping it opens the menu; pressing it also
  // captures the live selection (before the tap collapses it) so the menu can
  // offer "Leave comment on selection".
  mountCommentsButton(): void {
    // Read the persisted highlight-visibility pref (now toggled from a menu
    // item) via the pure helper — handles unavailable / throwing storage.
    this.highlightsHidden = loadHighlightsHidden(
      typeof localStorage !== "undefined" ? localStorage : null,
    );

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cmt-comments-btn";
    btn.setAttribute("aria-label", "Comments");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    const count = document.createElement("span");
    count.className = "cmt-comments-btn-count";
    count.hidden = true;
    btn.appendChild(count);
    // Capture the selection on pointerdown — the EARLIEST point at which the
    // text the reader selected is still present (the tap that follows collapses
    // it). Without this the menu would always open with nothing to comment on.
    btn.addEventListener("pointerdown", () => {
      this.menuComposeCapture = this.sys.selection.captureSelection();
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Keyboard fallback: pointerdown doesn't fire for Enter/Space activation,
      // but tabbing to the button doesn't collapse the document selection, so
      // capture it here if pointerdown didn't (and don't clobber a good touch
      // capture, which the collapsing tap would have turned into null).
      if (!this.menuComposeCapture) this.menuComposeCapture = this.sys.selection.captureSelection();
      this.toggleMenu();
    });
    document.body.appendChild(btn);
    this.commentsBtn = btn;
    this.commentsBtnCount = count;
    this.applyHighlightsHidden();
  }

  mountMenu(): void {
    const menu = document.createElement("div");
    menu.className = "cmt-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Comments");
    menu.popover = "auto";
    // Anchor under the button (see the mobile `:popover-open` rule).
    menu.style.setProperty("position-anchor", "--cmt-comments-btn");
    // Keep the button's aria-expanded in sync with platform-driven dismissal
    // (light-dismiss / ESC) as well as our own toggle.
    menu.addEventListener("toggle", (e) => {
      const open = (e as ToggleEvent).newState === "open";
      this.commentsBtn?.setAttribute("aria-expanded", String(open));
      if (!open) this.menuComposeCapture = null;
    });
    document.body.appendChild(menu);
    this.menuEl = menu;
  }

  private toggleMenu(): void {
    const menu = this.menuEl;
    if (!menu) return;
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
      return;
    }
    this.renderMenu();
    menu.showPopover();
  }

  hideMenu(): void {
    if (this.menuEl?.matches(":popover-open")) this.menuEl.hidePopover();
  }

  // Populate the menu for the current identity + captured selection. Modes:
  //  - signed out → sign-in only (provider buttons + privacy notice). We do NOT
  //    show a "Leave comment on selection" entry here: it could only route to
  //    the sign-in that's already shown (we can't pre-pick the account), so it
  //    would be a redundant second control. The pitch reflects the intent
  //    instead ("Sign in to leave your comment…").
  //  - signed in  → "Signed in as X" + sign out + highlight toggle, plus a
  //    primary "Leave comment on selection" entry when a selection was captured.
  private renderMenu(): void {
    const m = this.menuEl;
    if (!m) return;
    m.innerHTML = "";

    // Compose-entry first when the reader pressed the button mid-selection —
    // signed-in only (see the mode note above).
    if (this.sys.identity && this.menuComposeCapture) {
      const compose = document.createElement("button");
      compose.type = "button";
      compose.className = "cmt-menu-item cmt-menu-item-primary";
      compose.setAttribute("role", "menuitem");
      compose.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
        "<span>Leave comment on selection</span>";
      compose.addEventListener("click", () => this.composeFromMenu());
      m.appendChild(compose);

      // Suggest edit on the same selection (proposal 65) — a secondary entry
      // routing through the same capture path with the suggestion payload.
      const suggest = document.createElement("button");
      suggest.type = "button";
      suggest.className = "cmt-menu-item cmt-menu-item-suggest";
      suggest.setAttribute("role", "menuitem");
      suggest.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.58z" fill="currentColor"/></svg>' +
        "<span>Suggest edit on selection</span>";
      suggest.addEventListener("click", () => this.composeFromMenu(true));
      m.appendChild(suggest);

      const snippet = document.createElement("span");
      snippet.className = "cmt-menu-snippet";
      snippet.textContent = `“${this.menuComposeCapture.range.toString().trim().slice(0, 80)}”`;
      m.appendChild(snippet);
      m.appendChild(document.createElement("hr"));
    }

    if (this.sys.identity) {
      const row = document.createElement("div");
      row.className = "cmt-menu-identity";
      row.appendChild(buildAvatar(this.sys.identity.picture, this.sys.identity.name ?? this.sys.identity.email));
      const name = document.createElement("span");
      name.className = "cmt-menu-name";
      name.textContent = this.sys.identity.name ?? this.sys.identity.email;
      name.title = this.sys.identity.email;
      row.appendChild(name);
      m.appendChild(row);

      if (!this.menuComposeCapture) {
        const hint = document.createElement("p");
        hint.className = "cmt-menu-hint";
        hint.textContent = "Select text in the article, then tap this button to comment on it.";
        m.appendChild(hint);
      }

      m.appendChild(document.createElement("hr"));

      // Highlight-visibility toggle (folded in from the old FAB).
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "cmt-menu-item";
      toggle.setAttribute("role", "menuitemcheckbox");
      toggle.setAttribute("aria-checked", String(!this.highlightsHidden));
      toggle.textContent = this.highlightsHidden
        ? "Show comment highlights"
        : "Hide comment highlights";
      toggle.addEventListener("click", () => {
        this.setHighlightsHidden(!this.highlightsHidden);
        this.renderMenu();
      });
      m.appendChild(toggle);

      const out = document.createElement("button");
      out.type = "button";
      out.className = "cmt-menu-item";
      out.setAttribute("role", "menuitem");
      out.textContent = "Sign out";
      out.addEventListener("click", () => signOut());
      m.appendChild(out);
    } else {
      const pitch = document.createElement("p");
      pitch.className = "cmt-identity-pitch";
      pitch.textContent = this.menuComposeCapture
        ? "Sign in to leave your comment — so I can reply by email."
        : "Sign in to comment — so I can reply by email.";
      m.appendChild(pitch);
      const buttons = document.createElement("div");
      buttons.className = "cmt-identity-providers";
      buttons.appendChild(buildProviderLink("google", "Sign in with Google"));
      buttons.appendChild(buildProviderLink("microsoft", "Sign in with Microsoft"));
      m.appendChild(buttons);
      m.appendChild(buildPrivacyNotice());
    }
  }

  // "Leave comment on selection" tapped. Promote the captured selection to the
  // pending range and open a draft, exactly as the desktop action bar does. The
  // entry is signed-in only (renderMenu), so `!identity` is just a guard.
  private composeFromMenu(asSuggestion = false): void {
    const cap = this.menuComposeCapture;
    if (!cap || !this.sys.identity) return;
    this.sys.selection.pendingRange = cap.range;
    this.sys.selection.pendingStartBlock = cap.startBlock;
    this.sys.selection.pendingEndBlock = cap.endBlock;
    this.menuComposeCapture = null;
    this.hideMenu();
    this.sys.draftMgr.addDraftForSelection(asSuggestion);
  }

  // Mobile: set the thread-count badge on the button. No-op visual on desktop
  // (the button is hidden there).
  updateCommentsBtnCount(n: number): void {
    const el = this.commentsBtnCount;
    if (!el) return;
    el.textContent = String(n);
    el.hidden = n <= 0;
  }

  private setHighlightsHidden(hidden: boolean): void {
    this.highlightsHidden = hidden;
    if (typeof localStorage !== "undefined") {
      // Persist via the pure helper. The fire-and-forget API matches the
      // capture-controls pattern in narrator/dockControls.ts: in-memory state is
      // authoritative for the live session; storage is the next-page-load
      // contract.
      saveHighlightsHidden(localStorage, hidden);
    }
    this.applyHighlightsHidden();
    // Dismiss any popover when hiding — otherwise the overlay
    // remains on top of the dimmed article, which looks broken.
    if (hidden && this.sys.activeCardId) this.sys.setActiveCard(null);
  }

  private applyHighlightsHidden(): void {
    document.body.classList.toggle(
      "cmt-highlights-hidden",
      this.highlightsHidden,
    );
  }
}
