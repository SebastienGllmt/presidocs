/**
 * Generate the static SVG figures for posts/offer-files-data.html from the
 * deep-dive finding CSVs (research/dexie-offers/findings/data/*.csv). Reproducible:
 * re-run to rebuild every chart. Output → generated/charts/<id>.svg.
 *
 *   bun research/dexie-offers/charts/make-charts.ts
 *
 * CSP-clean by construction: presentation attributes only (fill=, stroke=,
 * font-size=), never `style=` or inline <style> (the prod CSP forbids both).
 * These SVGs are inlined into the post as each <figure>'s static frame.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DATA = join(ROOT, "research", "dexie-offers", "findings", "data");
const OUT = join(ROOT, "generated", "charts");
mkdirSync(OUT, { recursive: true });

const C = {
  blue: "#2b6cb0", violet: "#6b46c1", green: "#2f855a", orange: "#c05621",
  red: "#c53030", gray: "#4a5568", grid: "#e2e8f0", axis: "#94a3b8", ink: "#1a202c",
};
const W = 760, H = 380, M = { t: 46, r: 24, b: 46, l: 60 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === ",") { out.push(cur); cur = ""; }
    else if (ch === '"') q = true;
    else cur += ch;
  }
  out.push(cur); return out;
}
function parseCSV(name: string): Record<string, string>[] {
  const txt = readFileSync(join(DATA, name), "utf8").trim();
  const [head, ...lines] = txt.split("\n");
  const cols = splitCsv(head);
  return lines.map((l) => {
    const v = splitCsv(l);
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xAt = (i: number, n: number) => M.l + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW);
const yAt = (v: number, lo: number, hi: number) => M.t + PH - ((v - lo) / (hi - lo || 1)) * PH;

function frame(title: string, sub: string, yTicks: number[], yLo: number, yHi: number, yFmt: (v: number) => string) {
  const parts: string[] = [];
  // Title and subtitle on separate lines (left-aligned) so long ones never collide.
  parts.push(`<text x="${M.l}" y="17" font-size="15" font-weight="700" fill="${C.ink}">${esc(title)}</text>`);
  if (sub) parts.push(`<text x="${M.l}" y="34" font-size="11" fill="${C.gray}">${esc(sub)}</text>`);
  for (const t of yTicks) {
    const y = yAt(t, yLo, yHi);
    parts.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${W - M.r}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${M.l - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.gray}" text-anchor="end">${esc(yFmt(t))}</text>`);
  }
  parts.push(`<line x1="${M.l}" y1="${M.t + PH}" x2="${W - M.r}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1"/>`);
  return parts;
}
function xTickLabels(labels: string[], every: number) {
  const n = labels.length, p: string[] = [];
  for (let i = 0; i < n; i += every) {
    const x = xAt(i, n);
    p.push(`<text x="${x.toFixed(1)}" y="${M.t + PH + 18}" font-size="10" fill="${C.gray}" text-anchor="middle">${esc(labels[i])}</text>`);
  }
  return p;
}
function polyline(vals: number[], lo: number, hi: number, color: string, wdt = 2.5) {
  const n = vals.length;
  const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i, n).toFixed(1)},${yAt(v, lo, hi).toFixed(1)}`).join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${wdt}" stroke-linejoin="round"/>`;
}
function legend(items: { name: string; color: string }[], x: number, y: number) {
  return items.map((it, i) => {
    const yy = y + i * 18;
    return `<rect x="${x}" y="${yy - 9}" width="14" height="4" rx="2" fill="${it.color}"/>` +
      `<text x="${x + 20}" y="${yy - 2}" font-size="11" fill="${C.ink}">${esc(it.name)}</text>`;
  }).join("");
}
function svg(id: string, label: string, inner: string) {
  const out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">\n${inner}\n</svg>`;
  writeFileSync(join(OUT, `${id}.svg`), out);
  console.log(`wrote ${id}.svg (${out.length}b)`);
}

// ---- 1. Monthly volume (offers/month) ---------------------------------------
{
  const rows = parseCSV("02-nft-monthly-share.csv");
  const months = rows.map((r) => r.month);
  const tot = rows.map((r) => +r.total_offers);
  const hi = 40000, lo = 0;
  const ticks = [0, 10000, 20000, 30000, 40000];
  const p = frame("Completed offers per month", "833,145 total · 2022-01 → 2026-05", ticks, lo, hi, (v) => `${v / 1000}k`);
  // area
  const n = months.length;
  const area = tot.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i, n).toFixed(1)},${yAt(v, lo, hi).toFixed(1)}`).join(" ")
    + ` L${xAt(n - 1, n).toFixed(1)},${M.t + PH} L${xAt(0, n).toFixed(1)},${M.t + PH} Z`;
  p.push(`<path d="${area}" fill="${C.blue}" fill-opacity="0.12"/>`);
  p.push(polyline(tot, lo, hi, C.blue));
  p.push(...xTickLabels(months, 6));
  svg("chart-volume", "Completed Chia offers per month, 2022 to 2026", p.join("\n"));
}

// ---- 2. NFT share of all offers ---------------------------------------------
{
  const rows = parseCSV("02-nft-monthly-share.csv");
  const months = rows.map((r) => r.month);
  const pct = rows.map((r) => +r.nft_pct);
  const ticks = [0, 20, 40, 60, 80, 100];
  const p = frame("NFTs as a share of all offers", "the 2022 boom, then a volatile decline", ticks, 0, 100, (v) => `${v}%`);
  p.push(polyline(pct, 0, 100, C.violet));
  // annotate peak
  const peak = pct.indexOf(Math.max(...pct));
  p.push(`<circle cx="${xAt(peak, months.length).toFixed(1)}" cy="${yAt(pct[peak], 0, 100).toFixed(1)}" r="3.5" fill="${C.violet}"/>`);
  p.push(`<text x="${xAt(peak, months.length).toFixed(1)}" y="${(yAt(pct[peak], 0, 100) - 8).toFixed(1)}" font-size="10" fill="${C.violet}" text-anchor="middle">82.5% (Jul 2022)</text>`);
  p.push(...xTickLabels(months, 6));
  svg("chart-nft-share", "NFT share of all offers over time, peaking at 82 percent in mid 2022", p.join("\n"));
}

// ---- 3. Median NFT price: XCH vs USD ----------------------------------------
{
  const rows = parseCSV("02-nft-price-monthly.csv");
  const months = rows.map((r) => r.month);
  const xch = rows.map((r) => +r.med_xch);
  const usd = rows.map((r) => (r.med_usd === "" || r.med_usd == null) ? null : +r.med_usd);
  const ticks = [0, 2, 4, 6];
  const p = frame("Median NFT sale price: a sticky XCH floor", "single-pair NFT→XCH · USD priceable only from mid-2024 (warp.green coins)", ticks, 0, 6, (v) => `$${v}`);
  // USD line: segmented so it only spans months with a trustworthy (warp-era) FX
  let d = "", started = false;
  usd.forEach((v, i) => {
    if (v == null) { started = false; return; }
    const X = xAt(i, months.length), Y = yAt(v, 0, 6);
    d += `${started ? "L" : "M"}${X.toFixed(1)},${Y.toFixed(1)} `; started = true;
  });
  p.push(`<path d="${d.trim()}" fill="none" stroke="${C.red}" stroke-width="2.5" stroke-linejoin="round"/>`);
  p.push(polyline(xch, 0, 6, C.green));
  p.push(legend([{ name: "Median USD value (warp era)", color: C.red }, { name: "Median XCH price", color: C.green }], M.l + 12, M.t + 6));
  p.push(...xTickLabels(months, 6));
  svg("chart-nft-price", "Median NFT sale price in XCH stays a flat 0.1 to 0.2; its dollar value, priceable only from mid-2024, sits around one to five dollars", p.join("\n"));
}

// ---- 4. AMM (TibetSwap) share of offers -------------------------------------
{
  const rows = parseCSV("01-amm-monthly-share.csv");
  const months = rows.map((r) => r.month);
  const pct = rows.map((r) => +r.pct_tibet2);
  const ticks = [0, 20, 40, 60, 80, 100];
  const p = frame("Share of offers filled by the TibetSwap AMM", "labelled only since 2025-04 · a floor on true automation", ticks, 0, 100, (v) => `${v}%`);
  // bars
  const n = months.length, bw = PW / n * 0.62;
  rows.forEach((_, i) => {
    const x = xAt(i, n) - bw / 2, y = yAt(pct[i], 0, 100);
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${C.orange}" fill-opacity="0.85" rx="1.5"/>`);
  });
  p.push(`<line x1="${M.l}" y1="${yAt(50, 0, 100).toFixed(1)}" x2="${W - M.r}" y2="${yAt(50, 0, 100).toFixed(1)}" stroke="${C.red}" stroke-width="1" stroke-dasharray="4 3"/>`);
  p.push(`<text x="${W - M.r}" y="${(yAt(50, 0, 100) - 4).toFixed(1)}" font-size="10" fill="${C.red}" text-anchor="end">half of all fills</text>`);
  p.push(...xTickLabels(months, 2));
  svg("chart-amm", "TibetSwap AMM fills as a share of offers, rising toward two thirds in 2026", p.join("\n"));
}

// ---- 5. Reconstructed XCH/USD oracle (weekly) -------------------------------
{
  const rows = parseCSV("03-price-oracle-weekly.csv");
  const wk = rows.map((r) => r.week);
  const px = rows.map((r) => +r.usd_per_xch);
  const ticks = [0, 10, 20, 30, 40];
  const p = frame("XCH/USD reconstructed from offer flow alone", "weekly median, warp.green stablecoins · no external feed", ticks, 0, 40, (v) => `$${v}`);
  p.push(polyline(px, 0, 40, C.blue, 2));
  p.push(...xTickLabels(wk.map((w) => w.slice(0, 7)), 12));
  svg("chart-oracle", "XCH price in dollars reconstructed from settled offers, declining from 31 to under 3", p.join("\n"));
}

// ---- 6. Lorenz curve of fungible concentration ------------------------------
{
  const rows = parseCSV("04-concentration-lorenz.csv");
  const xs = [0, ...rows.map((r) => +r.asset_pct * 100)];
  const ys = [0, ...rows.map((r) => +r.cum_trade_share * 100)];
  const ticks = [0, 20, 40, 60, 80, 100];
  const p = frame("Trade activity is brutally concentrated (Lorenz curve)", "860 fungible CATs · Gini ≈ 0.89 (a floor)", ticks, 0, 100, (v) => `${v}%`);
  // equality line
  p.push(`<line x1="${M.l}" y1="${M.t + PH}" x2="${W - M.r}" y2="${M.t}" stroke="${C.axis}" stroke-width="1" stroke-dasharray="4 3"/>`);
  p.push(`<text x="${W - M.r - 4}" y="${(M.t + 14)}" font-size="10" fill="${C.gray}" text-anchor="end">perfect equality</text>`);
  const n = xs.length;
  const xpos = (v: number) => M.l + (v / 100) * PW;
  const d = xs.map((v, i) => `${i === 0 ? "M" : "L"}${xpos(v).toFixed(1)},${yAt(ys[i], 0, 100).toFixed(1)}`).join(" ");
  p.push(`<path d="${d} L${(W - M.r)},${M.t + PH} Z" fill="${C.orange}" fill-opacity="0.12"/>`);
  p.push(`<path d="${d}" fill="none" stroke="${C.orange}" stroke-width="2.5"/>`);
  p.push(`<text x="${(M.l + PW * 0.5).toFixed(1)}" y="${M.t + PH + 36}" font-size="11" fill="${C.gray}" text-anchor="middle">cumulative share of CATs (fewest trades → most)</text>`);
  // x ticks
  for (const t of ticks) p.push(`<text x="${xpos(t).toFixed(1)}" y="${M.t + PH + 18}" font-size="10" fill="${C.gray}" text-anchor="middle">${t}%</text>`);
  svg("chart-lorenz", "Lorenz curve showing the bottom 80 percent of tokens carry under 6 percent of trades", p.join("\n"));
}

// ---- 7. Time-to-fill distribution (bimodal) — data from 05 finding ----------
{
  // source: research/dexie-offers/findings/05-microstructure.md Finding 2 (n=813,499)
  const buckets = [
    ["<10s", 49572], ["10–60s", 213204], ["1–10m", 104856], ["10–60m", 54380],
    ["1–24h", 153099], ["1–7d", 79782], ["7–30d", 41571], [">30d", 117035],
  ] as [string, number][];
  const vals = buckets.map((b) => b[1]);
  const hi = 240000, ticks = [0, 60000, 120000, 180000, 240000];
  const p = frame("How long offers take to fill", "two markets: an instant AMM layer and a slow resting layer", ticks, 0, hi, (v) => `${v / 1000}k`);
  const n = buckets.length, bw = PW / n * 0.66;
  buckets.forEach((b, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(b[1], 0, hi);
    const col = i <= 1 ? C.orange : i >= 6 ? C.violet : C.blue;
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${col}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 16}" font-size="10" fill="${C.gray}" text-anchor="middle">${esc(b[0])}</text>`);
  });
  p.push(legend([{ name: "instant (AMM/bot)", color: C.orange }, { name: "resting (NFTs, patient swaps)", color: C.violet }], M.l + 12, M.t + 18));
  svg("chart-fill", "Time to fill is bimodal, a spike under a minute and a fat tail beyond a month", p.join("\n"));
}

// ---- 8. Asset category mix (share of offers) — description-driven taxonomy ---
{
  // source: research/dexie-offers/findings/data/15-category-shares.csv (built from the committed
  // asset→category mapping research/dexie-offers/findings/asset-categories.csv). Overlapping
  // membership (an offer counts once per category it touches); XCH overlaps all.
  const rows = parseCSV("15-category-shares.csv");
  const label: Record<string, string> = {
    "XCH": "XCH", "NFT": "NFTs", "Memecoin": "Memecoins",
    "Game-economy token": "Game-economy tokens", "Protocol / platform / infra": "Protocol / infra",
    "Stablecoin": "Stablecoins", "NFT-project utility token": "NFT-project tokens",
    "LP token": "TibetSwap LP tokens", "Social / community token": "Social / community",
    "Unclassified": "Unclassified", "RWA": "Real-world-asset NFTs",
  };
  const colour: Record<string, string> = {
    "XCH": C.blue, "NFT": C.violet, "Memecoin": C.orange, "Game-economy token": C.green,
    "Protocol / platform / infra": "#0987a0", "Stablecoin": C.red,
    "NFT-project utility token": "#805ad5", "LP token": "#319795",
    "Social / community token": "#d53f8c", "Unclassified": C.axis, "RWA": "#7b341e",
  };
  const rowH = 30, top = M.t + 2, barL = 200, barMax = W - M.r - barL - 36;
  const inner: string[] = [];
  inner.push(`<text x="${M.l - 36}" y="17" font-size="15" font-weight="700" fill="${C.ink}">What gets traded (share of all 833k offers)</text>`);
  inner.push(`<text x="${M.l - 36}" y="34" font-size="11" fill="${C.gray}">overlaps; most offers are token↔XCH</text>`);
  rows.forEach((r, i) => {
    const pct = +r.pct_of_all_offers, y = top + i * rowH;
    inner.push(`<text x="${barL - 10}" y="${y + 15}" font-size="11.5" fill="${C.ink}" text-anchor="end">${esc(label[r.category] ?? r.category)}</text>`);
    inner.push(`<rect x="${barL}" y="${y}" width="${Math.max(barMax * pct / 100, 1).toFixed(1)}" height="20" fill="${colour[r.category] ?? C.gray}" rx="3"/>`);
    inner.push(`<text x="${(barL + Math.max(barMax * pct / 100, 1) + 6).toFixed(1)}" y="${y + 15}" font-size="11" fill="${C.gray}">${pct.toFixed(pct < 1 ? 1 : 0)}%</text>`);
  });
  svg("chart-categories", "What gets traded by share of offers: XCH 77%, NFTs 38%, memecoins 27%, game-economy tokens 20%, then stablecoins and others", inner.join("\n"));
}

// ---- 9. Game economies: successive self-contained bursts -------------------
{
  const rows = parseCSV("04-concentration-game-timeline.csv");
  const months = rows.map((r) => r.month);
  const fv = rows.map((r) => +r.farmerverse_offers);
  const al = rows.map((r) => +r.abandoned_land_offers);
  const g4 = rows.map((r) => +r.go4me_offers);
  const hi = 12000, ticks = [0, 3000, 6000, 9000, 12000];
  const p = frame("Game economies trade off in waves", "offers/month involving each game's tokens", ticks, 0, hi, (v) => `${v / 1000}k`);
  p.push(polyline(al, 0, hi, C.orange));
  p.push(polyline(fv, 0, hi, C.green));
  p.push(polyline(g4, 0, hi, C.violet));
  p.push(legend([
    { name: "FarmerVerse (76k offers)", color: C.green },
    { name: "Abandoned Land (48k)", color: C.orange },
    { name: "go4me (24k)", color: C.violet },
  ], M.l + 12, M.t + 16));
  p.push(...xTickLabels(months, 6));
  svg("chart-games", "Three game economies peak in succession: Abandoned Land and FarmerVerse in 2022 to 2023, go4me in 2025", p.join("\n"));
}

// ---- 10. NFT royalties: higher rate → more sales pay it out (O2 dose-response) -
{
  // source: research/dexie-offers/findings/07-royalties.md Chart 4B (single-pair NFT→XCH sales)
  const buckets = [
    ["0%", 9.5], ["1–3%", 22.5], ["4–7%", 39.9], ["8–15%", 48.2], [">15%", 58.3],
  ] as [string, number][];
  const ticks = [0, 20, 40, 60];
  const p = frame("Higher royalty → more sales create a payout coin", "single-pair NFT→XCH sales · evidence royalties are honored", ticks, 0, 60, (v) => `${v}%`);
  const n = buckets.length, bw = PW / n * 0.6;
  buckets.forEach((b, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(b[1], 0, 60);
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${C.green}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" fill="${C.green}" text-anchor="middle">${b[1]}%</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 17}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(b[0])}</text>`);
  });
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${M.t + PH + 36}" font-size="11" fill="${C.gray}" text-anchor="middle">royalty rate set by the creator</text>`);
  svg("chart-royalties", "Share of NFT sales that create a royalty payout coin rises with the royalty rate, from 9 to 58 percent", p.join("\n"));
}

// ---- 11. Automation predates the label (O1 proxy C) ------------------------
{
  const rows = parseCSV("06-participants-botshare-yearly.csv");
  const years = rows.map((r) => r.year);
  const pct = rows.map((r) => +r.pct_botlike);
  const ticks = [0, 20, 40, 60];
  const p = frame("Automated-looking trades, by year", "bot fingerprint on XCH↔CAT swaps · the AMM label only began in 2025", ticks, 0, 60, (v) => `${v}%`);
  const n = years.length, bw = PW / n * 0.55;
  rows.forEach((r, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(pct[i], 0, 60);
    // pre-2025 bars are entirely UNLABELLED automation (no tibet2 field yet)
    const labelled = +r.year >= 2025;
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${labelled ? C.orange : C.gray}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" fill="${C.ink}" text-anchor="middle">${pct[i]}%</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 17}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(r.year)}</text>`);
  });
  // bracket over 2023-24 (indices 1-2)
  const x1 = M.l + (1 / n) * PW + 6, x2 = M.l + (3 / n) * PW - 6, yb = M.t + 40;
  p.push(`<path d="M${x1.toFixed(1)},${yb} L${x1.toFixed(1)},${yb - 6} L${x2.toFixed(1)},${yb - 6} L${x2.toFixed(1)},${yb}" fill="none" stroke="${C.gray}" stroke-width="1"/>`);
  p.push(`<text x="${((x1 + x2) / 2).toFixed(1)}" y="${yb - 11}" font-size="10" fill="${C.gray}" text-anchor="middle">no AMM label existed yet</text>`);
  p.push(legend([{ name: "unlabelled (inferred)", color: C.gray }, { name: "AMM era (labelled exists)", color: C.orange }], M.l + 12, M.t + 70));
  svg("chart-automation", "Automated-looking trades were already a third to half of swaps in 2023 to 2024, before any AMM label", p.join("\n"));
}

// ---- 12. NFT creator concentration (O1 proxy A) ----------------------------
{
  const rows = parseCSV("06-participants-creator-concentration.csv");
  const labels = rows.map((r) => `Top ${r.top_n}`);
  const vals = rows.map((r) => +r.pct_of_nft_legs);
  const ticks = [0, 25, 50, 75, 100];
  const p = frame("NFT supply comes from a tiny cast: 891 creators", "cumulative share of NFT trades by the top-N creators", ticks, 0, 100, (v) => `${v}%`);
  const n = rows.length, bw = PW / n * 0.5;
  rows.forEach((r, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(vals[i], 0, 100);
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${C.violet}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="12" fill="${C.violet}" text-anchor="middle">${vals[i]}%</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 17}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(labels[i])} creators</text>`);
  });
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${M.t + PH + 36}" font-size="11" fill="${C.gray}" text-anchor="middle">of all NFT trade legs</text>`);
  svg("chart-creators", "Just ten creators account for 44 percent of NFT trades, fifty for 75 percent", p.join("\n"));
}

// ---- 13. Pick-off curve: cheap offers fill in seconds (S3b / T12) ----------
{
  const rows = parseCSV("12-tightness-pickoff-curve.csv");
  // x: favorability to the taker (negative = offer priced expensive; positive = a bargain)
  const labs = ["<−5%", "−5..−2", "−2..−1", "−1..−0.2", "fair", "+0.2..1", "+1..2", "+2..5", ">+5%"];
  const ttf = rows.map((r) => +r.med_ttf_sec);
  const hi = 700, ticks = [0, 200, 400, 600];
  const p = frame("Mispriced-cheap offers get picked off in seconds", "median time-to-fill by how far the offer is priced from fair (XCH↔USD)", ticks, 0, hi, (v) => v === 0 ? "0" : `${v}s`);
  const n = rows.length, bw = PW / n * 0.62;
  rows.forEach((r, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(ttf[i], 0, hi);
    const pickedOff = i >= 5; // favorable-to-taker buckets — the ones bots snap up
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="${pickedOff ? C.red : C.gray}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="10" fill="${C.ink}" text-anchor="middle">${ttf[i] < 60 ? ttf[i] + "s" : Math.round(ttf[i] / 60) + "m"}</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 16}" font-size="9.5" fill="${C.gray}" text-anchor="middle">${esc(labs[i])}</text>`);
  });
  p.push(`<text x="${(M.l + PW * 0.28).toFixed(1)}" y="${M.t + PH + 34}" font-size="10" fill="${C.gray}" text-anchor="middle">priced expensive →
 sits</text>`.replace(/\n/g, " "));
  p.push(`<text x="${(M.l + PW * 0.82).toFixed(1)}" y="${M.t + PH + 34}" font-size="10" fill="${C.red}" text-anchor="middle">a bargain → grabbed fast</text>`);
  svg("chart-pickoff", "Offers priced cheaply for the taker fill within a minute while fair-priced ones take ten, evidence bots arbitrage mispricings away", p.join("\n"));
}

// ---- 14. Stablecoin breakdown (pie) — which "dollar" tokens get used --------
{
  const rows = parseCSV("13-stablecoins.csv");
  // colour by code so USDSC (the depegged one) is always red, others distinct
  const cmap: Record<string, string> = {
    "wUSDC.b": C.green, "wUSDC": C.blue, "wUSDT": "#0987a0",
    "BYC": C.violet, "USDSC": C.red, "TIBET LP (USD)": C.gray,
  };
  const data = rows.map((r) => ({ code: r.code, n: +r.offers, c: cmap[r.code] ?? C.gray }));
  const total = data.reduce((s, d) => s + d.n, 0);
  const cx = 220, cy = 205, r = 125;
  const inner: string[] = [];
  inner.push(`<text x="24" y="17" font-size="15" font-weight="700" fill="${C.ink}">Which &ldquo;dollar&rdquo; tokens get used</text>`);
  inner.push(`<text x="24" y="34" font-size="11" fill="${C.red}">USDSC later broke its dollar peg</text>`);
  let a = -Math.PI / 2;
  for (const d of data) {
    const a1 = a + (d.n / total) * 2 * Math.PI;
    const x0 = cx + r * Math.cos(a), y0 = cy + r * Math.sin(a);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (a1 - a) > Math.PI ? 1 : 0;
    inner.push(`<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${d.c}" stroke="#fff" stroke-width="1.5"/>`);
    a = a1;
  }
  // legend
  data.forEach((d, i) => {
    const ly = 70 + i * 26, lx = 470;
    inner.push(`<rect x="${lx}" y="${ly - 11}" width="14" height="14" rx="3" fill="${d.c}"/>`);
    inner.push(`<text x="${lx + 22}" y="${ly}" font-size="12" fill="${C.ink}">${esc(d.code)}</text>`);
    inner.push(`<text x="${W - M.r}" y="${ly}" font-size="12" fill="${C.gray}" text-anchor="end">${(100 * d.n / total).toFixed(1)}% · ${d.n.toLocaleString()}</text>`);
  });
  svg("chart-stablecoins", "Stablecoin usage by offers: wUSDC.b 54% and USDSC 40% dominate; USDSC later broke its peg", inner.join("\n"));
}

// ---- 15. Top NFT collections (horizontal bar) -------------------------------
{
  const rows = parseCSV("13-nft-collections.csv").slice(0, 10);
  const max = Math.max(...rows.map((r) => +r.trade_legs));
  const rowH = 32, top = M.t + 6, barL = 230, barMax = W - M.r - barL - 46;
  const inner: string[] = [];
  inner.push(`<text x="${M.l - 36}" y="17" font-size="15" font-weight="700" fill="${C.ink}">The NFTs people actually traded (top collections)</text>`);
  inner.push(`<text x="${M.l - 36}" y="34" font-size="11" fill="${C.gray}">by trade count</text>`);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const nm = r.collection_name.length > 30 ? r.collection_name.slice(0, 29) + "…" : r.collection_name;
    const w = barMax * (+r.trade_legs) / max;
    inner.push(`<text x="${barL - 8}" y="${y + 15}" font-size="11.5" fill="${C.ink}" text-anchor="end">${esc(nm)}</text>`);
    inner.push(`<rect x="${barL}" y="${y}" width="${w.toFixed(1)}" height="20" fill="${C.violet}" rx="3"/>`);
    inner.push(`<text x="${(barL + w + 6).toFixed(1)}" y="${y + 15}" font-size="11" fill="${C.gray}">${(+r.trade_legs / 1000).toFixed(1)}k</text>`);
  });
  svg("chart-nft-collections", "Top NFT collections by trade count, led by go4.me, FarmerVerse and the 10k PFP sets", inner.join("\n"));
}

// ---- 16. Offer-file outcomes (lifecycle status) — data from status-counts.ts -
{
  // ROUGH ESTIMATE, not raw status counts. dexie prunes cancelled/expired offers,
  // so its per-status counts (91k/228k) massively undercount. We estimate
  // cancelled+expired from market-maker reward churn: 2.2M reward offers in 10mo
  // (99.7% never settle), scaled by the all-time DBX payout (683.6k / 0.1043 DBX-per-
  // offer ≈ 6.5M). Settled = measured (985k); Open = live snapshot (599k). See the
  // incentive section's churn charts for the justification.
  const states = [
    ["Cancelled or expired", 6535000, C.red, "~6.5M (est.)"],
    ["Settled (filled)", 985102, C.green, "~985k"],
    ["Open right now", 599334, C.blue, "~600k (snapshot)"],
  ] as [string, number, string, string][];
  const max = 6535000, barL = 165, barMax = W - M.r - barL - 90, top = 70, rowH = 58;
  const inner: string[] = [];
  inner.push(`<text x="${M.l - 36}" y="22" font-size="15" font-weight="700" fill="${C.ink}">What happens to an offer file (rough estimate)</text>`);
  inner.push(`<text x="${M.l - 36}" y="40" font-size="11" fill="${C.gray}">Most never fill. Only the settled slice (~1 in 8) moves money &mdash; that's what this report analyzes.</text>`);
  states.forEach((s, i) => {
    const y = top + i * rowH, w = Math.max(barMax * (s[1] as number) / max, 2);
    inner.push(`<text x="${barL - 10}" y="${y + 21}" font-size="12" fill="${C.ink}" text-anchor="end">${esc(s[0] as string)}</text>`);
    inner.push(`<rect x="${barL}" y="${y}" width="${w.toFixed(1)}" height="32" fill="${s[2]}" rx="3"/>`);
    inner.push(`<text x="${(barL + w + 8).toFixed(1)}" y="${y + 21}" font-size="12" fill="${C.gray}">${esc(s[3] as string)}</text>`);
  });
  inner.push(`<text x="${M.l - 36}" y="${top + 3 * rowH + 8}" font-size="11" fill="${C.gray}">Cancelled/expired is estimated from reward-farming churn (a floor); dexie prunes these, so its own counts undercount.</text>`);
  svg("chart-outcomes", "Rough estimate of offer-file outcomes: about 6.5 million cancelled or expired, 985k settled, 600k open — settled is roughly 1 in 8", inner.join("\n"));
}

// ---- 17. Aggregator (Combined Swap) share over time ------------------------
{
  const rows = parseCSV("17-aggregator-by-month.csv");
  const months = rows.map((r) => r.month);
  const pct = rows.map((r) => +r.pct_combined);
  const ticks = [0, 20, 40, 60];
  const p = frame("Share of offers routed through dexie's aggregator", "Combined Swap (multi-source routing) · the `combined` settlement flag", ticks, 0, 60, (v) => `${v}%`);
  p.push(polyline(pct, 0, 60, "#0987a0"));
  // mark the launch (first month combined>0)
  const launch = pct.findIndex((v) => v > 0);
  if (launch > 0) {
    const lx = xAt(launch, months.length);
    p.push(`<line x1="${lx.toFixed(1)}" y1="${M.t}" x2="${lx.toFixed(1)}" y2="${M.t + PH}" stroke="${C.gray}" stroke-width="1" stroke-dasharray="3 3"/>`);
    p.push(`<text x="${(lx + 5).toFixed(1)}" y="${M.t + 12}" font-size="10" fill="${C.gray}">Combined Swap launches (${esc(months[launch])})</text>`);
  }
  p.push(...xTickLabels(months, 6));
  svg("chart-aggregator", "Combined Swap, dexie's liquidity aggregator, grows from launch in 2024 to about half of offers by 2026", p.join("\n"));
}

// ---- 18. On-chain footprint: % of Chia block space over time ---------------
{
  // CANCEL_MULT: cancellations add ~0.20x the settled footprint — measured on the
  // overlapping window (research/dexie-offers/analysis/25-cancel-cost.ts: cancel-bundle cost ÷
  // settled cost = 0.195, cancels deduped by spend bundle). Expirations add 0.
  const CANCEL_MULT = 0.20;
  const rows = parseCSV("18-blockspace-by-month.csv");
  const months = rows.map((r) => r.month);
  const pct = rows.map((r) => +r.pct_blockspace);
  const total = pct.map((v) => v * (1 + CANCEL_MULT)); // settled + estimated cancellations
  const hi = 0.8, ticks = [0, 0.2, 0.4, 0.6, 0.8], n = months.length;
  const p = frame("Offer files' share of Chia's COMPUTE capacity", "CLVM cost ÷ per-block cost limit · low by design · NOT transaction-share or actual-block-usage", ticks, 0, hi, (v) => `${v}%`);
  const areaTo = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i, n).toFixed(1)},${yAt(v, 0, hi).toFixed(1)}`).join(" ")
    + ` L${xAt(n - 1, n).toFixed(1)},${M.t + PH} L${xAt(0, n).toFixed(1)},${M.t + PH} Z`;
  // upper band: settled + cancellations (lighter), drawn first/behind
  p.push(`<path d="${areaTo(total)}" fill="${C.orange}" fill-opacity="0.14"/>`);
  p.push(polyline(total, 0, hi, C.orange, 1.5));
  // lower band: settled only (solid), on top
  p.push(`<path d="${areaTo(pct)}" fill="${C.green}" fill-opacity="0.18"/>`);
  p.push(polyline(pct, 0, hi, C.green));
  p.push(legend([{ name: "+ on-chain cancellations (est.)", color: C.orange }, { name: "settled only (measured)", color: C.green }], M.l + 12, M.t + 16));
  const pk = pct.indexOf(Math.max(...pct));
  p.push(`<text x="${xAt(pk, n).toFixed(1)}" y="${(yAt(total[pk], 0, hi) - 6).toFixed(1)}" font-size="10" fill="${C.gray}" text-anchor="middle">peak ~0.53% settled → ~0.64% with cancels</text>`);
  p.push(...xTickLabels(months, 6));
  svg("chart-blockspace", "Offer files use under about 0.65 percent of Chia block capacity at peak: settled offers ~0.5 percent, plus roughly a fifth more from on-chain cancellations", p.join("\n"));
}

// ---- 19. Throughput: completed offers per second (sanity-checks footprint) -
{
  const rows = parseCSV("19-offers-per-second.csv");
  const months = rows.map((r) => r.month);
  const ops = rows.map((r) => +r.offers_per_sec);
  const hi = 0.016, ticks = [0, 0.005, 0.01, 0.015];
  const p = frame("Completed offers per second", "throughput — even at peak, ~1 settled trade per minute", ticks, 0, hi, (v) => v.toFixed(3));
  p.push(polyline(ops, 0, hi, C.blue));
  const pk = ops.indexOf(Math.max(...ops));
  p.push(`<circle cx="${xAt(pk, months.length).toFixed(1)}" cy="${yAt(ops[pk], 0, hi).toFixed(1)}" r="3.5" fill="${C.blue}"/>`);
  p.push(`<text x="${xAt(pk, months.length).toFixed(1)}" y="${(yAt(ops[pk], 0, hi) - 8).toFixed(1)}" font-size="10" fill="${C.blue}" text-anchor="middle">peak ~1 every 69s (${esc(months[pk])})</text>`);
  p.push(...xTickLabels(months, 6));
  svg("chart-throughput", "Completed offers per second peaks around 0.0145 in mid-2025, about one settled trade per minute", p.join("\n"));
}

// ---- 20. What a trade actually costs: three fee streams (XCH) --------------
{
  const rows = parseCSV("20-fee-streams.csv");
  const label: Record<string, string> = {
    "NFT creator royalty": "NFT creator royalty (est.)",
    "dexie service fee (1% Combined Swap)": "dexie 1% service fee (est.)",
    "Blockchain (network) fee": "Blockchain network fee",
  };
  const colour: Record<string, string> = {
    "NFT creator royalty": C.violet,
    "dexie service fee (1% Combined Swap)": "#0987a0",
    "Blockchain (network) fee": C.red,
  };
  const max = Math.max(...rows.map((r) => +r.total_xch));
  const barL = 210, barMax = W - M.r - barL - 70, top = 70, rowH = 62;
  const inner: string[] = [];
  inner.push(`<text x="${M.l - 36}" y="24" font-size="15" font-weight="700" fill="${C.ink}">What a trade actually costs (total fees, all-time)</text>`);
  inner.push(`<text x="${M.l - 36}" y="42" font-size="11" fill="${C.gray}">The blockchain fee everyone thinks about is the smallest of the three by far.</text>`);
  rows.forEach((r, i) => {
    const v = +r.total_xch, y = top + i * rowH, w = Math.max(barMax * v / max, 2);
    inner.push(`<text x="${barL - 10}" y="${y + 21}" font-size="12" fill="${C.ink}" text-anchor="end">${esc(label[r.fee_type] ?? r.fee_type)}</text>`);
    inner.push(`<rect x="${barL}" y="${y}" width="${w.toFixed(1)}" height="32" fill="${colour[r.fee_type] ?? C.gray}" rx="3"/>`);
    inner.push(`<text x="${(barL + w + 8).toFixed(1)}" y="${y + 21}" font-size="12" fill="${C.gray}">${(v).toLocaleString()} XCH</text>`);
  });
  inner.push(`<text x="${M.l - 36}" y="${top + 3 * rowH + 6}" font-size="11" fill="${C.gray}">Estimates (see caption); on ~1.08M XCH of volume. Network fee ≈ 0.01% of volume; royalties ≈ 75× the network fee.</text>`);
  svg("chart-fees", "Total fees by type: NFT royalties about 9,745 XCH, dexie service fee about 2,860, blockchain network fee only about 130", inner.join("\n"));
}

// ---- 21. Liquidity-incentive reward concentration (DBX by top-N makers) ----
{
  const rows = parseCSV("21-reward-concentration.csv");
  const labels = rows.map((r) => `Top ${r.n}`);
  const vals = rows.map((r) => +r.pct_of_rewards);
  const ticks = [0, 25, 50, 75, 100];
  const p = frame("A few market makers earn most of the rewards", "cumulative share of DBX liquidity rewards · 12,712 maker addresses", ticks, 0, 100, (v) => `${v}%`);
  const n = rows.length, bw = PW / n * 0.5;
  rows.forEach((r, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, y = yAt(vals[i], 0, 100);
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - y).toFixed(1)}" fill="#d53f8c" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="12" fill="#d53f8c" text-anchor="middle">${vals[i]}%</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 17}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(labels[i])} makers</text>`);
  });
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${M.t + PH + 36}" font-size="11" fill="${C.gray}" text-anchor="middle">of all DBX liquidity-incentive rewards (2025-08 → 2026-05)</text>`);
  svg("chart-mm-rewards", "Reward concentration: the top market maker earns 19 percent and the top 100 earn 86 percent of liquidity rewards", p.join("\n"));
}

// ---- 23. Market-maker churn vs settled, + the ratio ------------------------
{
  const rows = parseCSV("23-mm-churn.csv");
  const months = rows.map((r) => r.mo);
  const churn = rows.map((r) => +r.reward_offers);
  const comp = rows.map((r) => +r.completed);
  const ratio = rows.map((r) => +r.ratio);
  // Chart A: churn vs settled (counts)
  {
    const hi = 300000, ticks = [0, 100000, 200000, 300000];
    const p = frame("Reward-earning offers vs offers that settled, per month", "reward offers ≈ market-maker churn (99.7% never settle; mostly cancelled/expired)", ticks, 0, hi, (v) => `${v / 1000}k`);
    p.push(polyline(churn, 0, hi, C.orange));
    p.push(polyline(comp, 0, hi, C.green));
    p.push(legend([{ name: "reward-earning (≈ churned)", color: C.orange }, { name: "settled", color: C.green }], M.l + 12, M.t + 16));
    p.push(...xTickLabels(months, 2));
    svg("chart-churn", "Market makers churn 150-280k reward-earning offers a month, dwarfing the 17-39k that settle", p.join("\n"));
  }
  // Chart B: ratio over time
  {
    const hi = 16, ticks = [0, 4, 8, 12, 16];
    const p = frame("Churned offers per settled offer", "ratio of reward-earning (≈ cancelled/expired) to settled offers, by month", ticks, 0, hi, (v) => `${v}×`);
    const mean = ratio.reduce((a, b) => a + b, 0) / ratio.length;
    p.push(`<line x1="${M.l}" y1="${yAt(mean, 0, hi).toFixed(1)}" x2="${W - M.r}" y2="${yAt(mean, 0, hi).toFixed(1)}" stroke="${C.gray}" stroke-width="1" stroke-dasharray="4 3"/>`);
    p.push(`<text x="${W - M.r}" y="${(yAt(mean, 0, hi) - 4).toFixed(1)}" font-size="10" fill="${C.gray}" text-anchor="end">mean ${mean.toFixed(1)}×</text>`);
    p.push(polyline(ratio, 0, hi, C.blue));
    p.push(...xTickLabels(months, 2));
    svg("chart-churn-ratio", "Churned-to-settled ratio hovers around 8 to 9 times in the incentive era", p.join("\n"));
  }
}

// ---- 24. Who's trading: daily rhythm (hour-of-day) → geography + human vs bot -
{
  const rows = parseCSV("24-hour-of-day.csv");
  const hrs = rows.map((r) => +r.hr);
  const nft = rows.map((r) => +r.nft_pct);
  const amm = rows.map((r) => +r.amm_pct);
  const hi = 7, ticks = [0, 2, 4, 6];
  const n = hrs.length;
  const p = frame("When offers are posted (UTC hour)", "share of each group's daily activity · date-found ≈ posting time", ticks, 0, hi, (v) => `${v}%`);
  // shade the Americas/Europe-daytime peak window 14–22 UTC
  const xs = (h: number) => M.l + (h / 23) * PW;
  p.push(`<rect x="${xs(14).toFixed(1)}" y="${M.t}" width="${(xs(22) - xs(14)).toFixed(1)}" height="${PH}" fill="${C.green}" fill-opacity="0.06"/>`);
  p.push(`<text x="${xs(18).toFixed(1)}" y="${M.t + 14}" font-size="10" fill="${C.gray}" text-anchor="middle">Americas daytime · Europe evening</text>`);
  const poly = (vals: number[], color: string, opacity = 1) => `<path d="${vals.map((v, i) => `${i === 0 ? "M" : "L"}${xs(hrs[i]).toFixed(1)},${yAt(v, 0, hi).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-opacity="${opacity}" stroke-linejoin="round"/>`;
  p.push(poly(amm, "#0987a0", 0.35)); // de-emphasised: the bot baseline
  p.push(poly(nft, C.violet));        // the focus: human trading
  // legend (AMM swatch dimmed to match)
  p.push(`<rect x="${M.l + 12}" y="${M.t + 21}" width="14" height="4" rx="2" fill="${C.violet}"/><text x="${M.l + 32}" y="${M.t + 28}" font-size="11" fill="${C.ink}">NFT trades (human)</text>`);
  p.push(`<rect x="${M.l + 12}" y="${M.t + 39}" width="14" height="4" rx="2" fill="#0987a0" fill-opacity="0.35"/><text x="${M.l + 32}" y="${M.t + 46}" font-size="11" fill="${C.gray}">AMM fills (bot)</text>`);
  for (const h of [0, 4, 8, 12, 16, 20]) p.push(`<text x="${xs(h).toFixed(1)}" y="${M.t + PH + 18}" font-size="10" fill="${C.gray}" text-anchor="middle">${String(h).padStart(2, "0")}:00</text>`);
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${M.t + PH + 36}" font-size="11" fill="${C.gray}" text-anchor="middle">trough ~04:00 UTC = Asia daytime / Western night</text>`);
  svg("chart-clock", "Human NFT trading peaks 15-21 UTC (Americas/Europe daytime) and troughs around 4 UTC; the AMM is far flatter, running around the clock", p.join("\n"));
}

// ---- 21. Offers' share of ACTUAL Chia compute, by year (measure 3) ---------
{
  const rows = parseCSV("26-actual-by-year.csv");
  const years = rows.map((r) => r.yr);
  const tot = rows.map((r) => +r.actual_compute_T);
  const off = rows.map((r) => +r.offer_compute_T);
  const share = rows.map((r) => +r.share_pct);
  const hi = 720, ticks = [0, 200, 400, 600];
  const p = frame("Offer files' share of Chia's ACTUAL compute", "sampled total block cost (CLVM) by year · green = offers, grey = rest of chain", ticks, 0, hi, (v) => `${v}T`);
  const n = years.length, bw = PW / n * 0.5;
  rows.forEach((_, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2;
    const yTot = yAt(tot[i], 0, hi), yOff = yAt(off[i], 0, hi);
    p.push(`<rect x="${x.toFixed(1)}" y="${yTot.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - yTot).toFixed(1)}" fill="${C.axis}" fill-opacity="0.35" rx="2"/>`);
    p.push(`<rect x="${x.toFixed(1)}" y="${yOff.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + PH - yOff).toFixed(1)}" fill="${C.green}" rx="2"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(yOff - 6).toFixed(1)}" font-size="11" font-weight="700" fill="${C.green}" text-anchor="middle">${share[i]}%</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${M.t + PH + 16}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(years[i])}</text>`);
  });
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${M.t + 14}" font-size="11" fill="${C.gray}" text-anchor="middle">offers stay flat; the chain's total compute collapses ⇒ offers' share jumps to ~35%</text>`);
  svg("chart-actual-compute", "Offers were about 6 percent of actual Chia compute through 2024, then jumped to about 35 percent in 2025 to 2026 as total chain activity collapsed", p.join("\n"));
}

// ---- 22. How many assets are in one offer (log scale) ---------------------
{
  const rows = parseCSV("27-assets-per-offer.csv");
  const vals = rows.map((r) => +r.offers);
  const logHi = 6; // axis tops at 10^6
  const logY = (v: number) => M.t + PH - (Math.log10(Math.max(v, 1)) / logHi) * PH;
  const fmt = (v: number) => v >= 1000 ? (v / 1000).toFixed(v >= 100000 ? 0 : 1) + "k" : `${v}`;
  const p: string[] = [];
  p.push(`<text x="${M.l}" y="17" font-size="15" font-weight="700" fill="${C.ink}">How many assets are in one offer?</text>`);
  p.push(`<text x="${M.l}" y="34" font-size="11" fill="${C.gray}">log scale · ~90% are a simple 1-for-1 swap, but a tail bundles up to 32 assets in one atomic trade</text>`);
  for (let e = 0; e <= logHi; e++) {
    const y = logY(10 ** e);
    p.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${W - M.r}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    const lab = e === 0 ? "1" : e < 3 ? `${10 ** e}` : `${10 ** (e - 3)}k`.replace("1000k", "1M");
    p.push(`<text x="${M.l - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="${C.gray}" text-anchor="end">${lab === "1000k" ? "1M" : lab}</text>`);
  }
  const n = rows.length, base = M.t + PH, bw = PW / n * 0.62;
  rows.forEach((r, i) => {
    const cx = M.l + (i + 0.5) / n * PW, x = cx - bw / 2, top = logY(vals[i]);
    const spike = r.assets === "5" || r.assets === "11"; // notable bundle-size spikes
    p.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - top).toFixed(1)}" fill="${spike ? C.orange : C.blue}" rx="1.5"/>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${(top - 5).toFixed(1)}" font-size="9.5" fill="${C.gray}" text-anchor="middle">${fmt(vals[i])}</text>`);
    p.push(`<text x="${cx.toFixed(1)}" y="${base + 16}" font-size="11" fill="${C.gray}" text-anchor="middle">${esc(r.assets)}</text>`);
  });
  p.push(`<text x="${(M.l + PW / 2).toFixed(1)}" y="${base + 34}" font-size="11" fill="${C.gray}" text-anchor="middle">assets in the offer (offered + requested legs)</text>`);
  svg("chart-assets-per-offer", "Assets per offer on a log scale: 747k offers have 2 assets, a long tail goes to 32, with spikes at 5 and 11", p.join("\n"));
}

console.log("done.");
