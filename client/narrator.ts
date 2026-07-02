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
import { computeActiveMark, findActiveWord } from "./narratorTiming.ts";
import { emitNarrationPlay, emitNarrationQuartile } from "./analytics.ts";
import { copyToClipboard } from "./clipboard.ts";
import { QUARTILES, type PlayTrigger, type Quartile } from "../shared/analyticsSchema.ts";
import {
  SPOKEN_ID_PREFIX,
  spokenSegmentId,
  collectOutline,
  parseSpokenHash,
  loadCaptureControls,
} from "./narratorDom.ts";
import {
  DRAWER_BODY_WANTED_ATTR,
  REQUEST_DRAWER_BODY_EVENT,
  DRAWER_BODY_READY_EVENT,
} from "./drawerBodyContract.ts";
import { MediaSessionController } from "./narrator/mediaSession.ts";
import { NarratorKeyboard } from "./narrator/keyboard.ts";
import { FigureDriver } from "./narrator/figureDriver.ts";
import { ChapterStrip } from "./narrator/chapterStrip.ts";
import { DockControls } from "./narrator/dockControls.ts";
import { Speakers } from "./narrator/speakers.ts";

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
  type ManifestMark,
  type ManifestWord,
  type ManifestChapter,
} from "../shared/manifestSchema.ts";

// SPOKEN_ID_PREFIX / spokenSegmentId are imported from ./narratorDom.ts —
// re-export here so any in-file uses don't need to re-import.
// (Both are used by both the drawer DOM build and applyHashIfMatching.)

function formatClockTime(ms: Milliseconds) {
  const total = Math.max(0, Math.round(msToSeconds(ms)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Register the chapter plugin once for the lifetime of the page.
Player.use(Chapter);

// The two panels sharing the left-edge drawer. ONE drawer, two panels — they
// occupy the same space by construction, so "script and outline can't both be
// open" is an invariant of the DOM shape, not a rule two drawers coordinate on.
type DrawerPanel = "script" | "outline";

// Article scroll position counts as "inside" a section once the section's
// heading has risen to within this many px of the viewport top. Drives the
// outline panel's current-section highlight.
const OUTLINE_ACTIVE_OFFSET_PX = 120;

export class Narrator {
  readonly media = new MediaSessionController(this);
  readonly keys = new NarratorKeyboard(this);
  readonly figures = new FigureDriver(this);
  readonly strip = new ChapterStrip(this);
  readonly dock = new DockControls(this);
  readonly speakers = new Speakers(this);

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
  // Script-&-outline drawer + per-mark segment elements. One drawer element,
  // two panels (`drawerPanel` picks which body is shown); two edge tabs open
  // it straight to a panel, the header panel-tabs switch in place.
  private drawerEl: HTMLElement | null = null;
  private drawerTabBtn: HTMLButtonElement | null = null;
  private outlineTabBtn: HTMLButtonElement | null = null;
  private panelTabBtns = new Map<DrawerPanel, HTMLButtonElement>();
  private drawerPanel: DrawerPanel = "script";
  // Outline panel: lazily built like the script body (`ensureOutlineBody`).
  // `outlineEntries` pairs each rendered link with its article target so the
  // scroll-spy never re-queries the DOM per scroll frame.
  private outlineBodyEl: HTMLElement | null = null;
  private outlineBuilt = false;
  private outlineEntries: { link: HTMLAnchorElement; target: HTMLElement }[] = [];
  private outlineActiveLink: HTMLAnchorElement | null = null;
  // Scroll-spy listener is armed only while (drawer open ∧ panel = outline),
  // so a closed drawer costs nothing per scroll. rAF-coalesced.
  private outlineScrollArmed = false;
  private outlineSyncQueued = false;
  // The drawer body is built lazily off the boot path — see `ensureDrawerBody`
  // and the narrator↔comments contract in narratorDom.ts. `drawerBodyEl` is the
  // empty container appended with the shell; `drawerBodyBuilt` guards the
  // one-time populate.
  private drawerBodyEl: HTMLElement | null = null;
  private drawerBodyBuilt = false;
  private segmentEls = new Map<string, HTMLElement>();
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
  private drawerOpen = false;
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
    this.buildDrawer();
    this.speakers.setupDividerSpeakers();
    this.speakers.setupHeadingSpeakers();
    void this.maybeEnableAuthorTools();
    this.applyHashIfMatching();
    window.addEventListener("hashchange", () => this.applyHashIfMatching());

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
    this.updateActiveWord(active?.name ?? null, tMs);
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
      this.segmentEls.get(this.activeId)?.classList.remove("narration-active");
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
      const seg = this.segmentEls.get(id);
      if (seg) {
        seg.classList.add("narration-active");
        if (this.drawerOpen && this.drawerPanel === "script") {
          seg.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        }
      }
    }
    this.activeId = id;
  }

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
  private buildDrawer() {
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
    this.outlineBodyEl = outline;

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
    const manifest = this.manifest;
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
    if (this.activeId) {
      this.segmentEls.get(this.activeId)?.classList.add("narration-active");
      if (this.player) {
        this.updateActiveWord(
          this.activeId,
          secondsToMs(asSeconds(this.player.currentTime)),
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
      this.seekToMs(asMs(mark.time + 10));
      this.player?.play();
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
          this.seekToMs(asMs(w.t + 10));
          this.player?.play();
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
  private updateActiveWord(activeMarkName: string | null, tMs: Milliseconds) {
    if (!activeMarkName) {
      this.clearActiveWord();
      return;
    }
    const spans = this.wordEls.get(activeMarkName);
    if (!spans || spans.length === 0) {
      this.clearActiveWord();
      return;
    }
    const mark = this.manifest?.marks.find((m) => m.name === activeMarkName);
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
    this.armOutlineScrollSync();
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
    if (this.outlineBodyEl) this.outlineBodyEl.hidden = panel !== "outline";
    if (this.drawerOpen) {
      this.ensurePanelBody(panel);
      this.revealPanelPosition(panel);
    }
    this.armOutlineScrollSync();
  }

  private ensurePanelBody(panel: DrawerPanel) {
    if (panel === "script") this.ensureDrawerBody();
    else this.ensureOutlineBody();
  }

  // After opening (or switching panels while open), bring the panel's "you
  // are here" into view: the active narration segment (script) or the current
  // section (outline), so the reader doesn't have to hunt.
  private revealPanelPosition(panel: DrawerPanel) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let target: HTMLElement | null | undefined;
    if (panel === "script") {
      target = this.activeId ? this.segmentEls.get(this.activeId) : null;
    } else {
      this.syncOutlineActive();
      target = this.outlineActiveLink;
    }
    if (!target) return;
    // Defer past the open-transition's first frame so layout has settled
    // and `scrollIntoView` finds non-zero dimensions.
    requestAnimationFrame(() => {
      target?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    });
  }

  // Populate the deferred outline panel once from the ARTICLE's structure —
  // part dividers + h2/h3 headings (collectOutline in narratorDom.ts), NOT
  // the narration manifest: the outline is a reading tool, so it lists every
  // heading whether or not narration touches it. Tiny next to the script body
  // (tens of links, no per-word spans), but deferred the same way — same
  // pattern, and a reader who never opens it pays nothing.
  private ensureOutlineBody() {
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
    for (const entry of collectOutline(this.narrationRoot)) {
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

  private armOutlineScrollSync() {
    const want = this.drawerOpen && this.drawerPanel === "outline";
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
  private syncOutlineActive() {
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

  // If the page was loaded (or navigated to) with a URL fragment that points
  // at a spoken segment, open the drawer and bring that segment into view.
  // Plain `#elementId` fragments still scroll the article as the browser does
  // by default — we only intervene for our prefixed ids.
  private applyHashIfMatching() {
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
    for (const [markName, seg] of this.segmentEls) {
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
