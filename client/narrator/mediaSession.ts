// methodology.md → Narrator — OS media-session integration: wires the lock
// screen / menu-bar / notification "now playing" surface and routes hardware
// media keys + headset taps into the same player calls the in-page dock uses.
// Also owns the single `playbackState` write chokepoint (`setPlaybackState`).

import type { Narrator } from "../narrator.ts";
import { asMs } from "../../shared/time.ts";

export class MediaSessionController {
  constructor(private readonly sys: Narrator) {}

  // Wire the OS-level "now playing" surfaces (lock screen, macOS menu-bar
  // widget + Control Center, Android/Chrome notification tile, Windows SMTC)
  // and route hardware/OS media controls (Bluetooth headset taps, keyboard
  // media keys) into the same player calls the in-page dock and keyboard
  // shortcuts already use. Entirely additive and feature-detected: a no-op on
  // browsers without `navigator.mediaSession`. No build/manifest changes — the
  // manifest already carries title/artist/duration/chapters.
  setupMediaSession() {
    if (!("mediaSession" in navigator) || !this.sys.manifest) return;
    const ms = navigator.mediaSession;

    ms.metadata = new MediaMetadata({
      title: this.sys.title,
      artist: this.sys.artist,
      // Site/publisher label; becomes the grouping line on the iOS lock screen.
      album: this.sys.artist,
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
      this.sys.lastPlayTrigger = "media-key";
      this.sys.player?.play();
    });
    safeSet("pause", () => this.sys.player?.pause());
    // No real "stop" concept for a single track; pause matches user intent.
    safeSet("stop", () => this.sys.player?.pause());
    safeSet("seekbackward", (d) => this.sys.skipBy(asMs(-((d.seekOffset ?? 10) * 1000))));
    safeSet("seekforward", (d) => this.sys.skipBy(asMs((d.seekOffset ?? 10) * 1000)));
    safeSet("seekto", (d) => {
      if (d.seekTime == null) return;
      this.sys.seekToMs(asMs(d.seekTime * 1000));
    });
    // On a chaptered talk the user's "track" is the LEAF chapter: one skip
    // gesture advances one spoken section. Deliberately FINER than the keyboard
    // 1-9 map (which jumps between top-level parts) — each input surface matched
    // to its idiom. No wraparound at the ends.
    safeSet("previoustrack", () => this.sys.jumpToChapterDelta(-1));
    safeSet("nexttrack", () => this.sys.jumpToChapterDelta(1));
  }

  // Exact inverse of setupMediaSession: null every action handler (so the
  // OS stops routing media keys / headset taps to this tab), drop the
  // metadata (so the OS "now playing" widget no longer shows the blog),
  // and set playbackState back to "none". Paired with the `captureControls`
  // gate on `setPlaybackState` and the rAF push so a running ticker can't
  // re-acquire the session a frame after we release it.
  teardownMediaSession() {
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

  // Set the OS "now playing" state explicitly rather than letting the UA infer
  // it from the <audio> element — the heuristic can disagree with reality after
  // a programmatic `currentTime` write (which seekToMs does), leaving the lock
  // screen showing Play while audio plays.
  //
  // The `captureControls` guard is load-bearing: this helper is the SINGLE
  // chokepoint for `playbackState` writes (called from onPlay/onPause/onEnded),
  // so gating it here means the next play after a teardown can't silently
  // re-acquire the session a frame later.
  setPlaybackState(state: MediaSessionPlaybackState) {
    if (!this.sys.captureControls) return;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
  }
}
