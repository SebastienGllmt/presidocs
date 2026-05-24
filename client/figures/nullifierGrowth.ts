// Interactive figure for posts/offer-files.html (Open question #1): what a
// nullifier is, and why a nullifier-based L2 has a state-growth problem.
//
// Teaches the concept in UTXO terms (the post already assumes UTXOs): spending a
// UTXO publishes a NULLIFIER — a private, deterministic "this UTXO is spent"
// marker that reveals nothing about the UTXO. The ledger keeps the nullifier set
// (effectively the set of spent UTXOs) and rejects any it has already seen, so a
// UTXO can't be spent twice — privately. Crucially, nullifiers are NEVER removed:
// the set only grows. The reader spends UTXOs (watch the set grow), tries a
// double-spend (rejected, set unchanged), and drags an L2-throughput slider to
// see the set balloon over a year — the open question.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const HEX = "0123456789abcdef";
const randTag = () => "🔒 " + Array.from({ length: 4 }, () => HEX[(Math.random() * 16) | 0]).join("");
const MAX_CHIPS = 28;
const YEAR_S = 31_536_000;

const fmtBig = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} million` : Math.round(n).toLocaleString("en-US");

const fig = document.getElementById("nullifier-figure");
if (fig) initNullifier(fig);

function initNullifier(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stage = document.createElement("div");
  stage.className = "nf-fig";
  stage.innerHTML = `
    <div class="nf-coin">
      <span class="nf-coinface">🪙 a UTXO</span>
      <span class="nf-split">spend it &rarr;</span>
      <span class="nf-face null"><b>nullifier</b><small>a private &ldquo;this UTXO is spent&rdquo; marker &mdash; reveals nothing about the UTXO it tags</small></span>
    </div>
    <div class="nf-setbox">
      <div class="nf-set-cap">nullifier set &mdash; the set of <b>spent UTXOs</b>: <b data-count>0</b>, and it <b>only ever grows</b></div>
      <div class="nf-tags" data-tags></div>
    </div>
    <div class="nf-actions">
      <button type="button" data-act="spend">Spend a coin</button>
      <button type="button" data-act="double">Try to double-spend</button>
    </div>
    <div class="nf-growth">
      <label>L2 throughput <input type="range" data-tps min="1" max="500" value="50" aria-label="L2 throughput in swaps per second" /> <b data-tps-label></b></label>
      <div class="nf-proj">nullifiers after <b>one year</b>: <b data-proj></b> &mdash; none ever removed</div>
    </div>
    <p class="nf-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("nullifier-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const tags = q<HTMLElement>("[data-tags]");
  const countEl = q<HTMLElement>("[data-count]");
  const tps = q<HTMLInputElement>("[data-tps]");
  const tpsLabel = q<HTMLElement>("[data-tps-label]");
  const proj = q<HTMLElement>("[data-proj]");
  const readout = q<HTMLElement>("[data-readout]");

  let count = 0;
  const DEFAULT =
    "On a transparent UTXO chain you'd mark a spent output as spent. zSwap wants the same &mdash; a UTXO spent at most once &mdash; but without revealing <em>which</em> one. So spending a UTXO instead publishes its <b>nullifier</b>: a deterministic, private tag for that UTXO. The ledger keeps the set of nullifiers (effectively, the set of spent UTXOs) and rejects any it has already seen.";
  readout.innerHTML = DEFAULT;

  function spend(): void {
    count++;
    countEl.textContent = String(count);
    if (tags.childElementCount < MAX_CHIPS) {
      const chip = document.createElement("span");
      chip.className = "nf-tag";
      chip.textContent = randTag();
      tags.appendChild(chip);
      if (!reduced) gsap.from(chip, { opacity: 0, scale: 0.5, duration: 0.25, ease: "back.out(3)" });
    } else if (!tags.querySelector(".nf-more")) {
      const more = document.createElement("span");
      more.className = "nf-tag nf-more";
      more.textContent = "…";
      tags.appendChild(more);
    }
    readout.innerHTML = "Spent. The UTXO's <b>nullifier</b> joins the set &mdash; marking that UTXO spent, and it stays there <b>forever</b>.";
  }

  function doubleSpend(): void {
    // A rejected spend changes nothing, so the flash must be TRANSIENT: briefly
    // highlight a random existing nullifier (the one that's "already there"), then
    // clear the inline style so the pill snaps back to its normal CSS color — no
    // permanent change to the set.
    const btn = q<HTMLButtonElement>('[data-act="double"]');
    const pills = Array.from(tags.querySelectorAll<HTMLElement>(".nf-tag:not(.nf-more)"));
    if (!reduced) {
      gsap.fromTo(btn, { x: -4 }, { x: 0, duration: 0.45, ease: "elastic.out(1, 0.3)" });
      if (pills.length) {
        const pill = pills[(Math.random() * pills.length) | 0];
        gsap.fromTo(pill, { backgroundColor: "#fbdcdc" }, {
          backgroundColor: "#efeafb", duration: 0.8, ease: "power1.out",
          onComplete() { pill.style.backgroundColor = ""; }, // back to pure CSS — nothing left behind
        });
      }
    }
    readout.innerHTML = "Rejected &mdash; the same UTXO always produces the <b>same</b> nullifier, and it's already in the set (highlighted). Double-spend prevented, privately &mdash; and the set is <b>unchanged</b>.";
  }

  function updateProj(): void {
    const t = Number(tps.value);
    tpsLabel.textContent = `${t} swaps/sec`;
    proj.textContent = fmtBig(t * YEAR_S);
    figure.classList.toggle("nf-heavy", t * YEAR_S > 1e8);
  }

  q<HTMLButtonElement>('[data-act="spend"]').addEventListener("click", spend);
  q<HTMLButtonElement>('[data-act="double"]').addEventListener("click", doubleSpend);
  tps.addEventListener("input", updateProj);
  updateProj();

  function intro(): void {
    if (reduced || count > 0) return;
    spend(); gsap.delayedCall(0.3, spend); gsap.delayedCall(0.6, spend);
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
