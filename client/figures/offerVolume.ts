// Real-data figure for posts/offer-files.html: adoption of Chia offer files,
// indexed by dexie. Tabbed so each chart carries ONE clear takeaway instead of
// layering metrics on one plot:
//   1. Swaps / week        — activity over time (all asset pairs)
//   2. USD share           — what fraction of swaps are against a USD stablecoin
//   3. USD volume / week   — dollar throughput over time
//   4. XCH price           — context for why dollar volume moves
//
// Data is BAKED INTO THE POST (inline <script type="application/json">), not
// fetched at runtime (prod CSP is `connect-src 'self'`; one-file-per-post). It's
// a small weekly aggregate produced offline by research/dexie-offers/charts/aggregate-charts.ts from
// a full local crawl (research/dexie-offers/pipeline/crawl-dexie.ts) + the price series — so we ship
// ~100 points per series, not ~982k raw swaps.
//
// External module for the CSP reason in hashAvalanche.ts. GSAP writes CSSOM
// only. Progressive enhancement over a static SVG; narration-synced; reduced
// motion aware.
import { gsap } from "gsap";

interface Week { w: string; nAll: number; vu: number; p: number }
interface Dataset { totalAllAssets: number; usdCount: number; asOf: string; weeks: Week[]; interim?: boolean }

const NS = "http://www.w3.org/2000/svg";
const W = 680;
const H = 300;
const PAD = { t: 16, r: 18, b: 30, l: 56 };
const PLOTW = W - PAD.l - PAD.r;
const PLOTH = H - PAD.t - PAD.b;

type TabId = "swaps" | "share" | "volume" | "price";
const TABS: { id: TabId; label: string }[] = [
  { id: "swaps", label: "Swaps / week" },
  { id: "share", label: "USD share" },
  { id: "volume", label: "USD volume / week" },
  { id: "price", label: "Chia price" },
];

function el(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;

function initFigure(figure: HTMLElement, ds: Dataset): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const weeks = ds.weeks;
  const n = weeks.length;
  const usdPct = ds.totalAllAssets ? (ds.usdCount / ds.totalAllAssets) * 100 : 0;

  const stage = document.createElement("div");
  stage.className = "vol-fig";
  stage.innerHTML = `
    <div class="vol-head">
      <span class="vol-big"><b>${fmtInt(ds.totalAllAssets)}</b> swaps settled</span>
      <span class="vol-sub">across every asset on dexie &middot; ${ds.asOf}</span>
      ${ds.interim ? '<span class="vol-preview">preview &middot; all-asset data still downloading</span>' : ""}
    </div>
    <div class="vol-tabs" role="tablist">
      ${TABS.map((t, i) => `<button type="button" role="tab" data-tab="${t.id}"${i === 0 ? ' aria-selected="true"' : ""}>${t.label}</button>`).join("")}
    </div>
    <div class="vol-modes" data-modes hidden>
      <button type="button" data-mode="weekly" aria-selected="true">per week</button>
      <button type="button" data-mode="cumulative">cumulative</button>
    </div>
    <div class="vol-chart" data-chart></div>
    <p class="vol-readout" data-readout></p>`;
  const caption = figure.querySelector("figcaption");
  figure.insertBefore(stage, caption);
  figure.classList.add("volume-enhanced");

  const chartBox = stage.querySelector<HTMLElement>("[data-chart]")!;
  const readout = stage.querySelector<HTMLElement>("[data-readout]")!;
  const tabBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const modeWrap = stage.querySelector<HTMLElement>("[data-modes]")!;
  const modeBtns = Array.from(stage.querySelectorAll<HTMLButtonElement>("[data-mode]"));
  let cumulative = false; // shared across the swaps & volume tabs
  const cumsum = (vals: number[]) => { let s = 0; return vals.map((v) => (s += v)); };

  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * PLOTW);

  function newSvg(label: string): SVGElement {
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "vol-svg", role: "img" });
    svg.setAttribute("aria-label", label);
    return svg;
  }

  function yearTicks(svg: SVGElement): void {
    let prev = "";
    weeks.forEach((wk, i) => {
      const yr = wk.w.slice(0, 4);
      if (yr !== prev) {
        prev = yr;
        svg.appendChild(el("line", { x1: x(i), y1: PAD.t, x2: x(i), y2: H - PAD.b, class: "vol-grid year" }));
        const tx = el("text", { x: x(i), y: H - PAD.b + 20, class: "vol-xtick", "text-anchor": "middle" });
        tx.textContent = yr;
        svg.appendChild(tx);
      }
    });
  }

  function gridY(svg: SVGElement, max: number, fmt: (v: number) => string, cls: string): void {
    for (let k = 0; k <= 2; k++) {
      const yy = PAD.t + (k / 2) * PLOTH;
      svg.appendChild(el("line", { x1: PAD.l, y1: yy, x2: W - PAD.r, y2: yy, class: "vol-grid" }));
      const t = el("text", { x: PAD.l - 7, y: yy + 3, class: `vol-ytick ${cls}`, "text-anchor": "end" });
      t.textContent = fmt((max * (2 - k)) / 2);
      svg.appendChild(t);
    }
  }

  function bars(values: number[], color: string): { svg: SVGElement; rects: SVGElement[] } {
    const max = Math.max(1, ...values);
    const svg = newSvg("");
    gridY(svg, max, (v) => (color === "vol" ? fmtUsd(v) : fmtInt(v)), color);
    yearTicks(svg);
    const bw = Math.max(1.2, PLOTW / n - 1.2);
    const rects = values.map((v, i) => {
      const h = (v / max) * PLOTH;
      const r = el("rect", { x: x(i) - bw / 2, y: H - PAD.b - h, width: bw, height: h, class: `vol-barseries ${color}` });
      svg.appendChild(r);
      return r;
    });
    return { svg, rects };
  }

  function line(values: number[], color: string, fmt: (v: number) => string, area = false): { svg: SVGElement; path: SVGElement } {
    const max = Math.max(1, ...values);
    const svg = newSvg("");
    gridY(svg, max, fmt, color);
    yearTicks(svg);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${(PAD.t + (1 - v / max) * PLOTH).toFixed(1)}`);
    const base = H - PAD.b;
    if (area) {
      svg.appendChild(el("path", { d: `M${x(0).toFixed(1)},${base} L${pts.join(" L")} L${x(n - 1).toFixed(1)},${base} Z`, class: `vol-area-fill ${color}` }));
    }
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
    const path = el("path", { d, class: `vol-lineseries ${color}`, fill: "none" });
    svg.appendChild(path);
    return { svg, path };
  }

  function hover(svg: SVGElement, onIndex: (i: number) => void, onLeave: () => void): void {
    const guide = el("line", { x1: 0, y1: PAD.t, x2: 0, y2: H - PAD.b, class: "vol-guide", opacity: 0 });
    svg.appendChild(guide);
    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / PLOTW) * (n - 1))));
      guide.setAttribute("x1", String(x(i)));
      guide.setAttribute("x2", String(x(i)));
      guide.setAttribute("opacity", "1");
      onIndex(i);
    });
    svg.addEventListener("pointerleave", () => { guide.setAttribute("opacity", "0"); onLeave(); });
  }

  function donut(): SVGElement {
    const svg = newSvg(`${usdPct.toFixed(1)}% of swaps are against a USD stablecoin`);
    const cx = W / 2;
    const cy = H / 2;
    const r = 92;
    const frac = usdPct / 100;
    const arc = (from: number, to: number, cls: string) => {
      const a0 = from * 2 * Math.PI - Math.PI / 2;
      const a1 = to * 2 * Math.PI - Math.PI / 2;
      const large = to - from > 0.5 ? 1 : 0;
      const p = el("path", {
        d: `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`,
        class: `vol-slice ${cls}`,
      });
      svg.appendChild(p);
    };
    arc(0, frac, "usd");
    arc(frac, 1, "other");
    // hole + label
    svg.appendChild(el("circle", { cx, cy, r: 52, fill: "#fff" }));
    const big = el("text", { x: cx, y: cy - 2, "text-anchor": "middle", class: "donut-pct" });
    big.textContent = `${usdPct.toFixed(1)}%`;
    svg.appendChild(big);
    const sub = el("text", { x: cx, y: cy + 18, "text-anchor": "middle", class: "donut-sub" });
    sub.textContent = "USD-paired";
    svg.appendChild(sub);
    // legend
    const lg = (lx: number, cls: string, label: string) => {
      svg.appendChild(el("rect", { x: lx, y: H - 26, width: 12, height: 12, rx: 2, class: `vol-slice ${cls}` }));
      const t = el("text", { x: lx + 18, y: H - 16, class: "vol-xtick", "text-anchor": "start" });
      t.textContent = label;
      svg.appendChild(t);
    };
    lg(cx - 150, "usd", `USD-paired · ${fmtInt(ds.usdCount)}`);
    lg(cx + 20, "other", `everything else · ${fmtInt(ds.totalAllAssets - ds.usdCount)}`);
    return svg;
  }

  function animateIn(node: SVGElement, kind: "bars" | "line" | "donut", payload?: SVGElement[] | SVGElement): void {
    if (reduced) return;
    if (kind === "bars" && Array.isArray(payload)) {
      gsap.from(payload, { scaleY: 0, transformOrigin: "bottom", duration: 0.5, stagger: { each: 0.5 / n }, ease: "power1.out" });
    } else if (kind === "line" && payload && !Array.isArray(payload)) {
      const len = (payload as SVGPathElement).getTotalLength();
      gsap.fromTo(payload, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.2, ease: "power1.inOut" });
    } else if (kind === "donut") {
      gsap.from(node.querySelectorAll(".vol-slice"), { opacity: 0, duration: 0.5, stagger: 0.1 });
    }
  }

  let current: TabId = "swaps";

  // Swaps & volume tabs: bars (per week) or area-line (cumulative), toggled.
  function renderSeries(vals: number[], color: "swaps" | "vol", noun: string): void {
    const fmtV = color === "vol" ? fmtUsd : fmtInt;
    if (!cumulative) {
      const { svg, rects } = bars(vals, color);
      chartBox.appendChild(svg);
      animateIn(svg, "bars", rects);
      const total = vals.reduce((a, b) => a + b, 0);
      const base = `Per-week ${noun} (the dollar value of USD-paired swaps for volume). ${fmtV(total)} in total over the window.`;
      readout.innerHTML = base;
      hover(svg, (i) => { readout.innerHTML = `<b>week of ${weeks[i].w}</b> &mdash; ${fmtV(vals[i])}`; }, () => { readout.innerHTML = base; });
    } else {
      const cum = cumsum(vals);
      const { svg, path } = line(cum, color, fmtV, true);
      chartBox.appendChild(svg);
      animateIn(svg, "line", path);
      const base = `<b>Cumulative</b> ${noun} &mdash; the running total to date (${fmtV(cum[n - 1])}). The "up and to the right" view.`;
      readout.innerHTML = base;
      hover(svg, (i) => { readout.innerHTML = `<b>by ${weeks[i].w}</b> &mdash; ${fmtV(cum[i])} cumulatively`; }, () => { readout.innerHTML = base; });
    }
  }

  function render(tab: TabId): void {
    current = tab;
    chartBox.innerHTML = "";
    tabBtns.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    modeWrap.hidden = !(tab === "swaps" || tab === "volume");

    if (tab === "swaps") {
      renderSeries(weeks.map((w) => w.nAll), "swaps", "swaps");
    } else if (tab === "volume") {
      renderSeries(weeks.map((w) => w.vu), "vol", "USD-denominated volume");
    } else if (tab === "share") {
      chartBox.appendChild(donut());
      animateIn(chartBox.firstChild as SVGElement, "donut");
      readout.innerHTML = `Only about <b>${usdPct.toFixed(1)}%</b> of all swaps are priced against a USD stablecoin (wUSDC.b / wUSDC). Most Chia trading is token-to-token or NFT &mdash; so the dollar charts here describe a real but minority slice.`;
    } else {
      const vals = weeks.map((w) => w.p);
      const { svg, path } = line(vals, "price", (v) => `$${v.toFixed(0)}`);
      chartBox.appendChild(svg);
      animateIn(svg, "line", path);
      const base = `Chia's price over the window (median of USD-paired swaps): from about $${weeks[0].p.toFixed(0)} to $${weeks[n - 1].p.toFixed(2)}. Context for the volume curve, not the headline.`;
      readout.innerHTML = base;
      hover(svg, (i) => { readout.innerHTML = `<b>week of ${weeks[i].w}</b> &mdash; $${weeks[i].p.toFixed(2)} / XCH`; }, () => { readout.innerHTML = base; });
    }
  }

  tabBtns.forEach((b) => b.addEventListener("click", () => render(b.dataset.tab as TabId)));
  modeBtns.forEach((b) => b.addEventListener("click", () => {
    cumulative = b.dataset.mode === "cumulative";
    modeBtns.forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    render(current);
  }));
  render("swaps");

  // Narration / scroll: replay the current tab's intro.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.disconnect(); render(current); }
  }, { threshold: 0.3 });
  io.observe(figure);
  let active = figure.classList.contains("narration-active");
  const mo = new MutationObserver(() => {
    const now = figure.classList.contains("narration-active");
    if (now && !active) render(current);
    active = now;
  });
  mo.observe(figure, { attributes: true, attributeFilter: ["class"] });
}

// Run-guard last, so all helper consts (fmtInt/fmtUsd) and functions are
// initialized before initFigure runs. (Placing this above the const helpers
// would call initFigure while fmtInt is still in its temporal dead zone.)
const fig = document.getElementById("volume-figure");
const dataEl = document.getElementById("dexie-xch-usdc");
if (fig && dataEl) {
  try {
    const ds = JSON.parse(dataEl.textContent || "null") as Dataset | null;
    if (ds && ds.weeks?.length) initFigure(fig, ds);
    else console.warn("offerVolume: data has no .weeks[] — stale bundle? (hard-reload)", ds);
  } catch (e) {
    console.error("offerVolume: failed to render tabbed chart", e); // leaves static fallback
  }
}
