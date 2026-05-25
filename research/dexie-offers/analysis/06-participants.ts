// 06-participants.ts — Coin-graph connected-component analysis (Thesis O1).
//
// Builds the COIN GRAPH: nodes = offers, an edge links two offers that SHARE a
// coin_id. Coins are single-use, so the only way two settled offers share a coin
// is a CHANGE-CHAIN: offer A settles and emits a change coin; the same wallet
// funds offer B with that change coin -> shared coin id. Connected components
// over this graph therefore approximate "one wallet's sequential offer stream".
//
// CAVEAT baked into the method: some coin_ids are shared by hundreds/thousands of
// offers (max 10,168). A genuine change coin is spent exactly ONCE, so it can link
// at most 2 offers. High-multiplicity coins are structural artifacts (recurring
// settlement / singleton / contract / AMM-pool coins) and would collapse the whole
// graph into one giant blob. We therefore EXCLUDE any coin shared by more than
// MAX_MULT offers as an edge generator (default 2 = the strict change-chain reading;
// we also report sensitivity at higher caps).
//
// Reproducible: reads generated/coins.parquet via the duckdb CLI, does union-find
// in-process, prints component statistics + emits CSVs to research/dexie-offers/findings/data/.
//
// Run: bun research/dexie-offers/analysis/06-participants.ts [MAX_MULT]
//   bun research/dexie-offers/analysis/06-participants.ts 2     (strict change-chain, default)
//   bun research/dexie-offers/analysis/06-participants.ts 5     (looser; sensitivity)

import { $ } from "bun";

const DB = "generated/offers.duckdb";
const DUCKDB = "./tools/duckdb";
const DATA_DIR = "research/dexie-offers/findings/data";

const MAX_MULT = Number(process.argv[2] ?? 2); // max offers a coin may link to count as an edge

// ---- 1. Pull (coin_id, offer_id) pairs ONLY for coins shared by 2..MAX_MULT offers.
// Single-use coins (mult=1) generate no edge; hub coins (mult>MAX_MULT) excluded.
console.error(`[06] MAX_MULT=${MAX_MULT}: pulling shared-coin edges from ${DB} ...`);
const edgeRows = await $`${DUCKDB} -readonly ${DB} -noheader -list -c ${`
  WITH mult AS (
    SELECT coin_id, count(DISTINCT offer_id) AS k
    FROM coins GROUP BY coin_id
    HAVING k BETWEEN 2 AND ${MAX_MULT}
  )
  SELECT c.coin_id, c.offer_id
  FROM coins c JOIN mult m USING (coin_id)
  ORDER BY c.coin_id
`}`.text();

// ---- 2. Union-find over offers. Group offer_ids by coin_id, union them.
const parent = new Map<string, string>();
function find(x: string): string {
  let r = x;
  while (parent.get(r) !== r && parent.get(r) !== undefined) r = parent.get(r)!;
  // path compression
  let c = x;
  while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
  return r;
}
function ensure(x: string) { if (!parent.has(x)) parent.set(x, x); }
function union(a: string, b: string) {
  ensure(a); ensure(b);
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
}

let curCoin = "";
let curOffers: string[] = [];
let nEdges = 0;
function flush() {
  if (curOffers.length >= 2) {
    const a = curOffers[0];
    for (let i = 1; i < curOffers.length; i++) { union(a, curOffers[i]); nEdges++; }
  }
}
for (const line of edgeRows.split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("|"); // -list uses '|' separator
  const coin = line.slice(0, tab);
  const offer = line.slice(tab + 1);
  if (coin !== curCoin) { flush(); curCoin = coin; curOffers = []; }
  curOffers.push(offer);
}
flush();

const linkedOffers = parent.size;
console.error(`[06] linked offers (in any non-trivial component): ${linkedOffers.toLocaleString()}`);

// ---- 3. Component sizes (in # of offers).
const compSize = new Map<string, number>();
for (const off of parent.keys()) {
  const r = find(off);
  compSize.set(r, (compSize.get(r) ?? 0) + 1);
}
const sizes = [...compSize.values()].sort((a, b) => b - a);
const nComponents = sizes.length;
const totalOffers = 833145; // snapshot constant (offers table)

const inComponents = sizes.reduce((a, b) => a + b, 0);
const singletonOffers = totalOffers - inComponents; // offers not linked to anything

console.error(`[06] non-trivial components: ${nComponents.toLocaleString()}`);
console.error(`[06] offers in components: ${inComponents.toLocaleString()} (${(100*inComponents/totalOffers).toFixed(2)}%)`);
console.error(`[06] unlinked (singleton) offers: ${singletonOffers.toLocaleString()}`);

// "Participant" lower-bound estimate: every singleton offer = its own potential
// wallet; every component = one wallet. So implied distinct linkage-clusters:
const impliedClusters = nComponents + singletonOffers;

// ---- 4. Component-size distribution.
function bucket(n: number): string {
  if (n === 2) return "2";
  if (n <= 5) return "3-5";
  if (n <= 10) return "6-10";
  if (n <= 50) return "11-50";
  if (n <= 100) return "51-100";
  if (n <= 500) return "101-500";
  return "500+";
}
const dist = new Map<string, { n_comp: number; n_off: number }>();
for (const s of sizes) {
  const b = bucket(s);
  const e = dist.get(b) ?? { n_comp: 0, n_off: 0 };
  e.n_comp++; e.n_off += s; dist.set(b, e);
}
const order = ["2", "3-5", "6-10", "11-50", "51-100", "101-500", "500+"];

// ---- 5. Concentration: share of LINKED offers in the largest N components.
function topShare(n: number) {
  const top = sizes.slice(0, n).reduce((a, b) => a + b, 0);
  return { offers: top, pctOfLinked: 100 * top / inComponents, pctOfAll: 100 * top / totalOffers };
}

// ---- 6. Emit summary + CSVs.
const summaryLines: string[] = [];
summaryLines.push(`max_mult=${MAX_MULT}`);
summaryLines.push(`total_offers=${totalOffers}`);
summaryLines.push(`edges=${nEdges}`);
summaryLines.push(`linked_offers=${inComponents}`);
summaryLines.push(`singleton_offers=${singletonOffers}`);
summaryLines.push(`n_components=${nComponents}`);
summaryLines.push(`implied_min_clusters=${impliedClusters}`);
summaryLines.push(`largest_component=${sizes[0]}`);
summaryLines.push(`median_component_size=${sizes[Math.floor(sizes.length/2)]}`);
summaryLines.push(`top1_share_of_all_pct=${topShare(1).pctOfAll.toFixed(3)}`);
summaryLines.push(`top10_share_of_linked_pct=${topShare(10).pctOfLinked.toFixed(2)}`);
summaryLines.push(`top100_share_of_linked_pct=${topShare(100).pctOfLinked.toFixed(2)}`);

console.log("\n=== SUMMARY (MAX_MULT=" + MAX_MULT + ") ===");
console.log(summaryLines.join("\n"));

console.log("\n=== component-size distribution ===");
console.log("bucket\tn_components\tn_offers");
for (const b of order) {
  const e = dist.get(b); if (!e) continue;
  console.log(`${b}\t${e.n_comp}\t${e.n_off}`);
}

console.log("\n=== concentration (share of LINKED offers in top-N components) ===");
for (const n of [1, 5, 10, 50, 100, 500]) {
  const t = topShare(n);
  console.log(`top${n}\toffers=${t.offers}\tpct_of_linked=${t.pctOfLinked.toFixed(2)}\tpct_of_all=${t.pctOfAll.toFixed(3)}`);
}

// CSVs (only emit at default cap to avoid clobbering)
if (MAX_MULT === 2) {
  const distCsv = ["bucket,n_components,n_offers",
    ...order.filter(b => dist.get(b)).map(b => { const e = dist.get(b)!; return `${b},${e.n_comp},${e.n_off}`; })].join("\n");
  await Bun.write(`${DATA_DIR}/06-participants-component-dist.csv`, distCsv + "\n");

  const concCsv = ["top_n,offers,pct_of_linked,pct_of_all",
    ...[1,5,10,50,100,500].map(n => { const t = topShare(n); return `${n},${t.offers},${t.pctOfLinked.toFixed(3)},${t.pctOfAll.toFixed(4)}`; })].join("\n");
  await Bun.write(`${DATA_DIR}/06-participants-concentration.csv`, concCsv + "\n");

  console.error(`[06] wrote component-dist + concentration CSVs to ${DATA_DIR}/`);
}
