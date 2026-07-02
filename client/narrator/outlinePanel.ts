// methodology.md → Narrator ("Script & outline drawer") — the drawer's OUTLINE
// half: the deferred outline body built from the article DOM (part dividers +
// h2/h3), plus the scroll-spy that marks the current section while the outline
// panel is open. Shares the drawer shell built by `Drawer.buildDrawer`.

import type { Narrator } from "../narrator.ts";
import { collectOutline } from "../narratorDom.ts";

// Article scroll position counts as "inside" a section once the section's
// heading has risen to within this many px of the viewport top. Drives the
// outline panel's current-section highlight.
const OUTLINE_ACTIVE_OFFSET_PX = 120;

export class OutlinePanel {
  constructor(private readonly sys: Narrator) {}

  // Outline panel: lazily built like the script body (`ensureOutlineBody`).
  // `outlineEntries` pairs each rendered link with its article target so the
  // scroll-spy never re-queries the DOM per scroll frame.
  outlineBodyEl: HTMLElement | null = null;
  private outlineBuilt = false;
  private outlineEntries: { link: HTMLAnchorElement; target: HTMLElement }[] = [];
  outlineActiveLink: HTMLAnchorElement | null = null;
  // Scroll-spy listener is armed only while (drawer open ∧ panel = outline),
  // so a closed drawer costs nothing per scroll. rAF-coalesced.
  private outlineScrollArmed = false;
  private outlineSyncQueued = false;

  // Populate the deferred outline panel once from the ARTICLE's structure —
  // part dividers + h2/h3 headings (collectOutline in narratorDom.ts), NOT
  // the narration manifest: the outline is a reading tool, so it lists every
  // heading whether or not narration touches it. Tiny next to the script body
  // (tens of links, no per-word spans), but deferred the same way — same
  // pattern, and a reader who never opens it pays nothing.
  ensureOutlineBody() {
    if (this.outlineBuilt) return;
    const nav = this.outlineBodyEl;
    if (!nav) return;
    this.outlineBuilt = true;

    const makeLink = (id: string, text: string): HTMLAnchorElement | null => {
      const target = document.getElementById(id);
      if (!target) return null;
      const a = document.createElement("a");
      a.className = "outline-link";
      a.href = `#${id}`;
      a.textContent = text;
      this.outlineEntries.push({ link: a, target });
      return a;
    };

    // Group: one section per part divider, holding the headings under it;
    // headings before the first divider go in a leading label-less section.
    let section = document.createElement("section");
    section.className = "outline-part";
    let list: HTMLOListElement | null = null;
    const flushSection = () => {
      if (section.childNodes.length > 0) nav.appendChild(section);
    };
    for (const entry of collectOutline(this.sys.narrationRoot)) {
      if (entry.kind === "part") {
        flushSection();
        section = document.createElement("section");
        section.className = "outline-part";
        list = null;
        const label = document.createElement("h3");
        const a = makeLink(entry.id, entry.text);
        if (a) label.appendChild(a);
        else label.textContent = entry.text;
        section.appendChild(label);
      } else {
        if (!list) {
          list = document.createElement("ol");
          list.className = "outline-entries";
          section.appendChild(list);
        }
        const a = makeLink(entry.id, entry.text);
        if (!a) continue;
        const li = document.createElement("li");
        li.dataset.level = String(entry.level ?? 2);
        li.appendChild(a);
        list.appendChild(li);
      }
    }
    flushSection();

    // Navigating from an entry deliberately does NOT close the drawer: the
    // outline is a browsing surface (hop between sections, skim, hop again),
    // and native anchor behavior already does the hash + smooth scroll. The
    // scroll-spy follows the jump, so the highlight lands on the clicked
    // entry by itself; closing stays on the X / the panel's edge tabs.
  }

  // ----- Outline scroll-spy --------------------------------------------------
  // While (drawer open ∧ panel = outline), the article's scroll position is
  // mirrored as a highlight on the outline entry whose section the reader is
  // in. Armed/disarmed on those two state edges so a closed drawer costs
  // nothing per scroll; rAF-coalesced so a scroll burst computes once a frame.

  private onArticleScroll = () => {
    if (this.outlineSyncQueued) return;
    this.outlineSyncQueued = true;
    requestAnimationFrame(() => {
      this.outlineSyncQueued = false;
      this.syncOutlineActive();
    });
  };

  armOutlineScrollSync() {
    const want = this.sys.drawer.drawerOpen && this.sys.drawer.drawerPanel === "outline";
    if (want === this.outlineScrollArmed) return;
    this.outlineScrollArmed = want;
    if (want) {
      window.addEventListener("scroll", this.onArticleScroll, { passive: true });
    } else {
      window.removeEventListener("scroll", this.onArticleScroll);
    }
  }

  // Current section = LAST outline target risen to within
  // OUTLINE_ACTIVE_OFFSET_PX of the viewport top. Above the first target
  // (still in the lede) nothing is current — honest, not a bug.
  syncOutlineActive() {
    let active: HTMLAnchorElement | null = null;
    for (const { link, target } of this.outlineEntries) {
      if (target.getBoundingClientRect().top <= OUTLINE_ACTIVE_OFFSET_PX) {
        active = link;
      }
    }
    if (active === this.outlineActiveLink) return;
    this.outlineActiveLink?.classList.remove("outline-active");
    this.outlineActiveLink?.removeAttribute("aria-current");
    this.outlineActiveLink = active;
    if (active) {
      active.classList.add("outline-active");
      active.setAttribute("aria-current", "location");
      // Keep the lit entry visible as the article scrolls under the open
      // drawer. "nearest" so we never yank a drawer the reader is browsing.
      active.scrollIntoView({ block: "nearest" });
    }
  }
}
