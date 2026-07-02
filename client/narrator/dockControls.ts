// methodology.md → Narrator — the dock chrome: the Listen visibility pill (+
// the `--narrate-dock-height` custom property it publishes), the in-player
// close ×, the media-key capture toggle, the highlight toggle, and the
// rAF-smoothed progress bar. Owns `highlightEnabled`; `captureControls` stays
// orchestrator-owned (D8).

import type { Narrator } from "../narrator.ts";
import { saveCaptureControls } from "../narratorDom.ts";

export class DockControls {
  constructor(private readonly sys: Narrator) {}

  private dockEl: HTMLElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  highlightEnabled = true;
  private highlightBtn: HTMLButtonElement | null = null;
  private captureBtn: HTMLButtonElement | null = null;
  // Cached progress-bar element so the rAF ticker can update its width directly
  // (see comment on `updateBar` for why we drive the bar ourselves).
  private playedBarEl: HTMLElement | null = null;

  // Injects a "Listen" pill in the viewport's bottom-right corner that
  // re-opens the dock after the in-player × has dismissed it. Hidden
  // while the dock is open (see `narrate-toggle[aria-expanded="true"]`
  // in narrator.css) and only revealed once `setDockHidden(true)` runs;
  // the in-player × (`setupCloseButton`) is the always-visible close
  // partner. The split-affordance shape — × on the player, pill in the
  // corner — keeps the pill from colliding with the dock on narrow
  // viewports AND avoids two on-screen headphones glyphs at once (the
  // pill's glyph and the capture toggle's glyph would otherwise both
  // be visible inside the open dock).
  //
  // The dock's measured height is mirrored into a CSS custom property
  // (`--narrate-dock-height`) for downstream consumers — notably the
  // comments mobile-popover positioner, which reserves
  // bottom-of-viewport space above the dock. ResizeObserver keeps the
  // variable in sync as the player or chapter strip changes height
  // (e.g. on orientation change or when a wrapping chapter row
  // materializes).
  setupVisibilityToggle() {
    const dock = this.sys.playerContainer.closest(".narrate-dock") as HTMLElement | null;
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

  // Reveal the dock once it's fully built (or on error, so the nudge shows).
  // Independent of the visibility toggle so the error path — which returns
  // before setupVisibilityToggle wires `toggleBtn` — can still reveal it. The
  // build ships the dock `data-hidden="true"` in both dev and prod; this clears
  // it. (A harmless no-op if some context served the dock un-hidden.)
  revealDock() {
    const dock =
      this.dockEl ?? (this.sys.playerContainer.closest(".narrate-dock") as HTMLElement | null);
    if (!dock) return;
    dock.dataset.hidden = "false";
    dock.setAttribute("aria-hidden", "false");
    this.toggleBtn?.setAttribute("aria-expanded", "true");
  }

  // Injects a toggle inside Shikwasa's basic controls row that releases
  // (or re-acquires) the OS media-session surface — lock screen, hardware
  // media keys, Bluetooth-headset taps. When OFF the metadata, action
  // handlers, and rAF position-state pushes are all torn down; when ON
  // the surface is armed exactly as it is by default after first play.
  // Persisted globally in localStorage (`narrate-capture-controls`), so
  // the choice carries between posts — the pref is about the reader's
  // relationship to their own music, not about any one talk.
  setupCaptureToggle() {
    const basic = this.sys.playerContainer.querySelector(".shk-controls_basic");
    if (!basic) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shk-btn narrate-capture-btn";
    btn.setAttribute("aria-label", "Toggle media key capture");
    btn.setAttribute("aria-pressed", String(this.sys.captureControls));
    btn.title = this.sys.captureControls
      ? "Release media keys & headset controls"
      : "Capture media keys & headset controls";
    // Headphones glyph — the surface this toggle governs is specifically
    // about audio devices (lock screen, hardware media keys, Bluetooth
    // headset). State is signalled by color only (see narrator.css),
    // mirroring the highlight button — no second SVG variant to keep
    // in sync.
    btn.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 1C7.03 1 3 5.03 3 10v7a3 3 0 0 0 3 3h3v-9H5v-1a7 7 0 1 1 14 0v1h-4v9h3a3 3 0 0 0 3-3v-7c0-4.97-4.03-9-9-9z" fill="currentColor"/>' +
      "</svg>";
    btn.addEventListener("click", () => {
      this.setCaptureControls(!this.sys.captureControls);
    });
    // Insert before the highlight button (which insertBefore-s `.shk-btn_more`
    // when it runs immediately after this in init). That keeps highlight
    // rightmost and preserves the existing corner-× collision fix.
    const moreBtn = basic.querySelector(".shk-btn_more");
    if (moreBtn) basic.insertBefore(btn, moreBtn);
    else basic.appendChild(btn);
    this.captureBtn = btn;
  }

  // Injects a toggle inside Shikwasa's basic controls row that turns
  // narration highlighting on/off. When off:
  //   - `.narration-active` is not applied to any element
  //   - the `article.narrating` dim class is not applied
  //   - auto-scroll while playing is suppressed
  // Useful for taking screenshots of the article in its "clean" state
  // while audio is playing. Active marks are still tracked internally so
  // re-enabling resumes from the correct position.
  setupHighlightToggle() {
    const basic = this.sys.playerContainer.querySelector(".shk-controls_basic");
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

  // Inject a close × in the top-right corner of the player card —
  // always visible. The Listen pill (`setupVisibilityToggle`) is the
  // re-open partner and is hidden while the dock is open, so × and
  // pill never coexist on screen. Two side effects of always-on ×:
  // it avoids a second on-screen headphones glyph competing with the
  // capture toggle, and the corner-clearing `padding-right` rule on
  // `.shk-player` now applies across the whole horizontal-layout band
  // (see narrator.css's `@media (min-width: 641px)`), not just the
  // 641-1000px slice it covered when × was viewport-conditional.
  setupCloseButton() {
    const player = this.sys.playerContainer.querySelector(".shk-player") as HTMLElement | null;
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
  setupSmoothBar() {
    const bar = this.sys.playerContainer.querySelector(".shk-bar_played") as HTMLElement | null;
    if (!bar) return;
    bar.style.transition = "none";
    this.playedBarEl = bar;
  }

  updateBar() {
    if (!this.playedBarEl || !this.sys.player) return;
    const audio = (this.sys.player as unknown as { audio?: HTMLAudioElement }).audio;
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
      if (this.sys.playing) this.sys.narrationRoot.classList.add("narrating");
      if (this.sys.activeId) {
        const el = this.sys.narrationRoot.querySelector(`#${CSS.escape(this.sys.activeId)}`);
        el?.classList.add("narration-active");
      }
    } else {
      // Strip every visual artifact so the page looks unhooked from the player.
      this.sys.narrationRoot.classList.remove("narrating");
      if (this.sys.activeId) {
        const el = this.sys.narrationRoot.querySelector(`#${CSS.escape(this.sys.activeId)}`);
        el?.classList.remove("narration-active");
      }
    }
  }

  private setCaptureControls(enabled: boolean) {
    this.sys.captureControls = enabled;
    if (this.captureBtn) {
      this.captureBtn.setAttribute("aria-pressed", String(enabled));
      this.captureBtn.title = enabled
        ? "Release media keys & headset controls"
        : "Capture media keys & headset controls";
    }
    if (enabled) {
      // Re-arm only if we've already played at least once — otherwise the
      // next onPlay() will arm via the deferred-first-play path (which is
      // also gated on `captureControls`). Calling setupMediaSession
      // pre-firstplay would silently arm metadata + handlers for a talk
      // that hasn't started, exactly what the first-play deferral exists
      // to prevent.
      if (this.sys.hasPlayed) this.sys.media.setupMediaSession();
    } else {
      this.sys.media.teardownMediaSession();
    }
    if (typeof localStorage !== "undefined") {
      // Persist via the pure helper (handles "absent ⇒ ON" by removing
      // the key, and swallows storage-disabled throws).
      saveCaptureControls(localStorage, enabled);
    }
  }
}
