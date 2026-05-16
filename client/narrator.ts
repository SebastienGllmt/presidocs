// Narrator: mounts a Shikwasa audio player fixed to the bottom of the page
// and synchronizes <mark> highlights with playback.
//
// Manifest shape (see scripts/generate.ts):
// {
//   audio: "/audio/<slug>/full.wav",
//   duration: 84.3,
//   chapters: [{ id, title, startTime, endTime }, ...],
//   marks: [{ name: "elementId", time: <absolute seconds>, chapter }, ...]
// }

import "shikwasa/dist/style.css";
import { Player, Chapter } from "shikwasa";

type ManifestMark = { name: string; time: number; chapter: string };
type ManifestChapter = { id: string; title: string; startTime: number; endTime: number };
type Manifest = {
  audio: string;
  duration: number;
  chapters: ManifestChapter[];
  marks: ManifestMark[];
};

// Register the chapter plugin once for the lifetime of the page.
Player.use(Chapter);

class Narrator {
  private manifest: Manifest | null = null;
  private player: InstanceType<typeof Player> | null = null;
  private activeId: string | null = null;
  private rafHandle = 0;
  private playing = false;
  private pillEls = new Map<string, HTMLButtonElement>();
  private dockEl: HTMLElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  private highlightEnabled = true;
  private highlightBtn: HTMLButtonElement | null = null;

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
        duration: manifest.duration,
        chapters: manifest.chapters.map((c) => ({
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
        })),
      },
    });

    this.renderChapters(manifest);
    this.setupVisibilityToggle();
    this.setupHighlightToggle();
    this.setupKeyboardShortcuts();

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
    this.seekToSeconds(chapter.startTime + 0.01);
    this.player.play();
  }

  // Injects one always-visible "Listen" pill in the viewport's bottom-right
  // corner that toggles the dock's visibility. Clicking it when the dock is
  // open slides the dock off-screen; clicking it when the dock is hidden
  // brings the dock back. Audio keeps playing in either case.
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
        this.skipBy(-10);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        this.skipBy(10);
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

  private skipBy(seconds: number) {
    if (!this.player || !this.manifest) return;
    // Read currentTime from the underlying audio element rather than
    // player.currentTime so we share the same code path as seekToSeconds()
    // and don't depend on Shikwasa's wrapper accessor.
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    const current = audio?.currentTime ?? 0;
    const target = Math.max(0, Math.min(this.manifest.duration, current + seconds));
    this.seekToSeconds(target);
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
    this.updateActiveChapter();
  }

  // Shikwasa's `player.seek(time)` internally calls `parseInt(time)`, which
  // truncates fractional seconds to whole-second integers — so seeking to
  // 8.826 actually lands at 8.0, mid-way through the previous chapter.
  // Write directly to the underlying HTMLAudioElement (exposed as
  // `player.audio`) for sample-accurate seeking. Falls back to the broken
  // API if a future Shikwasa version hides the element.
  private seekToSeconds(time: number) {
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    if (audio) {
      audio.currentTime = time;
    } else {
      this.player?.seek(time);
    }
  }

  private updateActiveChapter() {
    if (!this.manifest || !this.player) return;
    const t = this.player.currentTime;
    const active = this.manifest.chapters.find(
      (c) => t >= c.startTime && t < c.endTime,
    ) ?? this.manifest.chapters[0];
    for (const [id, el] of this.pillEls) {
      const isActive = id === active?.id;
      el.toggleAttribute("data-active", isActive);
      el.setAttribute("aria-current", isActive ? "true" : "false");
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
    const t = this.player.currentTime;
    // Find the latest mark with time <= t. This works for both linear
    // playback AND backward seeks — we never advance an index, we derive
    // the active mark from currentTime each tick.
    let active: ManifestMark | null = null;
    for (const m of this.manifest.marks) {
      if (m.time <= t) active = m;
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
    }
    this.activeId = id;
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
