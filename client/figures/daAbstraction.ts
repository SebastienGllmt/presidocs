// Interactive figure for posts/offer-files.html (Scaling, part 3): once there's
// an L2, the data-availability layer stops being a user/developer concern and
// becomes a swappable, sequencer-side implementation detail.
//
// The point the figure makes tactile: the TOP panel (what users & dApps see —
// "just sync the L2") never changes no matter which DA backend you click. The
// original proposal read Celestia directly (a namespace to scan + TIA to pay,
// ~6s blocks); behind an L2 that all disappears from the user's view.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

interface Backend { id: string; note: string }
const BACKENDS: Backend[] = [
  { id: "Celestia", note: "cheap namespaced blobspace — the original proposal's pick (≈6s blocks, pay in TIA)" },
  { id: "EigenDA", note: "high-throughput restaked DA on Ethereum" },
  { id: "Avail", note: "another modular DA layer — different fees, different token" },
  { id: "Midnight L1", note: "skip the extra system entirely — post the data to Midnight itself" },
];

const fig = document.getElementById("da-figure");
if (fig) initDa(fig);

function initDa(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "da-fig";
  stage.innerHTML = `
    <div class="da-user" data-user>
      <div class="da-cap">what users &amp; dApps see <span class="da-tag fixed">never changes &check;</span></div>
      <div class="da-user-body">Sync the <b>L2</b> directly &mdash; every offer &amp; fill, by construction. No namespace to scan, no foreign token to hold.</div>
    </div>
    <div class="da-pipe">&darr; <span>syncs</span></div>
    <div class="da-l2">L2 &mdash; sequencers</div>
    <div class="da-pipe">&darr; <span>DA under the hood</span></div>
    <div class="da-backends">
      <div class="da-cap">data-availability backend <span class="da-tag choice">sequencer's choice</span></div>
      <div class="da-chips" data-chips>
        ${BACKENDS.map((b, i) => `<button type="button" data-be="${i}"${i === 0 ? ' aria-pressed="true"' : ""}>${b.id}</button>`).join("")}
      </div>
      <div class="da-note" data-note></div>
    </div>
    <p class="da-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("da-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const chipBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-be]"));
  const note = q<HTMLElement>("[data-note]");
  const userPanel = q<HTMLElement>("[data-user]");
  const readout = q<HTMLElement>("[data-readout]");

  const READOUT =
    "Whichever backend the sequencers pick, the people using the DEX never see it &mdash; they just sync the L2. " +
    "Celestia's ~6s blocks and its TIA fees are gone from the user's view: <b>speed</b> is now the L2's own fast finality, " +
    "and the <b>DA token</b> is the sequencers' problem, not a dApp's.";

  function select(i: number, animate: boolean): void {
    chipBtns.forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
    note.innerHTML = `<b>${BACKENDS[i].id}</b> &mdash; ${BACKENDS[i].note}`;
    readout.innerHTML = READOUT;
    if (animate && !reduced) {
      gsap.fromTo(note, { opacity: 0.3, y: 4 }, { opacity: 1, y: 0, duration: 0.3, ease: "power1.out" });
      // flash the user panel's "unchanged" to show it stayed put
      gsap.fromTo(userPanel.querySelector(".fixed"), { backgroundColor: "#cdeeda" }, { backgroundColor: "rgba(0,0,0,0)", duration: 0.7, ease: "power1.out" });
    }
  }

  chipBtns.forEach((b) => b.addEventListener("click", () => select(Number(b.dataset.be), true)));
  select(0, false);

  function intro(): void {
    if (reduced) return;
    gsap.from(stage.querySelectorAll(".da-user, .da-l2, .da-backends"), { opacity: 0, y: 8, duration: 0.35, stagger: 0.1, ease: "power1.out" });
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
