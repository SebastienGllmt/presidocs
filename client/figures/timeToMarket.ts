// Interactive figure for posts/offer-files.html (Open question #3): how much to
// build, given a useful-but-unknown-length window.
//
// The zSwap L2 is worth building only until something general-purpose catches up
// — the Midnight L1 itself getting fast enough, or Nightstream (a full zkVM L2)
// maturing and gaining an L1 connection. Nobody knows when that is. So the
// figure is a timeline: a "build scope" slider pushes your SHIP date later, while
// the "window closes" band sits in an uncertain (fuzzy) region. Polish too long
// and you launch into the fog — the case for shipping lean and soon.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const fig = document.getElementById("ttm-figure");
if (fig) initTtm(fig);

function initTtm(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "ttm-fig";
  stage.innerHTML = `
    <div class="ttm-controls">
      <label>build scope <input type="range" data-scope min="0" max="100" value="22" aria-label="how much to build before launch" /> <b data-scope-label></b></label>
    </div>
    <div class="ttm-track">
      <span class="ttm-now">now</span>
      <span class="ttm-window">window closes? &mdash; L1 gets fast enough, or Nightstream matures <em>(timing unknown)</em></span>
      <span class="ttm-ship" data-ship><span class="ttm-rocket">🚀</span><span class="ttm-ship-label">you ship</span></span>
    </div>
    <p class="ttm-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("ttm-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const scope = q<HTMLInputElement>("[data-scope]");
  const scopeLabel = q<HTMLElement>("[data-scope-label]");
  const ship = q<HTMLElement>("[data-ship]");
  const readout = q<HTMLElement>("[data-readout]");

  function render(animate: boolean): void {
    const s = Number(scope.value);
    const shipPct = 6 + (s / 100) * 72; // 6% … 78% across the track
    if (animate && !reduced) gsap.to(ship, { left: shipPct + "%", duration: 0.3, ease: "power2.out" });
    else ship.style.left = shipPct + "%";

    scopeLabel.textContent = s <= 33 ? "lean MVP" : s <= 66 ? "polished build" : "perfect it";

    const state = shipPct < 40 ? "in" : shipPct < 55 ? "near" : "miss";
    figure.classList.toggle("ttm-in", state === "in");
    figure.classList.toggle("ttm-near", state === "near");
    figure.classList.toggle("ttm-miss", state === "miss");

    readout.innerHTML =
      state === "in"
        ? "Lean and early. You ship while the zSwap L2 is the fastest option around &mdash; capturing real users well before the L1 speeds up or Nightstream matures."
        : state === "near"
          ? "Cutting it close. Every extra month of polish pushes your launch toward the fog &mdash; where Midnight's L1, or Nightstream, might already be good enough."
          : "Too long. Chase perfection and you risk spending the <em>entire</em> (unknown-length) window building &mdash; and launching just as it closes, or after. The work ships into a world that no longer needs it.";
  }

  scope.addEventListener("input", () => render(true));
  render(false);

  function intro(): void {
    if (reduced) return;
    gsap.from(ship, { opacity: 0, y: -8, duration: 0.4, ease: "back.out(2)" });
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); intro(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) intro();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
