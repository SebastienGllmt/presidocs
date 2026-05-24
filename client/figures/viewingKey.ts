// Interactive figure for posts/offer-files.html: why cryptographic integrity is
// hard for a *private* L2, and why the naive viewing-key approach doesn't scale.
//
// The grid is the L2's swap history — every cell an opaque commitment that even
// the sequencer can't attribute to an owner (that's zSwap's privacy). Only the
// reader's VIEWING KEY can reveal which handful of swaps were theirs. But to
// *prove* a withdrawal balance to the L1, a user must account for EVERY swap
// (proving the ones that aren't theirs really aren't) — a circuit over the whole
// history. A throughput slider shows how fast that blows past any user-feasible
// budget. This sets up the (next-chapter) clever solution.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

const CELLS = 120;
const MINE = [13, 27, 58, 79, 103]; // which sample cells are "yours"
const MINE_DELTA: Record<number, string> = { 13: "+4", 27: "−2", 58: "+1", 79: "+3", 103: "−2" };
const USER_BUDGET = 20_000; // statements a user could plausibly prove — generous

const fig = document.getElementById("viewingkey-figure");
if (fig) initViewingKey(fig);

function initViewingKey(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mine = new Set(MINE);

  const fmtBig = (n: number) => n.toLocaleString("en-US");
  const fmtDur = (sec: number) =>
    sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;

  const stage = document.createElement("div");
  stage.className = "vk-fig";
  stage.innerHTML = `
    <div class="vk-controls">
      <label>L2 throughput
        <input type="range" data-rate min="1" max="50" value="10" step="1" aria-label="L2 throughput in swaps per second" />
        <b data-rate-label>10 swaps/sec</b>
      </label>
      <button type="button" data-act="prove">Prove my balance</button>
    </div>
    <div class="vk-grid" data-grid></div>
    <div class="vk-stats">
      <span class="stat">swaps in a day at this rate <b data-perday>—</b></span>
      <span class="stat mine">actually yours <b>5</b></span>
      <span class="stat cover">your proof must cover <b data-cover>all of them</b></span>
    </div>
    <div class="vk-meter">
      <div class="vk-bar"><span class="fill" data-fill></span><span class="budget" data-budget></span></div>
      <div class="vk-meter-label" data-meter>—</div>
    </div>
    <p class="vk-readout" data-readout>This grid is the L2's swap history. Every cell is an opaque commitment &mdash; even the sequencer can't tell whose it is. That's the privacy zSwap gives you.</p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("vk-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const grid = q<HTMLElement>("[data-grid]");
  const rate = q<HTMLInputElement>("[data-rate]");
  const rateLabel = q<HTMLElement>("[data-rate-label]");
  const perdayEl = q<HTMLElement>("[data-perday]");
  const coverEl = q<HTMLElement>("[data-cover]");
  const fillEl = q<HTMLElement>("[data-fill]");
  const budgetEl = q<HTMLElement>("[data-budget]");
  const meterEl = q<HTMLElement>("[data-meter]");
  const readout = q<HTMLElement>("[data-readout]");

  const cellEls: HTMLElement[] = [];
  for (let i = 0; i < CELLS; i++) {
    const c = document.createElement("div");
    c.className = "vk-cell";
    c.textContent = "▦";
    grid.appendChild(c);
    cellEls.push(c);
  }

  let revealed = false;

  function reveal(): void {
    revealed = true;
    cellEls.forEach((c, i) => {
      if (mine.has(i)) { c.classList.add("mine"); c.textContent = MINE_DELTA[i]; }
      else { c.classList.add("notmine"); c.textContent = "?"; }
    });
    readout.innerHTML = "Your <b>viewing key</b> is the one thing that can tell which swaps touched you &mdash; here, just 5 of them. Nobody else can: not other users, and crucially <b>not the sequencer</b>. So no one can simply attest your balance.";
  }

  function updateRate(): void {
    const r = Number(rate.value);
    rateLabel.textContent = `${r} swaps/sec`;
    const perDay = r * 86400;
    perdayEl.textContent = fmtBig(perDay);
    coverEl.textContent = `${fmtBig(perDay)}/day`;
    // Meter: how much L2 history a user could prove before exhausting their budget.
    const provableSec = USER_BUDGET / r;
    const frac = Math.min(1, USER_BUDGET / perDay); // budget as a fraction of one day
    fillEl.style.width = `${Math.max(2, frac * 100)}%`;
    budgetEl.style.left = `${Math.min(98, frac * 100)}%`;
    meterEl.innerHTML = `A user can realistically prove ~<b>${fmtBig(USER_BUDGET)}</b> swaps &mdash; about the <b>last ${fmtDur(provableSec)}</b> of history. The L2 runs forever. <b class="bad">Infeasible.</b>`;
  }

  function prove(): void {
    if (!revealed) reveal();
    readout.innerHTML = `To withdraw you must <b>prove your balance</b> &mdash; and that means proving, for <b>every</b> swap (not just your 5), whether it's yours. Watch: the circuit has to sweep the entire history.`;
    if (reduced) { afterSweep(); return; }
    const tl = gsap.timeline({ onComplete: afterSweep });
    cellEls.forEach((c, i) => {
      tl.add(() => { c.classList.add("scan"); gsap.delayedCall(0.18, () => c.classList.remove("scan")); }, i * (0.5 / CELLS));
    });
  }

  function afterSweep(): void {
    readout.innerHTML = `Done &mdash; your proof had to account for the <b>whole</b> history just to establish a balance that touches 5 swaps. A recursive SNARK can fold those statements, but the prover still does work for <b>every single swap</b>. At this throughput that's hopeless for a user. <b>This is the wall.</b>`;
  }

  q<HTMLButtonElement>('[data-act="prove"]').addEventListener("click", prove);
  rate.addEventListener("input", updateRate);

  updateRate();

  function intro(): void { if (!revealed) reveal(); }
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
