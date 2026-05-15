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

  constructor(
    private manifestUrl: string,
    private playerContainer: HTMLElement,
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
      fixed: { type: "fixed", position: "bottom" },
      themeColor: "#0969da",
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

    this.player.on("play", () => this.onPlay());
    this.player.on("pause", () => this.onPause());
    this.player.on("ended", () => this.onEnded());
    this.player.on("seeked", () => this.updateActive());
  }

  private onPlay() {
    this.playing = true;
    this.narrationRoot.classList.add("narrating");
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
    if (this.activeId) {
      const prev = this.narrationRoot.querySelector(
        `#${CSS.escape(this.activeId)}`,
      );
      prev?.classList.remove("narration-active");
    }
    if (id) {
      const el = this.narrationRoot.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        el.classList.add("narration-active");
        // Only auto-scroll while playing; while paused the user may be
        // reading freely and unsolicited scrolling is annoying.
        if (this.playing) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
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
  if (!root || !container) return;
  const manifestUrl = root.dataset.narrationSrc;
  if (!manifestUrl) return;
  new Narrator(
    manifestUrl,
    container,
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
