// Narrator: mounts a Shikwasa audio player fixed to the bottom of the page
// and synchronizes <mark> highlights with playback.
//
// Manifest shape (see generate/generate.ts):
// {
//   audio: "/audio/<slug>/full.wav",
//   duration: 84300,
//   chapters: [{ id, title, startTime, endTime }, ...],
//   marks: [{ name: "elementId", time: <absolute ms>, chapter }, ...]
// }
// Every time field is integer milliseconds; we convert to seconds only at
// the audio element + Shikwasa boundary (their APIs are second-based).

import "shikwasa/dist/style.css";
import { Player, Chapter } from "shikwasa";
import { asMs, msToSeconds, secondsToMs, asSeconds, type Milliseconds } from "../shared/time.ts";

type ManifestMark = {
  name: string;
  time: Milliseconds;
  chapter: string;
  // The spoken text that follows this mark, up to the next mark. Used to
  // populate the script drawer; segment elements get id="spoken-<name>"
  // so they can be deep-linked and (eventually) commented on.
  text?: string;
};
type ManifestChapter = { id: string; title: string; startTime: Milliseconds; endTime: Milliseconds };
type Manifest = {
  audio: string;
  duration: Milliseconds;
  chapters: ManifestChapter[];
  marks: ManifestMark[];
};

// Stable ID prefix for spoken segments inside the drawer. Kept separate from
// the article's element ids (which marks already reference by name) so
// `#title` lands on the article and `#spoken-title` lands on the drawer.
const SPOKEN_ID_PREFIX = "spoken-";
const spokenSegmentId = (markName: string) => SPOKEN_ID_PREFIX + markName;

function formatClockTime(ms: Milliseconds) {
  const total = Math.max(0, Math.round(msToSeconds(ms)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Register the chapter plugin once for the lifetime of the page.
Player.use(Chapter);

class Narrator {
  private manifest: Manifest | null = null;
  private player: InstanceType<typeof Player> | null = null;
  private activeId: string | null = null;
  private rafHandle = 0;
  private playing = false;
  private pillEls = new Map<string, HTMLButtonElement>();
  // Last chapter we auto-scrolled the strip to. `updateActiveChapter` runs
  // every rAF tick, so we only scroll the active pill into view when the
  // active chapter actually changes — not on every frame.
  private lastActiveChapterId: string | null = null;
  // Chapter strip's hold-to-scroll arrows (desktop only) + their flex wrapper,
  // and the rAF handle for an in-progress hold.
  private navEl: HTMLElement | null = null;
  private prevArrow: HTMLButtonElement | null = null;
  private nextArrow: HTMLButtonElement | null = null;
  private arrowRaf: number | null = null;
  private dockEl: HTMLElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  private highlightEnabled = true;
  private highlightBtn: HTMLButtonElement | null = null;
  // Spoken-script drawer + per-mark segment elements.
  private drawerEl: HTMLElement | null = null;
  private drawerTabBtn: HTMLButtonElement | null = null;
  private segmentEls = new Map<string, HTMLElement>();
  private drawerOpen = false;
  // The post's URL path (e.g. `/posts/hash-functions`) — the key both
  // `/post-version` and `/dev/regenerate` expect (the server indexes posts by
  // URL path, not bare slug; matches how comments.ts identifies the post).
  private postPath = "";
  // Cached progress-bar element so the rAF ticker can update its width directly
  // (see comment on `updateBar` for why we drive the bar ourselves).
  private playedBarEl: HTMLElement | null = null;

  constructor(
    private manifestUrl: string,
    private playerContainer: HTMLElement,
    private chapterContainer: HTMLElement | null,
    private narrationRoot: HTMLElement,
    private title: string,
    private artist: string,
  ) {}

  async init() {
    let manifest: Manifest;
    try {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) throw new Error(`Manifest ${res.status}`);
      manifest = (await res.json()) as Manifest;
    } catch (err) {
      console.warn("Narrator init failed:", err);
      this.playerContainer.textContent =
        "Narration unavailable — run `bun run generate`.";
      this.playerContainer.classList.add("narrate-player-error");
      return;
    }
    this.manifest = manifest;
    this.postPath = window.location.pathname;

    this.player = new Player({
      container: this.playerContainer,
      // We position the surrounding `.narrate-dock` ourselves so Shikwasa
      // and the chapter strip travel together.
      fixed: { type: "static" },
      // Lock the player to its dark variant regardless of OS color scheme —
      // the surrounding website is light-only and won't ever support dark
      // mode, but the dark dock contrasts the article nicely. Without this,
      // Shikwasa defaults to "auto" and flips to light on light-mode OSes.
      theme: "dark",
      themeColor: "#58a6ff",
      speedOptions: [0.75, 1, 1.25, 1.5, 1.75, 2],
      preload: "auto",
      audio: {
        title: this.title,
        artist: this.artist,
        src: manifest.audio,
        // Shikwasa's audio config is second-based; the manifest is ms.
        duration: msToSeconds(manifest.duration),
        chapters: manifest.chapters.map((c) => ({
          title: c.title,
          startTime: msToSeconds(c.startTime),
          endTime: msToSeconds(c.endTime),
        })),
      },
    });

    this.renderChapters(manifest);
    this.setupChapterStrip();
    this.setupVisibilityToggle();
    this.setupHighlightToggle();
    this.setupCloseButton();
    this.setupSmoothBar();
    this.setupKeyboardShortcuts();
    this.buildDrawer(manifest);
    void this.maybeEnableAuthorTools();
    this.applyHashIfMatching();
    window.addEventListener("hashchange", () => this.applyHashIfMatching());

    this.player.on("play", () => this.onPlay());
    this.player.on("pause", () => this.onPause());
    this.player.on("ended", () => this.onEnded());
    this.player.on("seeked", () => this.updateActive());
    // Shikwasa's chapter plugin fires this whenever the active chapter changes
    // — including when the user drags the scrub bar across a boundary.
    this.player.on("chapterchange", () => this.updateActiveChapter());
  }

  private jumpToChapter(chapter: ManifestChapter) {
    if (!this.player) return;
    // Seek a hair past startTime so the chapter plugin reliably considers
    // us inside the new chapter for `chapterchange` (its check is t >=
    // startTime && t < endTime).
    this.seekToMs(asMs(chapter.startTime + 10));
    this.player.play();
  }

  // Injects one always-visible "Listen" pill in the viewport's bottom-right
  // corner that toggles the dock's visibility. Clicking it when the dock is
  // open slides the dock off-screen; clicking it when the dock is hidden
  // brings the dock back. Audio keeps playing in either case.
  //
  // On narrow viewports (≤ 1000px) the dock spans almost the full
  // width, so we hide the floating Listen pill while the dock is open
  // and use an in-player × instead (see `setupCloseButton`). The
  // dock's measured height is still mirrored into a CSS custom
  // property (`--narrate-dock-height`) for downstream consumers —
  // notably the comments mobile-popover positioner, which reserves
  // bottom-of-viewport space above the dock. ResizeObserver keeps the
  // variable in sync as the player or chapter strip changes height
  // (e.g. on orientation change or when a wrapping chapter row
  // materializes).
  private setupVisibilityToggle() {
    const dock = this.playerContainer.closest(".narrate-dock") as HTMLElement | null;
    if (!dock) return;
    this.dockEl = dock;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "narrate-toggle";
    btn.setAttribute("aria-label", "Toggle narration player");
    btn.setAttribute("aria-expanded", "true");
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 2a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-7H5v-2a7 7 0 0 1 14 0v2h-3v7h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z" fill="currentColor"/>' +
      '</svg><span>Listen</span>';
    btn.addEventListener("click", () => {
      this.setDockHidden(dock.dataset.hidden !== "true" ? true : false);
    });
    dock.parentNode?.insertBefore(btn, dock.nextSibling);
    this.toggleBtn = btn;

    // Mirror the dock's measured height into a CSS variable on the
    // document root. We read it from CSS (see narrator.css) only when
    // the toggle is expanded on a narrow viewport, but it's cheap to
    // maintain unconditionally.
    const writeDockHeight = (h: number) => {
      document.documentElement.style.setProperty(
        "--narrate-dock-height",
        `${Math.round(h)}px`,
      );
    };
    writeDockHeight(dock.offsetHeight);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        writeDockHeight(entry.contentRect.height);
      });
      ro.observe(dock);
    }
  }

  private setDockHidden(hidden: boolean) {
    if (!this.dockEl || !this.toggleBtn) return;
    this.dockEl.dataset.hidden = String(hidden);
    this.dockEl.setAttribute("aria-hidden", String(hidden));
    this.toggleBtn.setAttribute("aria-expanded", String(!hidden));
    // Audio intentionally keeps playing — the user may be hiding the UI to
    // read along undistracted. They can pause with Space if they want.
  }

  // Page-global keyboard shortcuts:
  //   Space        → toggle play/pause (ALWAYS — even when a button has
  //                   focus; matches Apple Podcasts / Spotify / YouTube)
  //   ←  /  →      → rewind / fast-forward by 10s (matches the dock's
  //                   own backward/forward buttons)
  //   1..9         → jump to chapter N (1-indexed)
  // Skipped while typing in a form field or with a modifier held.
  private setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (!this.player || !this.manifest) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) return;

      if (e.code === "Space") {
        // Override the default Space-activates-focused-button behavior so a
        // focused chapter pill or the visibility toggle doesn't intercept
        // playback control. Buttons remain activatable via Enter.
        e.preventDefault();
        this.player.toggle();
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.skipBy(asMs(-10_000));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        this.skipBy(asMs(10_000));
        return;
      }

      if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        const chapter = this.manifest.chapters[idx];
        if (!chapter) return;
        e.preventDefault();
        this.jumpToChapter(chapter);
      }
    });
  }

  // Injects a toggle inside Shikwasa's basic controls row that turns
  // narration highlighting on/off. When off:
  //   - `.narration-active` is not applied to any element
  //   - the `article.narrating` dim class is not applied
  //   - auto-scroll while playing is suppressed
  // Useful for taking screenshots of the article in its "clean" state
  // while audio is playing. Active marks are still tracked internally so
  // re-enabling resumes from the correct position.
  private setupHighlightToggle() {
    const basic = this.playerContainer.querySelector(".shk-controls_basic");
    if (!basic) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shk-btn narrate-highlight-btn";
    btn.setAttribute("aria-label", "Toggle narration highlighting");
    btn.setAttribute("aria-pressed", "true");
    btn.title = "Hide highlighting";
    btn.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" fill="currentColor"/>' +
      '</svg>';
    btn.addEventListener("click", () => {
      this.setHighlightEnabled(!this.highlightEnabled);
    });
    // Place after Shikwasa's "forward" button (and before the hidden "more"
    // button) so it sits at the right end of the visible controls row.
    const moreBtn = basic.querySelector(".shk-btn_more");
    if (moreBtn) basic.insertBefore(btn, moreBtn);
    else basic.appendChild(btn);
    this.highlightBtn = btn;
  }

  // Inject a close × in the top-right corner of the player card. Shown
  // only on small screens (CSS media query) — on desktop the floating
  // "Listen" pill is the close affordance and the in-player × would
  // just be redundant. On mobile the dock takes most of the viewport
  // width and the pill would otherwise sit on top of the dock, so the
  // pill is hidden when the dock is open and the in-player × replaces
  // it as the dismiss control.
  private setupCloseButton() {
    const player = this.playerContainer.querySelector(".shk-player") as HTMLElement | null;
    if (!player) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "narrate-close-btn";
    btn.setAttribute("aria-label", "Close narration player");
    btn.title = "Close player";
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.addEventListener("click", () => this.setDockHidden(true));
    player.appendChild(btn);
  }

  // Shikwasa updates `.shk-bar_played` on `timeupdate`, which fires ~4×/sec.
  // The default CSS transition (width .1s ease-in) smooths each step but
  // still leaves a visible ~150ms idle between updates, so playback looks
  // steppy. We cache the bar element here, disable its transition, and let
  // `updateBar` (called from our existing rAF tick) write the width 60×/sec
  // straight from `audio.currentTime`. Shikwasa's own timeupdate write still
  // runs — it just gets overwritten on the next animation frame.
  private setupSmoothBar() {
    const bar = this.playerContainer.querySelector(".shk-bar_played") as HTMLElement | null;
    if (!bar) return;
    bar.style.transition = "none";
    this.playedBarEl = bar;
  }

  private updateBar() {
    if (!this.playedBarEl || !this.player) return;
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    if (!audio) return;
    const duration = audio.duration;
    if (!duration || !isFinite(duration)) return;
    const pct = Math.max(0, Math.min(1, audio.currentTime / duration));
    this.playedBarEl.style.width = pct * 100 + "%";
  }

  private setHighlightEnabled(enabled: boolean) {
    this.highlightEnabled = enabled;
    if (this.highlightBtn) {
      this.highlightBtn.setAttribute("aria-pressed", String(enabled));
      this.highlightBtn.title = enabled ? "Hide highlighting" : "Show highlighting";
    }
    if (enabled) {
      // Re-apply the visuals from current state.
      if (this.playing) this.narrationRoot.classList.add("narrating");
      if (this.activeId) {
        const el = this.narrationRoot.querySelector(`#${CSS.escape(this.activeId)}`);
        el?.classList.add("narration-active");
      }
    } else {
      // Strip every visual artifact so the page looks unhooked from the player.
      this.narrationRoot.classList.remove("narrating");
      if (this.activeId) {
        const el = this.narrationRoot.querySelector(`#${CSS.escape(this.activeId)}`);
        el?.classList.remove("narration-active");
      }
    }
  }

  private skipBy(ms: Milliseconds) {
    if (!this.player || !this.manifest) return;
    // Read currentTime from the underlying audio element rather than
    // player.currentTime so we share the same code path as seekToMs()
    // and don't depend on Shikwasa's wrapper accessor.
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    const currentMs = secondsToMs(asSeconds(audio?.currentTime ?? 0));
    const target = asMs(Math.max(0, Math.min(this.manifest.duration, currentMs + ms)));
    this.seekToMs(target);
  }

  private renderChapters(manifest: Manifest) {
    if (!this.chapterContainer) return;
    this.chapterContainer.innerHTML = "";
    this.pillEls.clear();
    manifest.chapters.forEach((chapter, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chapter-pill";
      btn.dataset.chapterId = chapter.id;
      btn.setAttribute("aria-label", `Jump to chapter ${i + 1}: ${chapter.title}`);
      btn.innerHTML = `<span class="ch-num">${i + 1}</span><span class="ch-title"></span>`;
      btn.querySelector(".ch-title")!.textContent = chapter.title;
      btn.addEventListener("click", () => this.jumpToChapter(chapter));
      this.pillEls.set(chapter.id, btn);
      this.chapterContainer!.appendChild(btn);
    });
    this.lastActiveChapterId = null;
    this.updateChapterFades();
    this.updateActiveChapter();
  }

  // Wraps the chapter strip in a flex row flanked by hold-to-scroll ‹ / ›
  // arrows, and wires the scroll/resize listeners that keep the edge fades and
  // arrow states current. Runs once (the strip element persists across
  // re-renders, so the wrapper and listeners must not be rebound per render).
  private setupChapterStrip() {
    const strip = this.chapterContainer;
    if (!strip) return;
    const parent = strip.parentElement;
    if (parent) {
      const nav = document.createElement("div");
      nav.className = "chapter-nav";
      parent.insertBefore(nav, strip);
      this.prevArrow = this.makeChapterArrow(-1, "Scroll to earlier chapters");
      this.nextArrow = this.makeChapterArrow(1, "Scroll to later chapters");
      // Moves `strip` out of `parent` and between the two arrows.
      nav.append(this.prevArrow, strip, this.nextArrow);
      this.navEl = nav;
    }
    // Recompute fades/arrow state as the strip scrolls (passive — read-only)
    // and whenever its width changes (orientation flip, dock resize).
    strip.addEventListener("scroll", () => this.updateChapterFades(), {
      passive: true,
    });
    new ResizeObserver(() => this.updateChapterFades()).observe(strip);
    // Translate vertical (and horizontal) wheel input into horizontal scroll.
    // Browsers don't reliably map a vertical wheel onto a horizontally-only
    // scrollable element (Firefox doesn't at all), so we do it ourselves —
    // but only when the strip can still scroll that way, otherwise we let the
    // event through so the page keeps scrolling at the edges.
    strip.addEventListener(
      "wheel",
      (e) => {
        const max = strip.scrollWidth - strip.clientWidth;
        if (max <= 0) return;
        const unit = e.deltaMode === 1 ? 16 : 1; // line vs. pixel mode
        const raw =
          Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const delta = raw * unit;
        if (delta === 0) return;
        const atStart = strip.scrollLeft <= 0;
        const atEnd = strip.scrollLeft >= max;
        if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
        e.preventDefault();
        strip.scrollLeft += delta;
      },
      { passive: false },
    );
    this.updateChapterFades();
  }

  // A press-and-hold scroll arrow. Holding scrolls the strip continuously via
  // rAF (mouse/touch through pointer events); a keyboard activation — which
  // fires `click` with `detail === 0` and no pointer sequence — nudges one
  // step. The arrow disables itself at the matching edge (see
  // updateChapterFades) and stops mid-hold if it reaches that edge.
  private makeChapterArrow(dir: 1 | -1, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chapter-arrow chapter-arrow-${dir < 0 ? "prev" : "next"}`;
    btn.setAttribute("aria-label", label);
    // Decorative glyph; the aria-label carries the accessible name.
    btn.innerHTML = `<span aria-hidden="true">${dir < 0 ? "‹" : "›"}</span>`;
    const release = () => this.stopArrowScroll();
    btn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault(); // don't steal focus / start a text selection
      btn.setPointerCapture(e.pointerId);
      this.startArrowScroll(dir);
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("click", (e) => {
      if (e.detail === 0) this.nudgeChapterStrip(dir); // keyboard activation
    });
    return btn;
  }

  private startArrowScroll(dir: 1 | -1) {
    const strip = this.chapterContainer;
    if (!strip || this.arrowRaf != null) return;
    // Time-based (frame-rate-independent) velocity that eases in, so a hold
    // ramps up smoothly instead of snapping straight to full speed. A small
    // starting floor keeps a quick tap responsive rather than barely moving.
    const MAX_V = 0.85; // px/ms at full speed (~850px/s)
    const RAMP_MS = 450; // time to reach full speed
    const BASE = 0.18; // fraction of MAX_V applied immediately
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let startTs: number | null = null;
    let lastTs = 0;
    const step = (ts: number) => {
      if (startTs == null) startTs = lastTs = ts;
      const dt = ts - lastTs;
      lastTs = ts;
      const t = reduce ? 1 : Math.min(1, (ts - startTs) / RAMP_MS);
      const eased = t * t * (3 - 2 * t); // smoothstep
      const v = MAX_V * (BASE + (1 - BASE) * eased);
      const max = strip.scrollWidth - strip.clientWidth;
      strip.scrollLeft = Math.max(0, Math.min(max, strip.scrollLeft + dir * v * dt));
      // Stop once we reach the edge we're heading toward (direction-aware, so
      // the first frame — when dt is 0 and we sit at scrollLeft 0 — doesn't
      // immediately satisfy a naive `<= 0` check and kill the hold).
      const atTargetEdge = dir > 0 ? strip.scrollLeft >= max : strip.scrollLeft <= 0;
      if (atTargetEdge) {
        this.stopArrowScroll();
        return;
      }
      this.arrowRaf = requestAnimationFrame(step);
    };
    this.arrowRaf = requestAnimationFrame(step);
  }

  private stopArrowScroll() {
    if (this.arrowRaf != null) {
      cancelAnimationFrame(this.arrowRaf);
      this.arrowRaf = null;
    }
  }

  private nudgeChapterStrip(dir: 1 | -1) {
    const strip = this.chapterContainer;
    if (!strip) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollBy({
      left: dir * strip.clientWidth * 0.8,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  // Toggle the strip's left/right fade masks (and the matching arrow's disabled
  // state) based on how much is scrolled out of view on each side, so the strip
  // only dissolves — and an arrow only stays live — where there's more to reach.
  private updateChapterFades() {
    const strip = this.chapterContainer;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    // 1px slack absorbs sub-pixel rounding so a fully-scrolled edge reads as 0.
    const atStart = strip.scrollLeft <= 1;
    const atEnd = strip.scrollLeft >= max - 1;
    strip.style.setProperty("--fade-l", atStart ? "0px" : "var(--fade-w)");
    strip.style.setProperty("--fade-r", atEnd ? "0px" : "var(--fade-w)");
    if (this.prevArrow) this.prevArrow.disabled = atStart;
    if (this.nextArrow) this.nextArrow.disabled = atEnd;
    // Hide the arrow rail entirely when nothing overflows (CSS also gates it to
    // fine-pointer devices, so touch viewports never show arrows).
    this.navEl?.classList.toggle("has-overflow", max > 1);
  }

  // Bring the active chapter pill into the center of the horizontal strip,
  // scrolling only the strip (never the page — `block: nearest` and a
  // contained `scrollBy` avoid disturbing vertical position).
  private scrollPillIntoView(el: HTMLElement) {
    const strip = this.chapterContainer;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const pillRect = el.getBoundingClientRect();
    const delta =
      pillRect.left - stripRect.left - (strip.clientWidth - el.clientWidth) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollBy({ left: delta, behavior: reduce ? "auto" : "smooth" });
  }

  // Shikwasa's `player.seek(time)` internally calls `parseInt(time)`, which
  // truncates fractional seconds to whole-second integers — so seeking to
  // 8.826 actually lands at 8.0, mid-way through the previous chapter.
  // Write directly to the underlying HTMLAudioElement (exposed as
  // `player.audio`) for sample-accurate seeking. Falls back to the broken
  // API if a future Shikwasa version hides the element.
  private seekToMs(ms: Milliseconds) {
    const seconds = msToSeconds(ms);
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    if (audio) {
      audio.currentTime = seconds;
    } else {
      this.player?.seek(seconds);
    }
  }

  private updateActiveChapter() {
    if (!this.manifest || !this.player) return;
    const tMs = secondsToMs(asSeconds(this.player.currentTime));
    const active = this.manifest.chapters.find(
      (c) => tMs >= c.startTime && tMs < c.endTime,
    ) ?? this.manifest.chapters[0];
    for (const [id, el] of this.pillEls) {
      const isActive = id === active?.id;
      el.toggleAttribute("data-active", isActive);
      el.setAttribute("aria-current", isActive ? "true" : "false");
    }
    // Keep the active pill in view, but only when the chapter actually
    // changed (this runs every rAF tick via updateActive).
    if (active && active.id !== this.lastActiveChapterId) {
      this.lastActiveChapterId = active.id;
      const el = this.pillEls.get(active.id);
      if (el) this.scrollPillIntoView(el);
    }
  }

  private onPlay() {
    this.playing = true;
    if (this.highlightEnabled) this.narrationRoot.classList.add("narrating");
    this.startTicker();
  }
  private onPause() {
    this.playing = false;
    this.stopTicker();
  }
  private onEnded() {
    this.playing = false;
    this.stopTicker();
    this.narrationRoot.classList.remove("narrating");
    this.setActive(null);
  }

  // rAF gives smoother highlight transitions than `timeupdate` (which only
  // fires ~4x/sec). Marks can be dense (every sentence) so precision matters.
  private startTicker() {
    const tick = () => {
      this.updateActive();
      this.rafHandle = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = requestAnimationFrame(tick);
  }
  private stopTicker() {
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private updateActive() {
    if (!this.manifest || !this.player) return;
    // Keep chapter pills in sync alongside the per-mark highlight; on raw
    // seeks Shikwasa may not always emit chapterchange before the tick.
    this.updateActiveChapter();
    this.updateBar();
    const tMs = secondsToMs(asSeconds(this.player.currentTime));
    // Find the latest mark with time <= tMs. This works for both linear
    // playback AND backward seeks — we never advance an index, we derive
    // the active mark from currentTime each tick.
    let active: ManifestMark | null = null;
    for (const m of this.manifest.marks) {
      if (m.time <= tMs) active = m;
      else break;
    }
    this.setActive(active ? active.name : null);
  }

  private setActive(id: string | null) {
    if (id === this.activeId) return;
    // The previous .narration-active removal is unconditional — it's a
    // no-op if the class isn't applied (which is the case while
    // highlighting is disabled), and we want it to actually take effect
    // immediately after re-enabling highlighting on a fresh active mark.
    if (this.activeId) {
      const prev = this.narrationRoot.querySelector(
        `#${CSS.escape(this.activeId)}`,
      );
      prev?.classList.remove("narration-active");
      this.segmentEls.get(this.activeId)?.classList.remove("narration-active");
    }
    if (id) {
      const el = this.narrationRoot.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        if (this.highlightEnabled) {
          el.classList.add("narration-active");
          // Only auto-scroll while playing AND highlighting is enabled;
          // unsolicited scroll defeats the screenshot-friendly mode.
          if (this.playing) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      } else {
        console.warn(`Narration mark "${id}" has no matching element`);
      }
      // The drawer segment mirrors the highlight regardless of
      // `highlightEnabled` — that flag is about the article's reading-clean
      // mode, not about the drawer (whose entire purpose is to surface the
      // spoken script). Scroll inside the drawer only when it's open; the
      // drawer body's overflow-y keeps the page itself from scrolling.
      const seg = this.segmentEls.get(id);
      if (seg) {
        seg.classList.add("narration-active");
        if (this.drawerOpen) {
          seg.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
    this.activeId = id;
  }

  // Build the slide-in drawer that lists the full spoken script grouped by
  // chapter. Each segment is an <article id="spoken-<markName>"> so external
  // anchors and future comment threads can target it by stable ID.
  private buildDrawer(manifest: Manifest) {
    const drawer = document.createElement("aside");
    drawer.id = "narrate-drawer";
    drawer.className = "narrate-drawer";
    drawer.setAttribute("aria-label", "Spoken script");
    drawer.dataset.open = "false";

    // Tab handle attached to the drawer's left edge. Travels with the drawer
    // — when closed it juts into the viewport from the right; when open it
    // sits at the drawer's left edge inside the page.
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "narrate-drawer-tab";
    tab.setAttribute("aria-controls", "narrate-drawer");
    tab.setAttribute("aria-expanded", "false");
    tab.setAttribute("aria-label", "Open spoken script");
    tab.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm10 0v5h4M8 12h8M8 16h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<span class="tab-label">Script</span>';
    tab.addEventListener("click", () => this.setDrawerOpen(!this.drawerOpen));
    drawer.appendChild(tab);
    this.drawerTabBtn = tab;

    // Header with title + close affordance.
    const header = document.createElement("header");
    header.className = "narrate-drawer-header";
    const h2 = document.createElement("h2");
    h2.textContent = "Spoken script";
    header.appendChild(h2);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "narrate-drawer-close";
    closeBtn.setAttribute("aria-label", "Close spoken script");
    closeBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener("click", () => this.setDrawerOpen(false));
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Body: one section per chapter, each section is a list of segments.
    const body = document.createElement("div");
    body.className = "narrate-drawer-body";

    const byChapter = new Map<string, ManifestMark[]>();
    for (const mark of manifest.marks) {
      if (!byChapter.has(mark.chapter)) byChapter.set(mark.chapter, []);
      byChapter.get(mark.chapter)!.push(mark);
    }

    for (const chapter of manifest.chapters) {
      const marks = byChapter.get(chapter.id) ?? [];
      if (marks.length === 0) continue;
      const section = document.createElement("section");
      section.className = "spoken-chapter";
      section.dataset.chapter = chapter.id;

      const heading = document.createElement("h3");
      heading.textContent = chapter.title;
      section.appendChild(heading);

      const ol = document.createElement("ol");
      ol.className = "spoken-segments";
      for (const mark of marks) {
        ol.appendChild(this.renderSegment(mark));
      }
      section.appendChild(ol);
      body.appendChild(section);
    }
    drawer.appendChild(body);

    document.body.appendChild(drawer);
    this.drawerEl = drawer;
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
      this.seekToMs(asMs(mark.time + 10));
      this.player?.play();
    });
    seg.appendChild(play);

    const text = document.createElement("p");
    text.className = "spoken-text";
    text.textContent = mark.text ?? "";
    seg.appendChild(text);

    li.appendChild(seg);
    this.segmentEls.set(mark.name, seg);
    return li;
  }

  private setDrawerOpen(open: boolean) {
    if (!this.drawerEl || !this.drawerTabBtn) return;
    if (this.drawerOpen === open) return;
    this.drawerOpen = open;
    this.drawerEl.dataset.open = String(open);
    this.drawerTabBtn.setAttribute("aria-expanded", String(open));
    this.drawerTabBtn.setAttribute(
      "aria-label",
      open ? "Close spoken script" : "Open spoken script",
    );
    document.body.classList.toggle("drawer-open", open);
    // When opening with an active mark already, jump the drawer to it so the
    // user doesn't have to hunt.
    if (open && this.activeId) {
      const seg = this.segmentEls.get(this.activeId);
      // Defer past the open-transition's first frame so layout has settled
      // and `scrollIntoView` finds non-zero dimensions.
      requestAnimationFrame(() => {
        seg?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  // If the page was loaded (or navigated to) with a URL fragment that points
  // at a spoken segment, open the drawer and bring that segment into view.
  // Plain `#elementId` fragments still scroll the article as the browser does
  // by default — we only intervene for our prefixed ids.
  private applyHashIfMatching() {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return;
    const id = decodeURIComponent(hash.slice(1));
    if (!id.startsWith(SPOKEN_ID_PREFIX)) return;
    const markName = id.slice(SPOKEN_ID_PREFIX.length);
    const seg = this.segmentEls.get(markName);
    if (!seg) return;
    this.setDrawerOpen(true);
    // Highlight briefly so it's easy to spot when arrived from a link.
    seg.classList.add("anchor-flash");
    setTimeout(() => seg.classList.remove("anchor-flash"), 1500);
    requestAnimationFrame(() => {
      seg.scrollIntoView({ behavior: "smooth", block: "center" });
      seg.focus({ preventScroll: true });
    });
  }

  // Author-only, dev-only per-segment "regenerate audio" tool. Gated on BOTH:
  //   - localhost — the `/dev/regenerate` endpoint that shells out to the
  //     generate pipeline exists only on the dev Bun server, never the prod
  //     Worker (see server/regenerate.dev.ts). On any other host the button
  //     would 404, so we don't show it.
  //   - the server-authoritative `isAuthor` flag from `/post-version` — the
  //     same check the comments UI uses. Never trust the DOM for this.
  // Non-localhost visitors short-circuit before any fetch, so this is a no-op
  // for ordinary readers.
  private async maybeEnableAuthorTools() {
    const isLocal =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!isLocal || !this.postPath) return;
    let isAuthor = false;
    try {
      const res = await fetch(`/post-version?post=${encodeURIComponent(this.postPath)}`, {
        credentials: "same-origin",
      });
      if (res.ok) isAuthor = (await res.json())?.isAuthor === true;
    } catch {
      return;
    }
    if (!isAuthor) return;
    for (const [markName, seg] of this.segmentEls) this.addRegenButton(seg, markName);
  }

  private addRegenButton(seg: HTMLElement, markName: string) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spoken-regen";
    btn.title = "Regenerate this segment's audio (MOSS, author-only)";
    btn.setAttribute("aria-label", `Regenerate audio for ${markName}`);
    btn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" fill="currentColor"/></svg>';
    btn.addEventListener("click", () => void this.regenerateSegment(btn, markName));
    // Sit between the play button and the spoken text.
    const play = seg.querySelector(".spoken-play");
    if (play?.nextSibling) seg.insertBefore(btn, play.nextSibling);
    else seg.appendChild(btn);
  }

  // Re-roll one segment, then hard-reload so the rebuilt manifest + audio are
  // picked up cleanly (MOSS is probabilistic, so each click is a fresh take).
  // We land back on this segment with the drawer open via the URL hash, so the
  // loop is: click → wait → reload here → press play → repeat. A full reload
  // (vs. surgically swapping Shikwasa's source) is deliberate: it's bulletproof
  // and the model-load latency dwarfs a page reload.
  //
  // The job runs ASYNCHRONOUSLY on the server (a full render is minutes, longer
  // than any HTTP idle timeout), so we POST to *start* it and then POLL for
  // completion — the spinner reflects the actual job, not the request. A naive
  // long-lived request would have its connection killed mid-render, clearing
  // the spinner while generation silently continued.
  private async regenerateSegment(btn: HTMLButtonElement, markName: string) {
    if (btn.dataset.busy === "true") return;
    btn.dataset.busy = "true";
    btn.classList.add("is-busy");
    btn.disabled = true;
    btn.title = "Regenerating… (full render is slow; don't stop the dev server)";
    try {
      const start = await fetch(
        `/dev/regenerate?post=${encodeURIComponent(this.postPath)}&mark=${encodeURIComponent(markName)}`,
        { method: "POST", credentials: "same-origin" },
      );
      if (start.status === 409) {
        window.alert("A regeneration is already in progress — try again once it finishes.");
        return;
      }
      if (start.status !== 202) {
        window.alert(await this.regenErrorMessage(start));
        return;
      }
      // Poll until the server reports the job done.
      const result = await this.pollRegenStatus();
      if (result.ok) {
        window.location.hash = SPOKEN_ID_PREFIX + markName;
        window.location.reload();
        return;
      }
      window.alert(`Regeneration failed.${result.error ? `\n\n${result.error}` : ""}`);
    } catch (err) {
      window.alert(
        `Regeneration request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Reached on every non-reload path (error / 409); on success the page has
      // already navigated away.
      btn.dataset.busy = "false";
      btn.classList.remove("is-busy");
      btn.disabled = false;
      btn.title = "Regenerate this segment's audio (MOSS, author-only)";
    }
  }

  // Poll GET /dev/regenerate every few seconds until the job stops running.
  // Capped so a hung/never-finishing job doesn't spin forever.
  private async pollRegenStatus(): Promise<{ ok: boolean; error?: string }> {
    const intervalMs = 2500;
    const maxMs = 30 * 60 * 1000; // 30 min ceiling for a worst-case cold render
    const deadline = Date.now() + maxMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, intervalMs));
      let body: { running?: boolean; ok?: boolean; error?: string };
      try {
        const res = await fetch("/dev/regenerate", { credentials: "same-origin" });
        if (!res.ok) return { ok: false, error: `status poll failed (HTTP ${res.status})` };
        body = await res.json();
      } catch (err) {
        return {
          ok: false,
          error: `status poll failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (body.running === false) return { ok: body.ok === true, error: body.error };
      if (Date.now() > deadline) {
        return { ok: false, error: "timed out waiting for regeneration to finish" };
      }
    }
  }

  private async regenErrorMessage(res: Response): Promise<string> {
    let msg = `Could not start regeneration (HTTP ${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) msg += `\n\n${body.error}`;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) msg += `\n\n${text}`;
    }
    return msg;
  }
}

function boot() {
  const root = document.querySelector<HTMLElement>("[data-narration-src]");
  const container = document.getElementById("narrate-player");
  const chapters = document.getElementById("narrate-chapters");
  if (!root || !container) return;
  const manifestUrl = root.dataset.narrationSrc;
  if (!manifestUrl) return;
  new Narrator(
    manifestUrl,
    container,
    chapters,
    root,
    root.dataset.narrationTitle ?? document.title,
    root.dataset.narrationArtist ?? "",
  ).init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
