// methodology.md → Comments — document-version state + the column-header
// "post has been updated" banner and the author's version-history disclosure.

import type { CommentSystem } from "../comments.ts";
import {
  fetchPostVersion,
  getLastSeenVersion,
  setLastSeenVersion,
  type PostVersionResponse,
} from "../postVersion.ts";

export class VersionBanner {
  constructor(private readonly sys: CommentSystem) {}

  // Document-version state. The current SHA-256 of the post HTML
  // and (for the author) the history of past hashes. Set once on
  // boot; the "your comments may no longer apply" banner is rendered
  // when the previously-stored last-seen hash differs from the
  // server's currentHash.
  docVersion: PostVersionResponse | null = null;
  previousVersionHash: string | null = null;
  versionBannerEl: HTMLElement | null = null;
  versionHistoryEl: HTMLElement | null = null;

  // One-shot at boot: fetch the post's current hash + (author-only)
  // history, compare to the last hash this user saw, and mount the
  // banner / history UI accordingly. Failures degrade gracefully —
  // a missing endpoint or rejected response just means no banner.
  async initDocVersion(postPath: string) {
    const version = await fetchPostVersion(postPath);
    if (!version) return;
    this.docVersion = version;

    const lastSeen = getLastSeenVersion(postPath);
    // Banner only when the user has been here before AND the hash
    // changed. First-ever visits don't show the banner (there's
    // nothing to compare against).
    if (lastSeen && lastSeen !== version.currentHash) {
      this.previousVersionHash = lastSeen;
    }
    // Bump last-seen immediately — the banner gets one render-cycle
    // of visibility, the user notices, and on next reload it's gone.
    // Persisting on dismiss-only would risk users missing the
    // banner if they re-open the page in two tabs.
    setLastSeenVersion(postPath, version.currentHash);

    this.renderVersionUI();
  }

  // (Re-)mount the banner + history elements. Idempotent — wipes
  // and replaces. Cards live in the same column but are CSS-anchor-
  // positioned to their highlights, so the inserted-after-header
  // pattern doesn't disturb their layout.
  private renderVersionUI() {
    if (!this.sys.column) return;
    this.versionBannerEl?.remove();
    this.versionBannerEl = null;
    this.versionHistoryEl?.remove();
    this.versionHistoryEl = null;

    let insertAfter: Element | null = this.sys.identityHeader;

    if (this.previousVersionHash && this.docVersion) {
      const banner = document.createElement("div");
      banner.className = "cmt-version-banner";
      banner.setAttribute("role", "status");

      const text = document.createElement("p");
      text.className = "cmt-version-banner-text";
      text.textContent =
        "The post has been updated since your last visit. " +
        "Some comments may no longer apply.";
      banner.appendChild(text);

      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "cmt-version-banner-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        banner.remove();
        this.versionBannerEl = null;
        this.sys.updateBottomSpacer();
        // The rail just shrank — re-cascade so top cards that were sitting
        // below the banner reclaim the freed space.
        this.sys.adjustCardStacking();
      });
      banner.appendChild(dismiss);

      insertAfter!.after(banner);
      insertAfter = banner;
      this.versionBannerEl = banner;
    }

    if (this.docVersion?.history && this.docVersion.history.length > 0) {
      const details = document.createElement("details");
      details.className = "cmt-version-history";
      // Expanding / collapsing changes the rail's height, so re-cascade the
      // cards against the new rail bottom.
      details.addEventListener("toggle", () => this.sys.adjustCardStacking());

      const summary = document.createElement("summary");
      summary.className = "cmt-version-history-summary";
      const count = this.docVersion.history.length;
      summary.textContent = `Document versions (${count})`;
      details.appendChild(summary);

      const list = document.createElement("ol");
      list.className = "cmt-version-history-list";
      for (const entry of this.docVersion.history) {
        const li = document.createElement("li");
        li.className = "cmt-version-history-item";
        const time = document.createElement("time");
        time.dateTime = entry.builtAt;
        time.textContent = new Date(entry.builtAt).toLocaleString();
        const hash = document.createElement("code");
        hash.className = "cmt-version-history-hash";
        hash.textContent = entry.hash.slice(0, 8);
        hash.title = entry.hash;
        const isCurrent = entry.hash === this.docVersion.currentHash;
        if (isCurrent) li.classList.add("cmt-version-history-current");
        li.appendChild(time);
        li.appendChild(document.createTextNode(" "));
        li.appendChild(hash);
        if (isCurrent) {
          const tag = document.createElement("span");
          tag.className = "cmt-version-history-tag";
          tag.textContent = "current";
          li.appendChild(document.createTextNode(" "));
          li.appendChild(tag);
        }
        list.appendChild(li);
      }
      details.appendChild(list);

      insertAfter!.after(details);
      this.versionHistoryEl = details;
    }

    this.sys.updateBottomSpacer();
    // The banner / history mount here (after the boot-time renderAll, since
    // initDocVersion awaits a fetch), growing the rail — re-cascade so cards
    // anchored near the top fall below the now-taller rail.
    this.sys.adjustCardStacking();
  }
}
