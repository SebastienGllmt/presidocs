// Starter animated figure for personal-blog. Content, not engine: it lives in
// this repo and is imported by posts/hello.html. It follows the engine's figure
// contract (documented in presidocs/methodology.md → Animated figures):
//
//   - Progressive enhancement over a static SVG fallback (no-JS still renders).
//   - Narration-synced with no new player API: the engine player toggles the
//     `narration-active` class on the element whose <mark> is playing, and the
//     figure id ("figure") matches the <mark name="figure"/> in the narration.
//   - Plays once on scroll-into-view for the silent reader.
//   - Honors prefers-reduced-motion.
//
// gsap is a dependency of THIS repo (declared in package.json), because it's
// used by content authored here — not pulled from the engine.

import { gsap } from "gsap";

const figure = document.getElementById("figure");
const dot = figure?.querySelector<SVGCircleElement>(".heartbeat-static circle");

if (figure && dot) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!reduce) {
    // A short pulse, paused until something asks it to play.
    const pulse = gsap.timeline({ paused: true })
      .to(dot, { scale: 1.35, duration: 0.35, ease: "power2.out" })
      .to(dot, { scale: 1, duration: 0.45, ease: "power2.inOut" });

    const play = () => pulse.restart();

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
