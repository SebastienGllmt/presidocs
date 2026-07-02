// Narrator: mounts a Shikwasa audio player fixed to the bottom of the page
// and synchronizes <mark> highlights with playback.
//
// Manifest shape (see generate/generate.ts):
// {
//   audio: "/audio/<slug>/full.wav",
//   duration: 84300,
//   chapters: [{ id, title, startTime, endTime, parentId? }, ...],
//   marks: [{ name: "elementId", time: <absolute ms>, chapter }, ...]
// }
// Every time field is integer milliseconds; we convert to seconds only at
// the audio element + Shikwasa boundary (their APIs are second-based).

// Route Shikwasa's stylesheet through the `vendor` cascade layer (declared
// in base.css) — see shikwasa-vendor.css for the why.
import "./shikwasa-vendor.css";
import { Player, Chapter } from "shikwasa";
import { asMs, msToSeconds, secondsToMs, asSeconds, type Milliseconds } from "../shared/time.ts";
import { computeActiveMark } from "./narratorTiming.ts";
import { emitNarrationPlay, emitNarrationQuartile } from "./analytics.ts";
import { copyToClipboard } from "./clipboard.ts";
import { QUARTILES, type PlayTrigger, type Quartile } from "../shared/analyticsSchema.ts";
import {
  SPOKEN_ID_PREFIX,
  loadCaptureControls,
} from "./narratorDom.ts";
import { MediaSessionController } from "./narrator/mediaSession.ts";
import { NarratorKeyboard } from "./narrator/keyboard.ts";
import { FigureDriver } from "./narrator/figureDriver.ts";
import { ChapterStrip } from "./narrator/chapterStrip.ts";
import { DockControls } from "./narrator/dockControls.ts";
import { Speakers } from "./narrator/speakers.ts";
import { Drawer } from "./narrator/drawer.ts";
import { OutlinePanel } from "./narrator/outlinePanel.ts";

// The manifest shape (`ManifestWord`/`ManifestMark`/`ManifestChapter`/
// `Manifest`) is declared once in `shared/manifestSchema.ts` and shared with the
// producer (`generate.ts`) and the video renderer, so the page and video can't
// drift on it. `s`/`e` are character offsets into the mark's displayed `text`;
// `t`/`d`/`time`/`startTime`/`endTime`/`duration` carry the `Milliseconds`
// brand. `figure`/`step` are the stage/per-step pointers (methodology.md →
// "Staging a figure from narration" / "Live figure driving"); `words` is the
// per-word karaoke timing (absent without forced alignment); `parentId` marks a
// level-2 chapter (the array stays flat, leaf-only).
import {
  ManifestSchema,
  type Manifest,
  type ManifestChapter,
} from "../shared/manifestSchema.ts";

// SPOKEN_ID_PREFIX / spokenSegmentId are imported from ./narratorDom.ts —
// re-export here so any in-file uses don't need to re-import.
// (Both are used by both the drawer DOM build and applyHashIfMatching.)

// Register the chapter plugin once for the lifetime of the page.
Player.use(Chapter);

export class Narrator {
  readonly media = new MediaSessionController(this);
  readonly keys = new NarratorKeyboard(this);
  readonly figures = new FigureDriver(this);
  readonly strip = new ChapterStrip(this);
  readonly dock = new DockControls(this);
  readonly speakers = new Speakers(this);
  readonly drawer = new Drawer(this);
  readonly outline = new OutlinePanel(this);

  manifest: Manifest | null = null;
  player: InstanceType<typeof Player> | null = null;
  activeId: string | null = null;
  private rafHandle = 0;
  playing = false;
  // Timer that clears the transient "Copied" state on a dev-only segment-name
  // label after a click. One shared handle: only one label flashes at a time.
  private nameCopyTimer: number | null = null;
  // One-shot latch flipped on the user's first play, so
  // setupMediaSession() arms exactly once (idempotent in principle,
  // but no point re-running it). Defers OS "now playing" metadata +
  // action-handler registration until the reader has actually started
  // the talk — Chrome/Safari only make the tab the OS session target
  // on first <audio>.play() anyway, so this just aligns our
  // registration with the platform behaviour and keeps the lock
  // screen clean for talks that never start.
  hasPlayed = false;
  // What the user did to start playback, captured by the most-recent
  // intent-bearing handler (Space, MediaSession `play`, chapter jump…)
  // and consumed once by the first-play latch in `onPlay` to attribute the
  // `narration_play` analytics event. Defaults to "button" because the
  // Shikwasa dock play-button has no hook of its own — anything not
  // explicitly attributed lands as the "in-dock click" case. Reset to
  // "button" on every pause so a Space-pause followed by a dock-click
  // doesn't carry the stale "space" attribution forward.
  lastPlayTrigger: PlayTrigger = "button";
  // Quartiles (25 / 50 / 75 / 100 % of master-track duration) we've already
  // emitted for this page session. The rAF tick consults this on every
  // frame after `hasPlayed`; first cross of each threshold sends a beacon,
  // every subsequent frame is a Set.has short-circuit. In-memory only —
  // a reload starts fresh, which is the semantics we want (a re-listen
  // is a separate session in the dataset).
  private firedQuartiles: Set<Quartile> = new Set();
  // Whether the player captures the OS media-session surface (lock
  // screen, headset taps, hardware media keys). When false the
  // entire surface is released so the reader's own music gets those
  // gestures back. Persisted globally in localStorage under
  // `narrate-capture-controls` (absent ⇒ ON; "off" ⇒ OFF); applied
  // before the first-play arming so a returning reader who released
  // last session stays released without having to re-toggle.
  captureControls = true;
  // The post's URL path (e.g. `/posts/hash-functions`) — the key both
  // `/post-version` and `/dev/regenerate` expect (the server indexes posts by
  // URL path, not bare slug; matches how comments.ts identifies the post).
  private postPath = "";

  constructor(
    private manifestUrl: string,
    public playerContainer: HTMLElement,
    public chapterContainer: HTMLElement | null,
    public narrationRoot: HTMLElement,
    public title: string,
    public artist: string,
  ) {}

  // `pendingKey`: the cold-start keyboard shortcut the lazy loader captured and
  // preventDefault-ed before this module finished loading (e.g. the reader hit
  // Space to start the talk). Replayed once the player is live, below.
  async init(pendingKey?: KeyboardEvent) {
    let manifest: Manifest;
    try {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) throw new Error(`Manifest ${res.status}`);
      // Validate the shape instead of blind-casting: a stale/half-written
      // manifest fails here (routing into the catch's "Narration unavailable"
      // branch) rather than surfacing later as a downstream `undefined.marks`.
      // The manifest is trusted engine-produced data, so this is clearer-failure
      // polish, not security.
      const parsed = ManifestSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Manifest shape invalid");
      manifest = parsed.data;
    } catch (err) {
      console.warn("Narrator init failed:", err);
      this.playerContainer.textContent =
        "Narration unavailable — run `bun run generate`.";
      this.playerContainer.classList.add("narrate-player-error");
      // Reveal the (build-hidden) dock so the nudge is actually visible.
      this.dock.revealDock();
      return;
    }
    this.manifest = manifest;
    this.postPath = window.location.pathname;

    // Read the OS-capture pref before constructing the player — the
    // first-play arming path in `onPlay` reads this flag, and a returning
    // reader who released last session must stay released on the very
    // first play of this page load.
    // Reads the persisted pref via the pure helper (handles missing
    // storage, throw-on-read, and the "absent ⇒ ON" rule uniformly).
    this.captureControls = loadCaptureControls(
      typeof localStorage !== "undefined" ? localStorage : null,
    );

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
      speedOptions: [1, 1.25, 1.5, 1.75, 2, 3],
      // `none` so a passive reader pays no audio bytes — a 30-min talk
      // is ~14 MB at 64 kbps mono. Shikwasa's scrub bar still shows the
      // right duration because we hand it `manifest.duration` directly
      // (`duration:` below); no metadata fetch needed. First press of
      // play opens the connection (~200-500 ms one-shot latency), and
      // the Range support in createDevServer/createWorker takes over
      // for subsequent seeks.
      preload: "none",
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

    this.strip.renderChapters(manifest);
    this.strip.setupChapterStrip();
    this.dock.setupVisibilityToggle();
    // Capture goes in BEFORE highlight: both `insertBefore(.shk-btn_more)`,
    // so the one that arrives last sits just left of `.shk-btn_more` (i.e.
    // rightmost interactive control). Keeping highlight rightmost preserves
    // the existing `padding-right: 44px` × collision fix in the 641-1000px
    // band — see methodology's Audio Player section.
    this.dock.setupCaptureToggle();
    this.dock.setupHighlightToggle();
    this.dock.setupCloseButton();
    this.dock.setupSmoothBar();
    this.keys.setupKeyboardShortcuts();
    this.drawer.buildDrawer();
    this.speakers.setupDividerSpeakers();
    this.speakers.setupHeadingSpeakers();
    void this.maybeEnableAuthorTools();
    this.drawer.applyHashIfMatching();
    window.addEventListener("hashchange", () => this.drawer.applyHashIfMatching());

    this.player.on("play", () => this.onPlay());
    this.player.on("pause", () => this.onPause());
    this.player.on("ended", () => this.onEnded());
    this.player.on("seeked", () => this.updateActive());
    // Shikwasa's chapter plugin fires this whenever the active chapter changes
    // — including when the user drags the scrub bar across a boundary.
    this.player.on("chapterchange", () => this.strip.updateActiveChapter());

    // Everything that determines the dock's height (player + chapter strip) is
    // now mounted, so reveal it. The build ships the dock `data-hidden="true"`
    // (generate/articleChromeReserve.ts → hideNarrateDockForReveal, applied by the
    // bunHtmlHeadPlugin in both dev and prod) so it never painted its empty box;
    // revealing it here slides it up via transform/opacity — neither of which
    // triggers layout shift — so the player costs zero CLS.
    this.dock.revealDock();

    // Replay the cold-start key the loader captured (Space/1-9/arrow pressed
    // before Shikwasa finished loading) now that the player + manifest exist —
    // so a reader who started the talk cold isn't left having to press twice.
    if (pendingKey) this.keys.handleKeyboardEvent(pendingKey);

    // Media Session arming deferred to `onPlay` — see `hasPlayed`. A
    // tab isn't the OS session target until audio actually plays
    // (Chrome/Safari), so pre-arming metadata + handlers would just
    // pollute the lock screen for a reader who never starts.
  }

  jumpToChapter(chapter: ManifestChapter) {
    if (!this.player) return;
    // Seek a hair past startTime so the chapter plugin reliably considers
    // us inside the new chapter for `chapterchange` (its check is t >=
    // startTime && t < endTime).
    this.seekToMs(asMs(chapter.startTime + 10));
    this.lastPlayTrigger = "chapter";
    this.player.play();
  }

  // Jump to the neighbouring chapter (MediaSession previoustrack/nexttrack).
  // Silent no-op at the first/last chapter — same feel as the 1-9 shortcuts.
  jumpToChapterDelta(delta: -1 | 1) {
    if (!this.manifest || !this.player) return;
    const tMs = secondsToMs(asSeconds(this.player.currentTime));
    const idx = this.manifest.chapters.findIndex(
      (c) => tMs >= c.startTime && tMs < c.endTime,
    );
    if (idx < 0) return;
    const target = this.manifest.chapters[idx + delta];
    if (!target) return;
    this.jumpToChapter(target);
  }

  skipBy(ms: Milliseconds) {
    if (!this.player || !this.manifest) return;
    // Read currentTime from the underlying audio element rather than
    // player.currentTime so we share the same code path as seekToMs()
    // and don't depend on Shikwasa's wrapper accessor.
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    const currentMs = secondsToMs(asSeconds(audio?.currentTime ?? 0));
    const target = asMs(Math.max(0, Math.min(this.manifest.duration, currentMs + ms)));
    this.seekToMs(target);
  }

  // Shikwasa's `player.seek(time)` internally calls `parseInt(time)`, which
  // truncates fractional seconds to whole-second integers — so seeking to
  // 8.826 actually lands at 8.0, mid-way through the previous chapter.
  // Write directly to the underlying HTMLAudioElement (exposed as
  // `player.audio`) for sample-accurate seeking. Falls back to the broken
  // API if a future Shikwasa version hides the element.
  seekToMs(ms: Milliseconds) {
    const seconds = msToSeconds(ms);
    const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
    if (audio) {
      audio.currentTime = seconds;
    } else {
      this.player?.seek(seconds);
    }
  }

  private onPlay() {
    if (!this.hasPlayed) {
      // First explicit play: arm the OS surface (metadata + action handlers
      // + position pushes). The latch is one-way — a later pause doesn't tear
      // it down, since the reader has now signalled they want player control.
      // Skipped entirely if the reader has previously released capture; the
      // toggle (or a re-toggle later this session) is what re-arms instead.
      this.hasPlayed = true;
      if (this.manifest) {
        emitNarrationPlay(this.postPath, this.lastPlayTrigger, this.manifest.duration);
      }
      // Reset to the default in case a future hypothetical reader of the
      // field (today there is none — the latch above is one-way) gets
      // accurate "no explicit intent" attribution.
      this.lastPlayTrigger = "button";
      if (this.captureControls) this.media.setupMediaSession();
    }
    this.playing = true;
    if (this.dock.highlightEnabled) this.narrationRoot.classList.add("narrating");
    this.startTicker();
    this.media.setPlaybackState("playing");
  }
  private onPause() {
    this.playing = false;
    this.stopTicker();
    // A pause clears any intent left over from a Space/MediaSession/chapter
    // path, so the next play attributes to "button" by default unless another
    // handler has set the trigger first. Only matters between page load and
    // the first-play latch firing — once `hasPlayed` is true, the field is dead.
    this.lastPlayTrigger = "button";
    this.media.setPlaybackState("paused");
  }
  private onEnded() {
    this.playing = false;
    this.stopTicker();
    this.narrationRoot.classList.remove("narrating");
    this.setActive(null);
    this.figures.releaseStagedFigure();
    this.media.setPlaybackState("none");
  }

  // Send a `narration_quartile` analytics beacon the first frame after the
  // player crosses each 25/50/75/100 % threshold of the master track. Same
  // tick that drives the highlight, so no new clock — the cost per frame is
  // a Set.has check after the first cross. Gated on `hasPlayed` so a
  // programmatic scrub-before-play (e.g. URL hash deep-link) can't emit a
  // phantom quartile before any play has happened. See methodology.md →
  // "Engagement analytics (Analytics Engine)".
  private maybeEmitQuartile(tMs: number): void {
    if (!this.hasPlayed || !this.manifest) return;
    if (this.firedQuartiles.size >= QUARTILES.length) return; // all done
    const duration = this.manifest.duration;
    if (duration <= 0) return;
    const pct = (tMs / duration) * 100;
    for (const q of QUARTILES) {
      if (pct >= q && !this.firedQuartiles.has(q)) {
        this.firedQuartiles.add(q);
        emitNarrationQuartile(this.postPath, q);
      }
    }
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
    this.strip.updateActiveChapter();
    this.dock.updateBar();
    const tMs = secondsToMs(asSeconds(this.player.currentTime));
    // Pure bisect — works for both linear playback AND backward seeks
    // because nothing is cached. See client/narratorTiming.ts.
    const active = computeActiveMark(this.manifest.marks, tMs);
    this.setActive(active ? active.name : null);
    this.drawer.updateActiveWord(active?.name ?? null, tMs);
    // Drive the staged figure off the SAME clock — keyed off the timeline's
    // figure pointer, independent of the `name` highlight above (47).
    this.figures.updateActiveFigure(tMs);
    this.maybeEmitQuartile(tMs);

    // Drive the lock-screen / Now-Playing scrubber off the same canonical
    // clock. Coalesced internally by the UA, so rAF-rate calls are fine. The
    // spec requires position <= duration and throws otherwise; the final frame
    // can drift a hair past duration, so clamp. Gated on `captureControls` so
    // the ticker doesn't silently re-acquire the OS session a frame after a
    // teardown — the other half of the chokepoint that `setPlaybackState`
    // guards.
    if (
      this.captureControls &&
      "mediaSession" in navigator &&
      navigator.mediaSession.setPositionState
    ) {
      const audio = (this.player as unknown as { audio?: HTMLAudioElement }).audio;
      const durationSec = msToSeconds(this.manifest.duration);
      navigator.mediaSession.setPositionState({
        duration: durationSec,
        position: Math.min(msToSeconds(tMs), durationSec),
        playbackRate: audio?.playbackRate ?? 1,
      });
    }
  }

  private setActive(id: string | null) {
    if (id === this.activeId) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The previous .narration-active removal is unconditional — it's a
    // no-op if the class isn't applied (which is the case while
    // highlighting is disabled), and we want it to actually take effect
    // immediately after re-enabling highlighting on a fresh active mark.
    if (this.activeId) {
      const prev = this.narrationRoot.querySelector(
        `#${CSS.escape(this.activeId)}`,
      );
      prev?.classList.remove("narration-active");
      this.drawer.segmentEls.get(this.activeId)?.classList.remove("narration-active");
    }
    if (id) {
      const el = this.narrationRoot.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        if (this.dock.highlightEnabled) {
          el.classList.add("narration-active");
          // Only auto-scroll while playing AND highlighting is enabled;
          // unsolicited scroll defeats the screenshot-friendly mode.
          if (this.playing) {
            el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
          }
        }
      } else {
        console.warn(`Narration mark "${id}" has no matching element`);
      }
      // The drawer segment mirrors the highlight regardless of
      // `highlightEnabled` — that flag is about the article's reading-clean
      // mode, not about the drawer (whose entire purpose is to surface the
      // spoken script). Scroll inside the drawer only when it's open AND
      // showing the script panel (a `hidden` panel has no boxes to scroll);
      // the drawer body's overflow-y keeps the page itself from scrolling.
      const seg = this.drawer.segmentEls.get(id);
      if (seg) {
        seg.classList.add("narration-active");
        if (this.drawer.drawerOpen && this.drawer.drawerPanel === "script") {
          seg.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        }
      }
    }
    this.activeId = id;
  }

  // Author-only, dev-only per-segment "regenerate audio" tool. Gated on BOTH:
  //   - localhost — the `/dev/regenerate` endpoint that shells out to the
  //     generate pipeline exists only on the dev Bun server, never the prod
  //     Worker (see server/dev/regenerate.dev.ts). On any other host the button
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
    for (const [markName, seg] of this.drawer.segmentEls) {
      // Marks the segment as carrying author tools so the controls row widens
      // to a third column for the name label (see narrator.css).
      seg.classList.add("has-dev-tools");
      this.addRegenButton(seg, markName);
      this.addSegmentName(seg, markName);
    }
  }

  // Author-only, dev-only segment-name label, gated identically to the regen
  // button (localhost + isAuthor). Surfaces the mark `name` — the id a segment
  // is keyed by — so the author can read straight off the drawer which segments
  // to feed a manual re-roll (`generate --force-mark=<name>`) without digging
  // through the post source. `user-select: all` (set in CSS) makes one click
  // select the whole id for a clean copy into that command.
  private addSegmentName(seg: HTMLElement, markName: string) {
    const label = document.createElement("button");
    label.type = "button";
    label.className = "spoken-name";
    label.textContent = markName;
    label.title = `Copy segment name (--force-mark=${markName})`;
    label.setAttribute("aria-label", `Copy segment name ${markName}`);
    // Click copies the bare mark name — the exact `--force-mark=<name>` token —
    // and flips the label to a "Copied" state briefly. A button (not the old
    // span) so it's keyboard-focusable and the gesture reads as "actionable".
    label.addEventListener("click", () => {
      void copyToClipboard(markName).then((ok) => {
        if (!ok) return;
        label.classList.add("is-copied");
        if (this.nameCopyTimer !== null) clearTimeout(this.nameCopyTimer);
        this.nameCopyTimer = window.setTimeout(() => {
          label.classList.remove("is-copied");
          this.nameCopyTimer = null;
        }, 1000);
      });
    });
    // Visual placement is by CSS grid (sits between the play chip and the regen
    // button), so DOM order only needs to keep it inside the segment. Insert
    // right after the play chip so reading order is play → name → regen.
    const play = seg.querySelector(".spoken-play");
    if (play?.nextSibling) seg.insertBefore(label, play.nextSibling);
    else seg.appendChild(label);
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

// Exported (not auto-run): the post's eager `<script>` is `narratorLoader.ts`,
// which `import()`s this module and calls `boot()` on reader engagement / idle,
// keeping Shikwasa off the critical FCP/TBT path. `pendingKey` carries the
// cold-start keyboard shortcut the loader captured (see narratorLoader.ts).
export function boot(pendingKey?: KeyboardEvent) {
  // Intentional opt-out: a post can declare `<article data-narration="none">`
  // to suppress narration entirely. We hide the dock (the markup can stay in
  // the post for template consistency) and never fetch a manifest, so there's
  // no empty player box and no "run bun run generate" nudge — that nudge is
  // reserved for posts that *do* want narration but haven't been built yet.
  // This is the runtime half of the same flag `generate.ts` honors; both must
  // key off an attribute that survives the served-HTML strip, since the
  // narration <script> blocks themselves are removed in production.
  const optOut = document.querySelector<HTMLElement>('[data-narration="none"]');
  if (optOut) {
    document
      .querySelector<HTMLElement>(".narrate-dock")
      ?.style.setProperty("display", "none");
    return;
  }

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
  ).init(pendingKey);
}
