// Animated figure for posts/offer-files.html: the TEE is OFF the hot path.
//
// The topology is a BRANCH off the sequencer, not two independent lanes:
//   users → sequencer ─┬─→ order book / explorer        (instant; the hot path)
//                      └─→ indexer ──(now & then, a bundle)──→ 🔒 TEE → Midnight L1
// Offer files are transparent about the assets & amounts (only addresses are
// hidden), so the sequencer can order + publish to the explorer immediately with
// no enclave. It also feeds the indexer; and every so often the TEE pulls a
// bundle from the indexer, decrypts it with the viewing keys, proves it, and
// settles to the L1. The animation runs the hot path continuously while the
// prover bundle fires occasionally — so the dependency (sequencer → indexer →
// TEE) is visible, which is what the static "two lanes" version lacked.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM /
// SVG attributes only. Progressive enhancement over a static SVG;
// narration-synced; reduced-motion aware.
import { gsap } from "gsap";

const NS = "http://www.w3.org/2000/svg";

const fig = document.getElementById("hotpath-figure");
if (fig) initHotPath(fig);

function initHotPath(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "hp-fig";
  stage.innerHTML = `
    <svg class="hp-svg" viewBox="0 0 600 210" role="img" aria-label="Users send offer files to a sequencer, which publishes them to the order book / explorer instantly and also feeds an indexer. Every so often a bundle goes from the indexer into the TEE, which proves it and settles to the Midnight L1.">
      <defs><marker id="hp-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#bbb"/></marker></defs>
      <g font-family="system-ui, -apple-system, sans-serif" font-size="11" fill="#444">
        <!-- edges -->
        <line x1="104" y1="50" x2="136" y2="50" stroke="#bbb" marker-end="url(#hp-arr)"/>
        <line x1="266" y1="50" x2="326" y2="50" stroke="#5bb87a" stroke-width="1.5" marker-end="url(#hp-arr)"/>
        <text x="296" y="42" text-anchor="middle" font-size="9" fill="#2f7d4d">instant</text>
        <line x1="204" y1="68" x2="204" y2="146" stroke="#bbb" marker-end="url(#hp-arr)"/>
        <text x="212" y="112" font-size="9" fill="#999">feeds</text>
        <line x1="262" y1="166" x2="296" y2="166" stroke="#9a82d8" stroke-width="1.5" marker-end="url(#hp-arr)"/>
        <text x="279" y="140" text-anchor="middle" font-size="9" fill="#6a4fb0">now &amp; then,</text>
        <text x="279" y="150" text-anchor="middle" font-size="9" fill="#6a4fb0">a bundle</text>
        <line x1="470" y1="166" x2="498" y2="166" stroke="#9a82d8" stroke-width="1.5" marker-end="url(#hp-arr)"/>
        <text x="484" y="158" text-anchor="middle" font-size="9" fill="#6a4fb0">proof</text>
        <!-- nodes -->
        <rect x="18" y="34" width="86" height="32" rx="7" fill="#fff" stroke="#c8c8d4"/><text x="61" y="54" text-anchor="middle" font-weight="600">👤 user</text>
        <rect x="138" y="32" width="128" height="36" rx="7" fill="#fff" stroke="#c8c8d4"/><text x="202" y="48" text-anchor="middle" font-weight="600">sequencer</text><text x="202" y="61" text-anchor="middle" font-size="9" fill="#999">orders · no enclave</text>
        <rect x="328" y="30" width="212" height="40" rx="7" fill="#f5fbf7" stroke="#bfe3cd"/><text x="434" y="48" text-anchor="middle" font-weight="600" fill="#2f7d4d">order book / explorer</text><text x="434" y="61" text-anchor="middle" font-size="9" fill="#7aa98c">no TEE on this path</text>
        <rect x="150" y="148" width="112" height="36" rx="7" fill="#fff" stroke="#c8c8d4"/><text x="206" y="170" text-anchor="middle" font-weight="600">indexer</text>
        <rect x="298" y="144" width="172" height="44" rx="7" fill="#f3f0fb" stroke="#9a82d8" data-tee/><text x="384" y="162" text-anchor="middle" font-weight="600" fill="#4b3b8f">🔒 TEE</text><text x="384" y="176" text-anchor="middle" font-size="9" fill="#8a7bbf">decrypts w/ viewing keys · SNARK</text>
        <rect x="500" y="148" width="90" height="36" rx="7" fill="#fff" stroke="#c8c8d4"/><text x="545" y="170" text-anchor="middle" font-weight="600">Midnight L1</text>
        <!-- moving packets -->
        <circle data-dot-in r="5" fill="#3a9b5c" opacity="0"/>
        <circle data-dot-exp r="5" fill="#3a9b5c" opacity="0"/>
        <circle data-dot-idx r="5" fill="#7bbf96" opacity="0"/>
        <circle data-dot-bundle r="6" fill="#6a4fb0" opacity="0"/>
      </g>
    </svg>
    <div class="hp-controls">
      <button type="button" class="hp-replay" data-replay>&#9654; watch it run</button>
      <span class="hp-hint">the sequencer publishes to the explorer instantly &amp; feeds the indexer; the TEE pulls a bundle to prove only now and then</span>
    </div>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("hotpath-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const dotIn = q<SVGCircleElement>("[data-dot-in]");
  const dotExp = q<SVGCircleElement>("[data-dot-exp]");
  const dotIdx = q<SVGCircleElement>("[data-dot-idx]");
  const dotBundle = q<SVGCircleElement>("[data-dot-bundle]");
  const teeRect = q<SVGRectElement>("[data-tee]");
  const replay = q<HTMLButtonElement>("[data-replay]");

  let tl: gsap.core.Timeline | null = null;

  // Build the looping timeline once. Coordinates are fixed (SVG viewBox), so it
  // never needs rebuilding. `repeat: -1` makes the whole cycle loop forever; we
  // pause it while the figure is off-screen so it isn't burning a rAF in the
  // background.
  function build(): gsap.core.Timeline {
    gsap.set([dotIn, dotExp, dotIdx, dotBundle], { opacity: 0 });
    gsap.set(teeRect, { fill: "#f3f0fb" });
    const master = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });

    // Hot cycle: one packet arrives user → sequencer, then the sequencer forwards
    // it to BOTH the explorer and the indexer at the same instant (synced fork).
    const hot = gsap.timeline({ repeat: 2, repeatDelay: 0.3 });
    hot.set(dotIn, { attr: { cx: 61, cy: 50 }, opacity: 1 })
      .to(dotIn, { attr: { cx: 202 }, duration: 0.45, ease: "none" })
      .set(dotIn, { opacity: 0 })
      .set(dotExp, { attr: { cx: 266, cy: 50 }, opacity: 1 })
      .set(dotIdx, { attr: { cx: 204, cy: 68 }, opacity: 1 })
      .addLabel("fork")
      .to(dotExp, { attr: { cx: 434 }, duration: 0.5, ease: "none" }, "fork")
      .to(dotIdx, { attr: { cy: 150 }, duration: 0.5, ease: "none" }, "fork")
      .set([dotExp, dotIdx], { opacity: 0 }, "fork+=0.5");

    // Occasionally (once per loop): a bundle leaves the indexer → TEE (pulse) → L1.
    const bundle = gsap.timeline();
    bundle.set(dotBundle, { attr: { cx: 262, cy: 166 }, opacity: 1 })
      .to(dotBundle, { attr: { cx: 384 }, duration: 0.8, ease: "power1.in" })
      .to(teeRect, { fill: "#e0d4fb", duration: 0.25, yoyo: true, repeat: 1 }, "<0.2")
      .to(dotBundle, { attr: { cx: 545 }, duration: 0.9, ease: "power1.out" })
      .set(dotBundle, { opacity: 0 });

    master.add(hot, 0).add(bundle, 1.8);
    return master;
  }

  function start(): void {
    if (reduced) return;
    if (!tl) tl = build();
    tl.play();
  }

  replay.addEventListener("click", () => {
    if (reduced) return;
    if (!tl) tl = build();
    tl.restart();
  });

  // Loop while on-screen; pause when scrolled away (don't disconnect).
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? start() : tl?.pause();
  }, { threshold: 0.2 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) start();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
