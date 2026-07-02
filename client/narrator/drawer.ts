// methodology.md → Narrator ("Script & outline drawer") — the slide-in drawer's
// SCRIPT half: builds the shell (shared with the outline panel), the deferred
// spoken-script body (one <article id="spoken-…"> per mark, per-word karaoke
// spans), open/close + panel-switch state, hash deep-linking, and the active
// mark/word highlight inside the drawer.

import type { Narrator } from "../narrator.ts";
import { spokenSegmentId, parseSpokenHash } from "../narratorDom.ts";
import {
  DRAWER_BODY_WANTED_ATTR,
  REQUEST_DRAWER_BODY_EVENT,
  DRAWER_BODY_READY_EVENT,
} from "../drawerBodyContract.ts";
import { msToSeconds, secondsToMs, asSeconds, asMs, type Milliseconds } from "../../shared/time.ts";
import { findActiveWord } from "../narratorTiming.ts";
import type { ManifestMark, ManifestChapter } from "../../shared/manifestSchema.ts";

function formatClockTime(ms: Milliseconds) {
  const total = Math.max(0, Math.round(msToSeconds(ms)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// The two panels sharing the left-edge drawer. ONE drawer, two panels — they
// occupy the same space by construction, so "script and outline can't both be
// open" is an invariant of the DOM shape, not a rule two drawers coordinate on.
type DrawerPanel = "script" | "outline";

export class Drawer {
  constructor(private readonly sys: Narrator) {}

  // Script-&-outline drawer + per-mark segment elements. One drawer element,
  // two panels (`drawerPanel` picks which body is shown); two edge tabs open
  // it straight to a panel, the header panel-tabs switch in place.
  private drawerEl: HTMLElement | null = null;
  private drawerTabBtn: HTMLButtonElement | null = null;
  private outlineTabBtn: HTMLButtonElement | null = null;
  private panelTabBtns = new Map<DrawerPanel, HTMLButtonElement>();
  drawerPanel: DrawerPanel = "script";
  // The drawer body is built lazily off the boot path — see `ensureDrawerBody`
  // and the narrator↔comments contract in narratorDom.ts. `drawerBodyEl` is the
  // empty container appended with the shell; `drawerBodyBuilt` guards the
  // one-time populate.
  private drawerBodyEl: HTMLElement | null = null;
  private drawerBodyBuilt = false;
  segmentEls = new Map<string, HTMLElement>();
  // Per-mark word `<span>`s for the karaoke-style active-word highlight.
  // Populated by `renderSegment` only when the mark carries `words` — marks
  // without alignment data render text flat and have no entry here. Same key
  // (mark name) as `segmentEls`; the inner array is in `words[]` order so the
  // rAF tick can binary-search by time and toggle .narration-active-word on
  // the corresponding span without re-querying the DOM.
  private wordEls = new Map<string, HTMLSpanElement[]>();
  // Last (markName, wordIndex) we lit, so the per-frame tick can short-
  // circuit when nothing changed.
  private activeWord: { markName: string; index: number } | null = null;
  drawerOpen = false;

  // Build the slide-in drawer SHELL (the `<aside>` + edge tabs + header + two
  // empty panel bodies) eagerly. The drawer hosts TWO panels — the spoken
  // script and the article outline — in one element, so the panels share the
  // left-edge slot by construction (they can never both be open). The script
  // BODY — one `<article id="spoken-<markName>">` per segment, each split into
  // per-word spans on an aligned post — is the node bulk, so it's deferred to
  // `ensureDrawerBody` and built on demand: when the reader opens that panel,
  // on a `#spoken-…` deep link, or when the logged-in comment system requests
  // it (a logged-out reader never triggers it, so on the common path — and the
  // Lighthouse trace — the body never builds unless the reader opens the
  // script). The outline body defers the same way (`ensureOutlineBody`). See
  // the narrator↔comments contract in narratorDom.ts and methodology →
  // Narrator ("Loading: a lazy boot").
  //
  // Comment-anchor invariant (see walkBlocks in commentsDom.ts): the comment
  // system indexes this whole aside and hands out POSITIONAL fallback ids in
  // walk order, so the sequence of walker-visible blocks must not change:
  // [h2 "Spoken script"] then the script body's chapters/segments. All chrome
  // added for the two-panel drawer is either non-block (buttons) or wrapped
  // in <nav> (the panel switcher, the outline panel), which the walker skips.
  buildDrawer() {
    const drawer = document.createElement("aside");
    drawer.id = "narrate-drawer";
    drawer.className = "narrate-drawer";
    drawer.setAttribute("aria-label", "Script & outline");
    drawer.dataset.open = "false";
    drawer.dataset.panel = "script";

    // Edge tabs, stacked on the drawer's left edge — one per panel, each
    // opening the drawer straight to its panel. They travel with the drawer
    // (anchored at `left: 100%`): peeking out from the viewport's left edge
    // when closed, hidden while open (the header switcher takes over).
    this.drawerTabBtn = this.buildEdgeTab(
      drawer,
      "script",
      "Script",
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm10 0v5h4M8 12h8M8 16h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      "Open spoken script",
    );
    this.outlineTabBtn = this.buildEdgeTab(
      drawer,
      "outline",
      "Outline",
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M9 6h11M9 12h11M9 18h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
        '<circle cx="4.5" cy="6" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor"/></svg>',
      "Open outline",
    );

    // Header: panel switcher + close affordance. The switcher sits where the
    // old static title did and is styled like it — the active panel's name IS
    // the drawer title, you just happen to be able to press the other one.
    // It lives in a <nav> so the comment walker skips it (see above).
    const header = document.createElement("header");
    header.className = "narrate-drawer-header";
    const tabsNav = document.createElement("nav");
    tabsNav.className = "drawer-panel-tabs";
    tabsNav.setAttribute("aria-label", "Drawer panels");
    const panelLabels: [DrawerPanel, string][] = [
      ["script", "Spoken script"],
      ["outline", "Outline"],
    ];
    for (const [panel, label] of panelLabels) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "drawer-panel-tab";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(panel === "script"));
      btn.addEventListener("click", () => this.setPanel(panel));
      tabsNav.appendChild(btn);
      this.panelTabBtns.set(panel, btn);
    }
    header.appendChild(tabsNav);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "narrate-drawer-close";
    closeBtn.setAttribute("aria-label", "Close drawer");
    closeBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("click", () => this.setDrawerOpen(false));
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Script panel — populated lazily by `ensureDrawerBody`. The visually-
    // hidden <h2> titles the panel for screen readers AND keeps the comment
    // walker's block sequence byte-identical to the pre-outline drawer (the
    // title used to be a visible header <h2>; same text, same walk position,
    // so the positional `narration:__b-…` ids — and every anchor hashed
    // against them — survive the restructure untouched).
    const body = document.createElement("div");
    body.className = "narrate-drawer-body";
    const srTitle = document.createElement("h2");
    srTitle.className = "narrate-drawer-sr-title";
    srTitle.textContent = "Spoken script";
    body.appendChild(srTitle);
    drawer.appendChild(body);

    // Outline panel — populated lazily by `ensureOutlineBody`. A real <nav>
    // for its own sake (it IS the post's navigation) and for the walker skip.
    const outline = document.createElement("nav");
    outline.className = "narrate-drawer-outline";
    outline.setAttribute("aria-label", "Outline");
    outline.hidden = true;
    drawer.appendChild(outline);
    this.sys.outline.outlineBodyEl = outline;

    // One-shot entrance: the shell is built client-side at narrator boot, so
    // without this the tabs pop into the left edge. `data-entering` (set before
    // append so the first render carries it) drives the tabs' slide+fade in
    // (see `.narrate-drawer-tab` in narrator.css; the outline tab follows the
    // script tab on a short stagger) — a single coordinated motion with the
    // dock's reveal. Cleared after the animation so reclosing the drawer
    // (which re-shows the tabs) doesn't replay it.
    drawer.dataset.entering = "true";

    document.body.appendChild(drawer);
    this.drawerEl = drawer;
    this.drawerBodyEl = body;

    // 300 ms animation (narrator.css) + a frame of slack; harmless if it lingers
    // under reduced motion (the animation is suppressed there anyway).
    setTimeout(() => drawer.removeAttribute("data-entering"), 360);

    // Order-independent handshake (narratorDom.ts): if a requester (the
    // logged-in comment system) already asked for the body before we booted,
    // build it now; otherwise answer the request whenever it arrives.
    if (document.documentElement.hasAttribute(DRAWER_BODY_WANTED_ATTR)) {
      this.ensureDrawerBody();
    }
    document.addEventListener(REQUEST_DRAWER_BODY_EVENT, () => this.ensureDrawerBody());
  }

  // One edge tab handle. `data-panel-target` keys both the click behavior
  // (open straight to that panel) and the CSS stacking offset.
  private buildEdgeTab(
    drawer: HTMLElement,
    panel: DrawerPanel,
    label: string,
    iconSvg: string,
    ariaLabel: string,
  ): HTMLButtonElement {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "narrate-drawer-tab";
    tab.dataset.panelTarget = panel;
    tab.setAttribute("aria-controls", "narrate-drawer");
    tab.setAttribute("aria-expanded", "false");
    tab.setAttribute("aria-label", ariaLabel);
    tab.innerHTML = `${iconSvg}<span class="tab-label">${label}</span>`;
    tab.addEventListener("click", () => this.setDrawerOpen(true, panel));
    drawer.appendChild(tab);
    return tab;
  }

  // Populate the deferred drawer body once: one section per chapter, each a
  // list of `<article id="spoken-<markName>">` segments (sub-chapter sections
  // nest INSIDE their parent's so its heading stays sticky for the duration —
  // sticky scoping is bounded by the containing block). Idempotent. Safe to
  // call from any trigger (open / deep-link / comment request).
  private ensureDrawerBody() {
    if (this.drawerBodyBuilt) return;
    const body = this.drawerBodyEl;
    const manifest = this.sys.manifest;
    if (!body || !manifest) return;
    this.drawerBodyBuilt = true;

    const byChapter = new Map<string, ManifestMark[]>();
    for (const mark of manifest.marks) {
      if (!byChapter.has(mark.chapter)) byChapter.set(mark.chapter, []);
      byChapter.get(mark.chapter)!.push(mark);
    }

    const childrenOf = new Map<string, ManifestChapter[]>();
    for (const chapter of manifest.chapters) {
      if (chapter.parentId === undefined) continue;
      if (!childrenOf.has(chapter.parentId)) childrenOf.set(chapter.parentId, []);
      childrenOf.get(chapter.parentId)!.push(chapter);
    }

    const buildSection = (
      chapter: ManifestChapter,
      isSub: boolean,
    ): HTMLElement | null => {
      const marks = byChapter.get(chapter.id) ?? [];
      const subs = isSub ? [] : (childrenOf.get(chapter.id) ?? []);
      if (marks.length === 0 && subs.length === 0) return null;

      const section = document.createElement("section");
      section.className = "spoken-chapter";
      section.dataset.chapter = chapter.id;
      if (isSub) section.dataset.subchapter = "true";

      const heading = document.createElement("h3");
      heading.textContent = chapter.title;
      section.appendChild(heading);

      if (marks.length > 0) {
        const ol = document.createElement("ol");
        ol.className = "spoken-segments";
        for (const mark of marks) {
          ol.appendChild(this.renderSegment(mark));
        }
        section.appendChild(ol);
      }

      for (const sub of subs) {
        const subSection = buildSection(sub, true);
        if (subSection) section.appendChild(subSection);
      }

      return section;
    };

    for (const chapter of manifest.chapters) {
      if (chapter.parentId !== undefined) continue;
      const section = buildSection(chapter, false);
      if (section) body.appendChild(section);
    }

    // The drawer is now indexable. Mark it + fire the READY signal so a
    // comment system that requested the body (and is awaiting it) can index
    // and paint narration highlights into a fully-built drawer.
    this.drawerEl?.setAttribute("data-body-ready", "true");
    document.dispatchEvent(new CustomEvent(DRAWER_BODY_READY_EVENT));

    // Re-apply the active highlight: a live playback's rAF tick catches the
    // new spans next frame, but a paused reader who just built the drawer
    // needs the current mark/word lit once now.
    if (this.sys.activeId) {
      this.segmentEls.get(this.sys.activeId)?.classList.add("narration-active");
      if (this.sys.player) {
        this.updateActiveWord(
          this.sys.activeId,
          secondsToMs(asSeconds(this.sys.player.currentTime)),
        );
      }
    }
  }

  private renderSegment(mark: ManifestMark): HTMLLIElement {
    const li = document.createElement("li");
    // <article> is appropriate — each segment is a self-contained piece of
    // content that may later carry its own discussion thread.
    const seg = document.createElement("article");
    seg.id = spokenSegmentId(mark.name);
    seg.className = "spoken-segment";
    seg.dataset.mark = mark.name;
    seg.dataset.chapter = mark.chapter;
    seg.dataset.timeMs = String(mark.time);
    // `tabindex` so :focus-visible works when arrived at by URL fragment.
    seg.tabIndex = -1;

    const play = document.createElement("button");
    play.type = "button";
    play.className = "spoken-play";
    play.setAttribute(
      "aria-label",
      `Play from ${formatClockTime(mark.time)} — ${mark.name}`,
    );
    play.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l6 4-6 4z" fill="currentColor"/></svg>' +
      `<time datetime="PT${msToSeconds(mark.time)}S">${formatClockTime(mark.time)}</time>`;
    play.addEventListener("click", () => {
      // Seek into the start of this segment (the small offset matches the
      // chapter-jump nudge — keeps the chapter plugin's range check happy
      // when a mark sits exactly on a chapter boundary).
      this.sys.seekToMs(asMs(mark.time + 10));
      this.sys.player?.play();
    });
    seg.appendChild(play);

    const text = document.createElement("p");
    text.className = "spoken-text";
    const fullText = mark.text ?? "";
    if (mark.words && mark.words.length > 0) {
      // Word-level alignment is available: render the spoken text as a
      // sequence of (gap text, <span.spoken-word>word</span>) pairs so the
      // rAF tick can toggle .narration-active-word on the active span. The
      // unchanged stretches between words (whitespace, punctuation that
      // sits outside [s,e)) are emitted as bare text nodes — no per-glyph
      // span — so the DOM stays light on long segments.
      const spans: HTMLSpanElement[] = [];
      let cursor = 0;
      for (const [wIdx, w] of mark.words.entries()) {
        if (w.s > cursor) text.appendChild(document.createTextNode(fullText.slice(cursor, w.s)));
        const span = document.createElement("span");
        span.className = "spoken-word";
        span.dataset.wordIndex = String(wIdx);
        span.textContent = fullText.slice(w.s, w.e);
        // Click-to-seek on a word — drop-in extension of the segment's
        // click-to-seek (the play button above), at finer granularity. Same
        // small offset for the same reason (chapter plugin range check).
        span.addEventListener("click", () => {
          this.sys.seekToMs(asMs(w.t + 10));
          this.sys.player?.play();
        });
        text.appendChild(span);
        spans.push(span);
        cursor = w.e;
      }
      if (cursor < fullText.length) text.appendChild(document.createTextNode(fullText.slice(cursor)));
      this.wordEls.set(mark.name, spans);
    } else {
      text.textContent = fullText;
    }
    seg.appendChild(text);

    li.appendChild(seg);
    this.segmentEls.set(mark.name, seg);
    return li;
  }

  // Per-frame active-word update. Called from updateActive() after the active
  // MARK is resolved, so the binary search is over a single segment's words[]
  // (typically 30-80 entries) rather than every word in the post. Cheap.
  updateActiveWord(activeMarkName: string | null, tMs: Milliseconds) {
    if (!activeMarkName) {
      this.clearActiveWord();
      return;
    }
    const spans = this.wordEls.get(activeMarkName);
    if (!spans || spans.length === 0) {
      this.clearActiveWord();
      return;
    }
    const mark = this.sys.manifest?.marks.find((m) => m.name === activeMarkName);
    const words = mark?.words;
    if (!words || words.length === 0) {
      this.clearActiveWord();
      return;
    }
    // Pure bisect — see client/narratorTiming.ts. Returns -1 before the
    // first word; we treat that as "nothing to highlight yet."
    const idx = findActiveWord(words, tMs);
    if (idx < 0) {
      this.clearActiveWord();
      return;
    }
    // The last matched word might have already finished (currentTime past
    // its [t, t+d)). When that happens AND it's the trailing word of the
    // mark, the active highlight visually "lingers" on the last spoken
    // word — which is what a karaoke reader expects (the eye doesn't snap
    // back to nothing mid-pause). For interior words, the next iteration
    // will overwrite anyway.
    if (
      this.activeWord &&
      this.activeWord.markName === activeMarkName &&
      this.activeWord.index === idx
    ) {
      return; // unchanged
    }
    this.clearActiveWord();
    spans[idx]?.classList.add("narration-active-word");
    this.activeWord = { markName: activeMarkName, index: idx };
  }

  private clearActiveWord() {
    if (!this.activeWord) return;
    const prev = this.wordEls.get(this.activeWord.markName);
    prev?.[this.activeWord.index]?.classList.remove("narration-active-word");
    this.activeWord = null;
  }

  private setDrawerOpen(open: boolean, panel?: DrawerPanel) {
    if (!this.drawerEl) return;
    if (open && panel) this.setPanel(panel);
    // Opening reveals a panel — build its (deferred) body first so there's
    // something to show. No-op if already built.
    if (open) this.ensurePanelBody(this.drawerPanel);
    if (this.drawerOpen === open) return;
    this.drawerOpen = open;
    this.drawerEl.dataset.open = String(open);
    for (const tab of [this.drawerTabBtn, this.outlineTabBtn]) {
      tab?.setAttribute("aria-expanded", String(open));
    }
    document.body.classList.toggle("drawer-open", open);
    this.sys.outline.armOutlineScrollSync();
    if (open) this.revealPanelPosition(this.drawerPanel);
  }

  // Switch which panel the (single) drawer shows. In-place swap — no slide,
  // the drawer doesn't move, only its body changes. Builds the incoming
  // panel's body lazily when the drawer is (or is being) opened.
  private setPanel(panel: DrawerPanel) {
    if (!this.drawerEl || this.drawerPanel === panel) return;
    this.drawerPanel = panel;
    this.drawerEl.dataset.panel = panel;
    for (const [p, btn] of this.panelTabBtns) {
      btn.setAttribute("aria-pressed", String(p === panel));
    }
    if (this.drawerBodyEl) this.drawerBodyEl.hidden = panel !== "script";
    if (this.sys.outline.outlineBodyEl) this.sys.outline.outlineBodyEl.hidden = panel !== "outline";
    if (this.drawerOpen) {
      this.ensurePanelBody(panel);
      this.revealPanelPosition(panel);
    }
    this.sys.outline.armOutlineScrollSync();
  }

  private ensurePanelBody(panel: DrawerPanel) {
    if (panel === "script") this.ensureDrawerBody();
    else this.sys.outline.ensureOutlineBody();
  }

  // After opening (or switching panels while open), bring the panel's "you
  // are here" into view: the active narration segment (script) or the current
  // section (outline), so the reader doesn't have to hunt.
  private revealPanelPosition(panel: DrawerPanel) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let target: HTMLElement | null | undefined;
    if (panel === "script") {
      target = this.sys.activeId ? this.segmentEls.get(this.sys.activeId) : null;
    } else {
      this.sys.outline.syncOutlineActive();
      target = this.sys.outline.outlineActiveLink;
    }
    if (!target) return;
    // Defer past the open-transition's first frame so layout has settled
    // and `scrollIntoView` finds non-zero dimensions.
    requestAnimationFrame(() => {
      target?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    });
  }

  // If the page was loaded (or navigated to) with a URL fragment that points
  // at a spoken segment, open the drawer and bring that segment into view.
  // Plain `#elementId` fragments still scroll the article as the browser does
  // by default — we only intervene for our prefixed ids.
  applyHashIfMatching() {
    // Parse via the pure helper — it covers the empty-hash, malformed-
    // `%xx`, and "not our prefix" cases uniformly. See narratorDom.ts.
    const markName = parseSpokenHash(window.location.hash);
    if (!markName) return;
    // The target segment lives in the (deferred) drawer body — build it first.
    this.ensureDrawerBody();
    const seg = this.segmentEls.get(markName);
    if (!seg) return;
    this.setDrawerOpen(true, "script");
    // Highlight briefly so it's easy to spot when arrived from a link.
    seg.classList.add("anchor-flash");
    setTimeout(() => seg.classList.remove("anchor-flash"), 1500);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      seg.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      seg.focus({ preventScroll: true });
    });
  }
}
