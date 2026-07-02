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
import { computeActiveMark, findActiveWord, stagedFigureAt, figureSeekPlan } from "./narratorTiming.ts";
import { getFigureJourney, type FigureJourney } from "./figureAnimation.ts";
import { emitNarrationPlay, emitNarrationQuartile } from "./analytics.ts";
import { copyToClipboard } from "./clipboard.ts";
import { QUARTILES, type PlayTrigger, type Quartile } from "../shared/analyticsSchema.ts";
import {
  SPOKEN_ID_PREFIX,
  spokenSegmentId,
  collectOutline,
  firstMarkAfter,
  parseSpokenHash,
  loadCaptureControls,
  saveCaptureControls,
  topLevelChapterByNumber,
  shouldIgnoreKeyboardShortcut,
  KEY_BINDINGS,
  matchesKeyBinding,
  DRAWER_BODY_WANTED_ATTR,
  REQUEST_DRAWER_BODY_EVENT,
  DRAWER_BODY_READY_EVENT,
} from "./narratorDom.ts";

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

// Speaker-with-waves glyph, drawn in `currentColor` so it inherits whatever
// muted tone its host (a labeled divider or a heading) carries and the hover
// rule can brighten it. Shared by the two "play narration from here" buttons —
// the divider speaker (`.divider-speaker`) and the heading speaker
// (`.heading-speaker`) — so the icon can't drift between them. The intrinsic
// 14px size suits the divider; heading CSS overrides it to an em size so it
// scales with the heading it sits beside.
const SPEAKER_GLYPH_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 2.2 4.3 5.3H1.6v5.4h2.7L8 13.8z" fill="currentColor"/>' +
  '<path d="M10.6 5.4a3.3 3.3 0 0 1 0 5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  '<path d="M12.4 3.4a5.8 5.8 0 0 1 0 9.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
  "</svg>";

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

class Narrator {
  private manifest: Manifest | null = null;
  private player: InstanceType<typeof Player> | null = null;
  private activeId: string | null = null;
  private rafHandle = 0;
  private playing = false;
  // Active-highlight target per chapter id. For a top-level chapter this is the
  // pill (or its parent-segment inside a segmented pill); for a sub-chapter
  // either its own segment or — in the 1-child collapsed case — the parent's
  // flat pill, so the strip still lights up as audio crosses into the sub.
  private pillEls = new Map<string, HTMLElement>();
  // Last chapter we auto-scrolled the strip to. `updateActiveChapter` runs
  // every rAF tick, so we only scroll the active pill into view when the
  // active chapter actually changes — not on every frame.
  private lastActiveChapterId: string | null = null;
  // Timer that clears the transient "Copied" state on a dev-only segment-name
  // label after a click. One shared handle: only one label flashes at a time.
  private nameCopyTimer: number | null = null;
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
  // One-shot latch flipped on the user's first play, so
  // setupMediaSession() arms exactly once (idempotent in principle,
  // but no point re-running it). Defers OS "now playing" metadata +
  // action-handler registration until the reader has actually started
  // the talk — Chrome/Safari only make the tab the OS session target
  // on first <audio>.play() anyway, so this just aligns our
  // registration with the platform behaviour and keeps the lock
  // screen clean for talks that never start.
  private hasPlayed = false;
  // What the user did to start playback, captured by the most-recent
  // intent-bearing handler (Space, MediaSession `play`, chapter jump…)
  // and consumed once by the first-play latch in `onPlay` to attribute the
  // `narration_play` analytics event. Defaults to "button" because the
  // Shikwasa dock play-button has no hook of its own — anything not
  // explicitly attributed lands as the "in-dock click" case. Reset to
  // "button" on every pause so a Space-pause followed by a dock-click
  // doesn't carry the stale "space" attribution forward.
  private lastPlayTrigger: PlayTrigger = "button";
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
  private captureControls = true;
  private captureBtn: HTMLButtonElement | null = null;
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
  // Cached progress-bar element so the rAF ticker can update its width directly
  // (see comment on `updateBar` for why we drive the bar ourselves).
  private playedBarEl: HTMLElement | null = null;

  // ----- Narration figure driver (methodology.md → "Live figure driving") -----------------------------
  // The figure currently on the stage *and driven* by the narration clock,
  // resolved from the timeline's figure pointer (`resolveActiveFigure`), NOT
  // from the active mark's `name` (47 decoupled them). `null` = empty stage.
  private stagedFigureId: string | null = null;
  // The claimed journey for `stagedFigureId` (undefined-on-page figures and
  // figures with no registered journey leave this null — nothing to drive).
  private stagedJourney: FigureJourney | null = null;
  // Master-track time (ms) at which the current figure's span began (its
  // staging mark — `stagedFigureAt().sinceMs`, NOT the tick we noticed it). The
  // journey is advanced by `tMs - figureStagedAtMs`, so the figure rides the
  // audio clock, is frame-perfect on pause (clock frozen), and a scrub into the
  // middle of a span resumes the figure mid-animation rather than from frame 1.
  private figureStagedAtMs: Milliseconds = asMs(0);
  // Last journey position we seeked to. `figureSeekPlan` reads it to decide
  // forward-step vs. reset()+replay (a loop wrap or backward scrub); a fresh
  // claim sets it to +Infinity to force the reset-and-sweep-from-0.
  private figureLastSeekMs = 0;
  // Step ceiling for forward seeks (rule 3: advance no coarser than this so
  // every timeline `.call()` is crossed). Matches the capture/conformance fps.
  private static readonly FIGURE_STEP_MS = 1000 / 30;
  // §6 interactive detach: a click on the staged figure's own controls hands
  // control to the figure's handlers; the driver stops advancing it (holding
  // the reader's hand-set state). Re-attach happens when the figure is re-staged
  // (the claim path `reset()`s from a clean baseline). Tracked so we can detach
  // the listener when the stage changes.
  private figureDetached = false;
  private figureDetachEl: HTMLElement | null = null;
  private figureDetachHandler: ((e: Event) => void) | null = null;

  constructor(
    private manifestUrl: string,
    private playerContainer: HTMLElement,
    private chapterContainer: HTMLElement | null,
    private narrationRoot: HTMLElement,
    private title: string,
    private artist: string,
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
      this.revealDock();
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

    this.renderChapters(manifest);
    this.setupChapterStrip();
    this.setupVisibilityToggle();
    // Capture goes in BEFORE highlight: both `insertBefore(.shk-btn_more)`,
    // so the one that arrives last sits just left of `.shk-btn_more` (i.e.
    // rightmost interactive control). Keeping highlight rightmost preserves
    // the existing `padding-right: 44px` × collision fix in the 641-1000px
    // band — see methodology's Audio Player section.
    this.setupCaptureToggle();
    this.setupHighlightToggle();
    this.setupCloseButton();
    this.setupSmoothBar();
    this.setupKeyboardShortcuts();
    this.buildDrawer();
    this.setupDividerSpeakers();
    this.setupHeadingSpeakers();
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

    // Everything that determines the dock's height (player + chapter strip) is
    // now mounted, so reveal it. The build ships the dock `data-hidden="true"`
    // (shared/articleChromeReserve.ts → hideNarrateDockForReveal, applied by the
    // bunHtmlHeadPlugin in both dev and prod) so it never painted its empty box;
    // revealing it here slides it up via transform/opacity — neither of which
    // triggers layout shift — so the player costs zero CLS.
    this.revealDock();

    // Replay the cold-start key the loader captured (Space/1-9/arrow pressed
    // before Shikwasa finished loading) now that the player + manifest exist —
    // so a reader who started the talk cold isn't left having to press twice.
    if (pendingKey) this.handleKeyboardEvent(pendingKey);

    // Media Session arming deferred to `onPlay` — see `hasPlayed`. A
    // tab isn't the OS session target until audio actually plays
    // (Chrome/Safari), so pre-arming metadata + handlers would just
    // pollute the lock screen for a reader who never starts.
  }

  // Wire the OS-level "now playing" surfaces (lock screen, macOS menu-bar
  // widget + Control Center, Android/Chrome notification tile, Windows SMTC)
  // and route hardware/OS media controls (Bluetooth headset taps, keyboard
  // media keys) into the same player calls the in-page dock and keyboard
  // shortcuts already use. Entirely additive and feature-detected: a no-op on
  // browsers without `navigator.mediaSession`. No build/manifest changes — the
  // manifest already carries title/artist/duration/chapters.
  private setupMediaSession() {
    if (!("mediaSession" in navigator) || !this.manifest) return;
    const ms = navigator.mediaSession;

    ms.metadata = new MediaMetadata({
      title: this.title,
      artist: this.artist,
      // Site/publisher label; becomes the grouping line on the iOS lock screen.
      album: this.artist,
      artwork: [], // see methodology — no site cover art asset yet
    });

    // setActionHandler throws for actions a given UA doesn't support; swallow
    // per-action so one unsupported action doesn't block the rest (notably
    // previoustrack/nexttrack on Firefox/Linux without MPRIS).
    const safeSet = (
      action: MediaSessionAction,
      handler: ((d: MediaSessionActionDetails) => void) | null,
    ) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action — ignore */
      }
    };

    safeSet("play", () => {
      this.lastPlayTrigger = "media-key";
      this.player?.play();
    });
    safeSet("pause", () => this.player?.pause());
    // No real "stop" concept for a single track; pause matches user intent.
    safeSet("stop", () => this.player?.pause());
    safeSet("seekbackward", (d) => this.skipBy(asMs(-((d.seekOffset ?? 10) * 1000))));
    safeSet("seekforward", (d) => this.skipBy(asMs((d.seekOffset ?? 10) * 1000)));
    safeSet("seekto", (d) => {
      if (d.seekTime == null) return;
      this.seekToMs(asMs(d.seekTime * 1000));
    });
    // On a chaptered talk the user's "track" is the LEAF chapter: one skip
    // gesture advances one spoken section. Deliberately FINER than the keyboard
    // 1-9 map (which jumps between top-level parts) — each input surface matched
    // to its idiom. No wraparound at the ends.
    safeSet("previoustrack", () => this.jumpToChapterDelta(-1));
    safeSet("nexttrack", () => this.jumpToChapterDelta(1));
  }

  // Exact inverse of setupMediaSession: null every action handler (so the
  // OS stops routing media keys / headset taps to this tab), drop the
  // metadata (so the OS "now playing" widget no longer shows the blog),
  // and set playbackState back to "none". Paired with the `captureControls`
  // gate on `setPlaybackState` and the rAF push so a running ticker can't
  // re-acquire the session a frame after we release it.
  private teardownMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    for (
      const a of [
        "play",
        "pause",
        "stop",
        "seekbackward",
        "seekforward",
        "seekto",
        "previoustrack",
        "nexttrack",
      ] as MediaSessionAction[]
    ) {
      try {
        ms.setActionHandler(a, null);
      } catch {
        /* unsupported action — ignore, mirrors `safeSet` */
      }
    }
    ms.metadata = null;
    ms.playbackState = "none";
  }

  private jumpToChapter(chapter: ManifestChapter) {
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
  private jumpToChapterDelta(delta: -1 | 1) {
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

  // Reveal the dock once it's fully built (or on error, so the nudge shows).
  // Independent of the visibility toggle so the error path — which returns
  // before setupVisibilityToggle wires `toggleBtn` — can still reveal it. The
  // build ships the dock `data-hidden="true"` in both dev and prod; this clears
  // it. (A harmless no-op if some context served the dock un-hidden.)
  private revealDock() {
    const dock =
      this.dockEl ?? (this.playerContainer.closest(".narrate-dock") as HTMLElement | null);
    if (!dock) return;
    dock.dataset.hidden = "false";
    dock.setAttribute("aria-hidden", "false");
    this.toggleBtn?.setAttribute("aria-expanded", "true");
  }

  // Page-global keyboard shortcuts (Space / arrows / 1-9). Armed from
  // init, not gated on engagement — Space/1-9 are how a reader who
  // knows the shortcut starts the talk cold, mirroring the in-page
  // play button. Skipped while typing in a form field or with a
  // modifier held.
  //
  // The narrator now boots lazily (`client/narratorLoader.ts`), so the loader
  // *also* arms these keys from page load off the SAME `narratorDom` table and
  // hands the first one to `init(pendingKey)`, which replays it here once the
  // player exists (see `handleKeyboardEvent`). So the cold-start press still
  // controls playback even though Shikwasa hadn't loaded when the key was hit.
  private setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => this.handleKeyboardEvent(e));
  }

  // The per-event dispatch, shared by the live document listener and the
  // boot-time replay of the loader's captured cold-start key. Idempotent and
  // self-guarding: a no-op until the player + manifest are ready.
  private handleKeyboardEvent(e: KeyboardEvent) {
    if (!this.player || !this.manifest) return;
    // Modifier-and-focus filter lives in ./narratorDom.ts so the unit
    // tests can exercise it directly without spinning up the rest of
    // the narrator.
    if (shouldIgnoreKeyboardShortcut(e.target, e)) return;

    // Dispatch off the shared KEY_BINDINGS table (narratorDom.ts) — the same
    // declaration the build-time help page renders, so the bindings and their
    // documentation can't drift. Run the first matching binding and stop.
    for (const binding of KEY_BINDINGS) {
      if (!matchesKeyBinding(binding, e)) continue;
      switch (binding.id) {
        case "play-pause":
          // Override the default Space-activates-focused-button behavior so a
          // focused chapter pill or the visibility toggle doesn't intercept
          // playback control. Buttons remain activatable via Enter.
          e.preventDefault();
          this.lastPlayTrigger = "space";
          this.player.toggle();
          return;
        case "skip-back":
          e.preventDefault();
          this.skipBy(asMs(-10_000));
          return;
        case "skip-forward":
          e.preventDefault();
          this.skipBy(asMs(10_000));
          return;
        case "jump-chapter": {
          // 1-9 index the TOP-LEVEL chapters (parts + flat chapters),
          // matching the number shown on the level-1 pills. Sub-chapters are
          // reached by click or MediaSession next-track, not by number.
          // Resolution (including the >9 truncation rule, and declining when
          // there's no Nth chapter) lives in topLevelChapterByNumber — so a
          // digit with no matching chapter falls through doing nothing, as
          // before.
          const chapter = topLevelChapterByNumber(this.manifest.chapters, e.key);
          if (chapter) {
            e.preventDefault();
            this.jumpToChapter(chapter);
          }
          return;
        }
      }
    }
  }

  // Injects a toggle inside Shikwasa's basic controls row that releases
  // (or re-acquires) the OS media-session surface — lock screen, hardware
  // media keys, Bluetooth-headset taps. When OFF the metadata, action
  // handlers, and rAF position-state pushes are all torn down; when ON
  // the surface is armed exactly as it is by default after first play.
  // Persisted globally in localStorage (`narrate-capture-controls`), so
  // the choice carries between posts — the pref is about the reader's
  // relationship to their own music, not about any one talk.
  private setupCaptureToggle() {
    const basic = this.playerContainer.querySelector(".shk-controls_basic");
    if (!basic) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shk-btn narrate-capture-btn";
    btn.setAttribute("aria-label", "Toggle media key capture");
    btn.setAttribute("aria-pressed", String(this.captureControls));
    btn.title = this.captureControls
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
      this.setCaptureControls(!this.captureControls);
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

  // Inject a close × in the top-right corner of the player card —
  // always visible. The Listen pill (`setupVisibilityToggle`) is the
  // re-open partner and is hidden while the dock is open, so × and
  // pill never coexist on screen. Two side effects of always-on ×:
  // it avoids a second on-screen headphones glyph competing with the
  // capture toggle, and the corner-clearing `padding-right` rule on
  // `.shk-player` now applies across the whole horizontal-layout band
  // (see narrator.css's `@media (min-width: 641px)`), not just the
  // 641-1000px slice it covered when × was viewport-conditional.
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

  private setCaptureControls(enabled: boolean) {
    this.captureControls = enabled;
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
      if (this.hasPlayed) this.setupMediaSession();
    } else {
      this.teardownMediaSession();
    }
    if (typeof localStorage !== "undefined") {
      // Persist via the pure helper (handles "absent ⇒ ON" by removing
      // the key, and swallows storage-disabled throws).
      saveCaptureControls(localStorage, enabled);
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

  // Renders the single-row chapter strip. With the two-level hierarchy we
  // render ONE pill per top-level chapter; its sub-chapters
  // become slash-separated SEGMENTS inside that pill, so the grouping travels
  // with the pill instead of relying on a separate side-label that gets lost
  // on scroll. The pill NUMBER (1-9 keyboard shortcut) labels the top-level
  // index, in lockstep with the keyboard map. Two collapse cases keep the
  // strip clean: a leaf top-level chapter renders as a flat numbered pill (the
  // single-level shape, byte-for-byte for a flat post); a part with exactly
  // one sub also renders as a flat pill — the sub is still reachable by
  // scrubbing, and its active-state highlight is routed to the parent pill so
  // the strip keeps showing "where am I" correctly.
  private renderChapters(manifest: Manifest) {
    if (!this.chapterContainer) return;
    this.chapterContainer.innerHTML = "";
    this.pillEls.clear();

    // Walk the manifest once and group children under their top-level parent.
    // Manifest order is document order and the build enforces parent-before-
    // child, so a single forward pass suffices.
    type Group = { parent: ManifestChapter; children: ManifestChapter[] };
    const groups: Group[] = [];
    const groupById = new Map<string, Group>();
    for (const c of manifest.chapters) {
      if (c.parentId === undefined) {
        const g: Group = { parent: c, children: [] };
        groups.push(g);
        groupById.set(c.id, g);
        continue;
      }
      const g = groupById.get(c.parentId);
      if (g) g.children.push(c);
      else {
        // Defensive: a child whose parent we never saw. The build-time
        // normalizer should have already promoted this to top-level — render
        // it as its own pill rather than dropping it on the floor.
        const g2: Group = { parent: c, children: [] };
        groups.push(g2);
        groupById.set(c.id, g2);
      }
    }

    groups.forEach((group, i) => {
      const partIndex = i + 1; // top-level index — drives the 1-9 keyboard map
      const pill =
        group.children.length >= 2
          ? this.makeSegmentedPill(group, partIndex)
          : this.makeFlatPill(group, partIndex);
      this.chapterContainer!.appendChild(pill);
    });

    this.lastActiveChapterId = null;
    this.updateChapterFades();
    this.updateActiveChapter();
  }

  // Numbered flat pill — used both for leaf top-level chapters and for the
  // 1-sub collapse case. The sub (if any) registers against the same DOM
  // element so its active-state highlight rides the parent pill.
  private makeFlatPill(
    group: { parent: ManifestChapter; children: ManifestChapter[] },
    partIndex: number,
  ): HTMLButtonElement {
    const { parent, children } = group;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chapter-pill";
    btn.dataset.chapterId = parent.id;
    btn.setAttribute("aria-label", `Jump to chapter ${partIndex}: ${parent.title}`);
    btn.innerHTML = `<span class="ch-num">${partIndex}</span><span class="ch-title"></span>`;
    btn.querySelector(".ch-title")!.textContent = parent.title;
    btn.addEventListener("click", () => this.jumpToChapter(parent));
    this.pillEls.set(parent.id, btn);
    for (const child of children) this.pillEls.set(child.id, btn);
    return btn;
  }

  // Segmented pill — `[ N  «Part» Member A / Member B / … ]`. The part is opened
  // by its section-intro chapter (the parent): the spoken transition whose first
  // mark anchors the divider. Its title is the part name, rendered as the
  // emphasized `«Part»` group label; the member chapters render as the inert
  // segments. The pill is one `<button>` (a single keyboard Tab stop), and click
  // routing is strict containment: a jump fires only when the click lands on a
  // member segment or the group label — the slashes, the number badge, and the
  // padding around it are predictable no-ops. Strict containment beats routing a
  // dead-zone click to the nearest segment by distance, which would let a click
  // on a segment's tail jump to its neighbor.
  private makeSegmentedPill(
    group: { parent: ManifestChapter; children: ManifestChapter[] },
    partIndex: number,
  ): HTMLButtonElement {
    const { parent, children } = group;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chapter-pill segmented";
    pill.setAttribute(
      "aria-label",
      `Chapter ${partIndex}: ${[parent, ...children]
        .map((c) => c.title)
        .join(", ")}`,
    );

    const num = document.createElement("span");
    num.className = "ch-num";
    num.textContent = String(partIndex);
    pill.appendChild(num);

    // The group label IS the section-intro chapter (the parent): clicking it
    // plays that intro — the first thing in the part — and its active highlight
    // rides the label, so the strip lights up while the transition plays.
    const gl = document.createElement("span");
    gl.className = "ch-group";
    gl.textContent = parent.title;
    this.pillEls.set(parent.id, gl);
    pill.appendChild(gl);

    // Segment span → chapter, so the click handler can resolve which span was
    // hit without round-tripping through dataset attributes. Slash separators
    // sit *between* members only — the first member follows the group label
    // directly (the label's own spacing sets it apart).
    const byEl = new Map<HTMLSpanElement, ManifestChapter>();
    children.forEach((child, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "ch-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "/";
        pill.appendChild(sep);
      }
      const seg = document.createElement("span");
      seg.className = "ch-seg";
      seg.dataset.sub = "";
      seg.dataset.chapterId = child.id;
      seg.textContent = child.title;
      this.pillEls.set(child.id, seg);
      byEl.set(seg, child);
      pill.appendChild(seg);
    });

    pill.addEventListener("click", (e) => {
      // Keyboard activation (Enter/Space) has no pointer target — jump to the
      // part's intro, the sensible default for the one-Tab-stop pill.
      if (e.detail === 0) {
        this.jumpToChapter(parent);
        return;
      }
      const target = e.target as HTMLElement | null;
      // The group label plays the section intro (the first thing in the part).
      if (target?.closest(".ch-group")) {
        this.jumpToChapter(parent);
        return;
      }
      const segEl = target?.closest(".ch-seg") as HTMLSpanElement | null;
      const hit = segEl ? byEl.get(segEl) : null;
      if (hit) this.jumpToChapter(hit);
      // No-op when the click missed every segment (slash, padding, badge).
    });

    return pill;
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

  // A labeled section divider (`.section-divider-labeled`) acts as a prose
  // chapter boundary that, by convention, mirrors a narration part — its text
  // is the same string as the part's chapter-strip pill. Progressively enhance
  // each one with a speaker button that jumps the narration to the first spoken
  // segment about content *below* the divider. Because narration is non-linear
  // (a segment can reference an earlier or later section than where it sits),
  // "first" is defined off the highlighted element's DOM position, not the
  // chapter the segment belongs to: the earliest mark, in narration time, whose
  // highlighted element follows the divider in document order. A divider with no
  // following narration (e.g. a trailing one) gets no button.
  private setupDividerSpeakers() {
    if (!this.manifest) return;
    const dividers = this.narrationRoot.querySelectorAll<HTMLElement>(
      ".section-divider-labeled",
    );
    for (const divider of dividers) {
      if (divider.querySelector(".divider-speaker")) continue; // idempotent
      if (!this.firstMarkAfter(divider)) continue; // no narration below → no button
      const label = (divider.textContent ?? "").trim();
      // The divider is a presentational labeled `<div>` — the prose face of a
      // narration part, deliberately NOT a heading (the prose outline must not
      // depend on whether a post has narration; see methodology) and NOT a
      // `role="separator"` (a widget role can't host a control). A plain `<div>`
      // isn't a widget role, so it validly hosts this button; the button's own
      // aria-label ("Play narration from …") carries the part name to AT.
      divider.appendChild(this.buildSpeakerButton("divider-speaker", divider, label));
    }
  }

  // The article's headings (`<h2>`/`<h3>`/`<h4>`, matching headerLinks.ts) get
  // the same "play narration from here" affordance the labeled dividers carry —
  // a speaker button to the heading's right that seeks to the first narration
  // covering content at or below the heading, then plays. Headings aren't
  // guaranteed to be a narration entry point (only part dividers anchor a mark
  // by convention), but `firstMarkAfter` is defined for any element, so a
  // heading with no `<mark>` of its own simply routes to the first spoken
  // segment that follows it in document order. A heading with nothing narrated
  // below it (e.g. a trailing one) gets no button. Mirrors setupDividerSpeakers.
  private setupHeadingSpeakers() {
    if (!this.manifest) return;
    const headings = this.narrationRoot.querySelectorAll<HTMLElement>(
      "h2, h3, h4",
    );
    for (const heading of headings) {
      if (heading.querySelector(".heading-speaker")) continue; // idempotent
      if (!this.firstMarkAfter(heading)) continue; // no narration below → no button
      const label = (heading.textContent ?? "").trim();
      heading.appendChild(this.buildSpeakerButton("heading-speaker", heading, label));
    }
  }

  // Build a "play narration from here" speaker button anchored to `target`.
  // Both the divider and heading speakers share this so the glyph, labelling,
  // and seek behaviour can't drift between them. `firstMarkAfter` is recomputed
  // on every click (not cached at setup) so the target stays correct if the
  // article DOM changes after enhancement — e.g. a figure enhancing
  // asynchronously, shifting which mark element is "first below".
  private buildSpeakerButton(
    className: string,
    target: Element,
    label: string,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = "Play narration from here";
    btn.setAttribute(
      "aria-label",
      label ? `Play narration from "${label}"` : "Play narration from here",
    );
    btn.innerHTML = SPEAKER_GLYPH_SVG;
    btn.addEventListener("click", () => {
      const m = this.firstMarkAfter(target);
      if (!m) return;
      // Nudge past the mark time, matching the chapter-jump offset, so a mark
      // sitting exactly on a chapter boundary still lands inside the new chapter
      // for the chapter plugin's `t >= startTime` range check.
      this.seekToMs(asMs(m.time + 10));
      this.player?.play();
    });
    return btn;
  }

  // Thin wrapper around the pure helper in ./narratorDom.ts — keeps the
  // `this.firstMarkAfter(el)` call sites (dividers and headings) readable.
  private firstMarkAfter(el: Element): ManifestMark | null {
    if (!this.manifest) return null;
    return firstMarkAfter(el, this.manifest.marks, this.narrationRoot);
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

  // Set the OS "now playing" state explicitly rather than letting the UA infer
  // it from the <audio> element — the heuristic can disagree with reality after
  // a programmatic `currentTime` write (which seekToMs does), leaving the lock
  // screen showing Play while audio plays.
  //
  // The `captureControls` guard is load-bearing: this helper is the SINGLE
  // chokepoint for `playbackState` writes (called from onPlay/onPause/onEnded),
  // so gating it here means the next play after a teardown can't silently
  // re-acquire the session a frame later.
  private setPlaybackState(state: MediaSessionPlaybackState) {
    if (!this.captureControls) return;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
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
      if (this.captureControls) this.setupMediaSession();
    }
    this.playing = true;
    if (this.highlightEnabled) this.narrationRoot.classList.add("narrating");
    this.startTicker();
    this.setPlaybackState("playing");
  }
  private onPause() {
    this.playing = false;
    this.stopTicker();
    // A pause clears any intent left over from a Space/MediaSession/chapter
    // path, so the next play attributes to "button" by default unless another
    // handler has set the trigger first. Only matters between page load and
    // the first-play latch firing — once `hasPlayed` is true, the field is dead.
    this.lastPlayTrigger = "button";
    this.setPlaybackState("paused");
  }
  private onEnded() {
    this.playing = false;
    this.stopTicker();
    this.narrationRoot.classList.remove("narrating");
    this.setActive(null);
    this.releaseStagedFigure();
    this.setPlaybackState("none");
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
    this.updateActiveChapter();
    this.updateBar();
    const tMs = secondsToMs(asSeconds(this.player.currentTime));
    // Pure bisect — works for both linear playback AND backward seeks
    // because nothing is cached. See shared/narratorTiming.ts.
    const active = computeActiveMark(this.manifest.marks, tMs);
    this.setActive(active ? active.name : null);
    this.updateActiveWord(active?.name ?? null, tMs);
    // Drive the staged figure off the SAME clock — keyed off the timeline's
    // figure pointer, independent of the `name` highlight above (47).
    this.updateActiveFigure(tMs);
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
        if (this.highlightEnabled) {
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

  // The narration figure driver (methodology.md → "Live figure driving"). Runs every rAF tick from
  // `updateActive`. Resolves which figure the timeline stages at `tMs` (the
  // `figure` pointer, NOT the `name` highlight) and, when it has a registered
  // journey, owns that journey's clock: claim on stage-on (`reset()`, which
  // trips the figure's `driven` guard so its own scroll/narration self-play
  // stands down), advance by forward seek from the audio clock, loop if the
  // staged span outlasts one play-through, release on stage-off. Pause is
  // implicit: the ticker stops when audio pauses, so the figure holds its frame.
  private updateActiveFigure(tMs: Milliseconds) {
    if (!this.manifest) return;
    // Reduced motion (rule 5): no real-time animation. The narration driver
    // stands down entirely so it never `reset()`s a figure to frame 1 and then
    // freezes it; each figure's own triggers render its settled state instead.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (this.stagedFigureId !== null || this.stagedJourney) this.releaseStagedFigure();
      return;
    }

    const { id: stagedId, sinceMs, step } = stagedFigureAt(this.manifest.marks, tMs);
    if (stagedId !== this.stagedFigureId) {
      // Stage changed: release the previous journey, then claim the new one.
      this.releaseStagedFigure();
      this.stagedFigureId = stagedId;
      const journey = stagedId ? getFigureJourney(stagedId) : undefined;
      if (stagedId && journey) {
        this.stagedJourney = journey;
        this.figureStagedAtMs = sinceMs ?? tMs; // span start, for mid-span resume
        this.attachFigureDetachListener(stagedId);
        // Force a reset()+forward-sweep from frame 0 to the current target
        // (claiming the figure stands its self-play down via `driven`). In
        // stepped mode the target is the step's endMs; in continuous mode it's
        // the offset into the span. +Infinity never equals a finite target, so
        // the claim always resets and sweeps regardless of mode.
        this.figureLastSeekMs = Number.POSITIVE_INFINITY;
        this.advanceStagedFigure(tMs, step);
      }
      return;
    }

    // Same figure still staged — advance it from the audio clock (or hold at
    // its step, in stepped mode).
    if (!this.stagedJourney || this.figureDetached) return; // empty stage / no journey / reader took over
    this.advanceStagedFigure(tMs, step);
  }

  // Advance the staged journey for this tick, in one of two modes (methodology.md → "Live figure driving")
  // chosen by whether the active mark carries a `step` cue for the staged
  // figure:
  //   - Stepped (step != null): target = `steps[label].endMs` — play *through*
  //     the labeled segment and HOLD on its final frame (no loop). A missing
  //     label degrades gracefully (warn + hold the current frame). An early-out
  //     skips re-seeking when the target hasn't moved (a still-active step).
  //   - Continuous (step == null): free-run by the audio clock, looping while
  //     the staged span outlasts one play-through (`elapsed % durationMs`).
  // Both apply the forward-only seek plan (small steps; reset()+replay on a wrap
  // or a backward scrub) — see `figureSeekPlan`.
  private advanceStagedFigure(tMs: Milliseconds, step: string | null) {
    const journey = this.stagedJourney;
    if (!journey) return;
    const dur = journey.durationMs;
    if (dur <= 0) return;

    let target: number;
    if (step !== null) {
      // Stepped mode: drive to the labeled step's endMs and hold.
      const found = journey.steps.find((s) => s.label === step);
      if (!found) {
        // Author typo / renamed label: don't throw and don't free-run — hold
        // the current frame so a missing label degrades gracefully (§4.2).
        console.warn(
          `Narration step "${step}" not found in figure "${this.stagedFigureId}" journey — holding current frame`,
        );
        return;
      }
      target = found.endMs;
      // Idempotent hold: the same step still active → target unchanged → skip
      // the (no-op) re-seek (§4.3). +Infinity (a fresh claim) never matches.
      if (target === this.figureLastSeekMs) return;
    } else {
      // Continuous mode (methodology.md → "Live figure driving"): free-run + loop by the audio clock.
      const elapsed = Math.max(0, tMs - this.figureStagedAtMs);
      target = elapsed % dur;
    }

    const plan = figureSeekPlan(this.figureLastSeekMs, target, Narrator.FIGURE_STEP_MS);
    if (plan.reset) journey.reset();
    for (const p of plan.seeks) journey.seek(p);
    this.figureLastSeekMs = target;
  }

  // Release the currently-staged journey: drop the detach listener and forget
  // the journey. The figure HOLDS its last frame (we don't re-`reset()` it) —
  // an empty stage on the live page just means "stop driving," and the figure
  // stays in the DOM showing where it was left.
  private releaseStagedFigure() {
    this.detachFigureDetachListener();
    this.stagedFigureId = null;
    this.stagedJourney = null;
    this.figureDetached = false;
    this.figureLastSeekMs = 0;
  }

  // §6: clicking a control inside the staged figure detaches the driver so the
  // figure's own handlers own its state (the driver stops seeking it). The
  // trigger is a concrete event set — a click landing on an interactive control
  // (button/tab/input/link), not hover or scroll.
  private attachFigureDetachListener(figureId: string) {
    const el = document.getElementById(figureId);
    if (!el) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, [role='tab'], input, select, a")) {
        this.figureDetached = true;
      }
    };
    el.addEventListener("click", handler);
    this.figureDetachEl = el;
    this.figureDetachHandler = handler;
  }

  private detachFigureDetachListener() {
    if (this.figureDetachEl && this.figureDetachHandler) {
      this.figureDetachEl.removeEventListener("click", this.figureDetachHandler);
    }
    this.figureDetachEl = null;
    this.figureDetachHandler = null;
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
    // Pure bisect — see shared/narratorTiming.ts. Returns -1 before the
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
