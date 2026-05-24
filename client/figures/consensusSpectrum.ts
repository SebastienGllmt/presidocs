// Interactive figure for posts/offer-files.html: choosing consensus for the L2.
//
// Because integrity is cryptographic (the ZK proof), consensus is freed from
// providing security — it only ORDERS transactions and finalizes them. That
// decoupling lets us pick consensus purely for performance and MEV-resistance.
// The reader clicks along a spectrum — single sequencer → round-robin → a real
// BFT committee (Simplex + a BLS threshold signature) — and watches
// decentralization / liveness / MEV-resistance change, while a constant banner
// reminds them integrity never depends on the choice.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

interface Opt {
  id: string;
  label: string;
  levels: { decentralization: number; liveness: number; mev: number }; // 1=low 2=med 3=high
  diagram: string;
  note: string;
}

const LEVEL = ["", "low", "medium", "high"];

const OPTIONS: Opt[] = [
  {
    id: "single",
    label: "Single sequencer",
    levels: { decentralization: 1, liveness: 1, mev: 1 },
    diagram: `<g><rect x="70" y="34" width="120" height="40" rx="8" fill="#f3f0fb" stroke="#9a82d8"/><text x="130" y="59" text-anchor="middle" font-size="12" font-weight="600" fill="#4b3b8f">sequencer</text><line x1="190" y1="54" x2="250" y2="54" stroke="#999" marker-end="url(#cns-arr)"/><rect x="250" y="38" width="60" height="32" rx="6" fill="#eef" stroke="#aab"/><text x="280" y="58" text-anchor="middle" font-size="11" fill="#44557a">block</text></g>`,
    note: "One operator orders every transaction. Fastest and simplest &mdash; but it can stall or censor, and you're trusting it not to reorder for MEV. Note it still can't <em>forge</em> state: the proof guarantees that.",
  },
  {
    id: "rr",
    label: "Round-robin",
    levels: { decentralization: 2, liveness: 2, mev: 2 },
    diagram: `<g><g font-size="11">${[0, 1, 2, 3].map((i) => `<circle cx="${100 + i * 60}" cy="40" r="14" fill="${i === 1 ? "#e7defb" : "#f3f3f7"}" stroke="${i === 1 ? "#6a4fb0" : "#c8c8d4"}"/><text x="${100 + i * 60}" y="44" text-anchor="middle" fill="#666">n${i + 1}</text>`).join("")}</g><text x="160" y="74" text-anchor="middle" font-size="10" fill="#6a4fb0">&uarr; this slot's proposer (rotates)</text></g>`,
    note: "The proposer rotates through a known set. No single point of failure and still cheap &mdash; a stalling or misbehaving proposer is just skipped next slot.",
  },
  {
    id: "bft",
    label: "BFT committee · Simplex + BLS",
    levels: { decentralization: 3, liveness: 3, mev: 3 },
    diagram: `<g font-size="11">${[0, 1, 2, 3, 4].map((i) => `<circle cx="${118 + i * 36}" cy="30" r="12" fill="#e7defb" stroke="#6a4fb0"/>`).join("")}<text x="190" y="56" text-anchor="middle" fill="#666">committee agrees each block (BFT)</text><rect x="132" y="64" width="116" height="22" rx="11" fill="#e6f5ec" stroke="#5bb87a"/><text x="190" y="79" text-anchor="middle" fill="#2f7d4d" font-weight="600" font-size="10">BLS threshold sig</text></g>`,
    note: "A committee agrees each block via a fast BFT like <a href=\"https://simplex.blog/\">Simplex</a>, and a <strong>BLS threshold signature</strong> certifies the agreed state in one tiny signature anyone &mdash; even the L1 &mdash; can verify cheaply. Best liveness, and a solid base to <em>build</em> MEV mitigation on (fair ordering, encrypted mempools) &mdash; significant extra work, not built into Simplex itself.",
  },
];

const fig = document.getElementById("consensus-figure");
if (fig) initConsensus(fig);

function initConsensus(figure: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const METRICS: [keyof Opt["levels"], string][] = [
    ["decentralization", "decentralization"],
    ["liveness", "liveness / censorship-resistance"],
    ["mev", "MEV-mitigation potential"],
  ];

  const stage = document.createElement("div");
  stage.className = "cns-fig";
  stage.innerHTML = `
    <div class="cns-const">Integrity: <b>cryptographic (the ZK proof)</b> &mdash; consensus only orders, so it can never forge state, whichever option you pick.</div>
    <div class="cns-tabs">
      ${OPTIONS.map((o, i) => `<button type="button" data-opt="${o.id}"${i === 0 ? ' aria-selected="true"' : ""}>${o.label}</button>`).join("")}
    </div>
    <svg class="cns-diagram" viewBox="0 0 380 96" role="img" aria-hidden="true"><defs><marker id="cns-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#999"/></marker></defs><g data-diagram></g></svg>
    <div class="cns-meters" data-meters></div>
    <p class="cns-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("consensus-enhanced");

  const q = <T extends Element>(s: string) => stage.querySelector(s) as T;
  const tabBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-opt]"));
  const diagram = q<SVGGElement>("[data-diagram]");
  const meters = q<HTMLElement>("[data-meters]");
  const readout = q<HTMLElement>("[data-readout]");

  function render(id: string): void {
    const o = OPTIONS.find((x) => x.id === id)!;
    tabBtns.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.opt === id)));
    diagram.innerHTML = o.diagram;
    meters.innerHTML = METRICS.map(([k, label]) => {
      const lvl = o.levels[k];
      const segs = [1, 2, 3].map((s) => `<span class="seg${s <= lvl ? " on l" + lvl : ""}"></span>`).join("");
      return `<div class="cns-metric"><span class="m-label">${label}</span><span class="m-bar">${segs}</span><span class="m-val">${LEVEL[lvl]}</span></div>`;
    }).join("");
    readout.innerHTML = o.note;
    if (!reduced) gsap.from(meters.querySelectorAll(".seg.on"), { scaleX: 0, transformOrigin: "left", duration: 0.3, stagger: 0.04, ease: "power1.out" });
  }

  tabBtns.forEach((b) => b.addEventListener("click", () => render(b.dataset.opt!)));
  render("single");

  // Narration / scroll: step through the options so a listener sees the spectrum.
  function tour(): void {
    if (reduced) { render("bft"); return; }
    render("single");
    gsap.delayedCall(1.2, () => render("rr"));
    gsap.delayedCall(2.4, () => render("bft"));
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); tour(); }
  }, { threshold: 0.3 });
  io.observe(figure);

  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) tour();
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}
