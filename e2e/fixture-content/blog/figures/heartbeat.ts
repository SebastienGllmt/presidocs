// Starter animated figure for personal-blog. Content, not engine: it lives in
// this repo and is imported by posts/hello.html. It follows the engine's
// FigureJourney contract (see the figure-journey skill and
// presidocs/methodology.md → Animated figures):
//
//   - Progressive enhancement over a static SVG fallback (no-JS still renders).
//   - Registers a FigureJourney (two labeled beats) so the live narrator and
//     the offline video renderer drive the same animation — registration always
//     happens, even under prefers-reduced-motion (the consumer decides).
//   - Plays once on scroll-into-view for the silent reader, and replays when
//     the narration reaches the "figure" mark (the player toggles the
//     `narration-active` class). Both self-play paths stand down for good once
//     a driver claims the figure via reset() (the `driven` guard).
//   - The pulse is a pure transform (scale), so the figure's box height never
//     changes as it animates — no layout shift to reserve against.
//
// gsap is a dependency of THIS repo (declared in package.json), because it's
// used by content authored here — not pulled from the engine.

import { gsap } from "gsap";
import { registerFigureJourney, stepsFromLabels } from "../engine/client/figureAnimation.ts";

const figure = document.getElementById("figure");
const dot = figure?.querySelector<SVGCircleElement>(".heartbeat-static circle");

if (figure && dot) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // One finite, paused timeline = the journey. Two beats, each a labeled step,
  // built from plain `.to` tweens (nothing applies at build time, so frame 0
  // is the static fallback). All visual change lives on this timeline — no
  // detached tweens, no randomness — so a forward seek reproduces exactly
  // what live playback shows.
  const beat = (tl: gsap.core.Timeline): gsap.core.Timeline =>
    tl
      .to(dot, { scale: 1.35, duration: 0.35, ease: "power2.out" })
      .to(dot, { scale: 1, duration: 0.45, ease: "power2.inOut" });

  const tl = gsap.timeline({ paused: true });
  tl.addLabel("first-beat", 0);
  beat(tl);
  tl.addLabel("second-beat", tl.duration());
  beat(tl);

  // The `driven` guard (contract rule 7): once a driver — the narrator or the
  // video capture — claims the figure by calling reset(), the figure's own
  // triggers below must no-op so self-play can't race the driver's scrubbing.
  let driven = false;

  registerFigureJourney("figure", {
    durationMs: tl.duration() * 1000,
    steps: stepsFromLabels(tl.labels, tl.duration()),
    reset() {
      driven = true;
      tl.pause(0); // snap to frame 0; scale interpolates back to its explicit start value
    },
    seek(ms) {
      tl.time(ms / 1000);
    },
  });

  if (!reduce) {
    const play = () => {
      if (driven) return;
      tl.restart();
    };

    // Silent reader: play once when the figure scrolls into view.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          play();
          io.disconnect();
        }
      }
    }, { threshold: 0.5 });
    io.observe(figure);

    // Listener: replay when the narration reaches the "figure" mark (the
    // player adds `narration-active` to this element while that mark plays).
    const mo = new MutationObserver(() => {
      if (figure.classList.contains("narration-active")) play();
    });
    mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
  }
}
