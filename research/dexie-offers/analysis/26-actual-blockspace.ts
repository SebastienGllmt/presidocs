/**
 * Measure (3): offer files' share of Chia's ACTUAL compute (not the theoretical
 * 11e9/block limit). For each month we sample K random block heights, fetch each
 * block's real CLVM cost from coinset (transactions_info.cost; 0 for non-tx
 * blocks), estimate that month's total compute = mean(sampled cost) x blocks, and
 * divide the month's offer CLVM cost by it.
 *
 *   K=30 bun research/dexie-offers/analysis/26-actual-blockspace.ts        # sample size per month
 *
 * coinset path is 2 calls/block: get_block_record_by_height -> header_hash ->
 * get_block -> transactions_info.cost. Heights are cached in
 * generated/block-costs.jsonl so re-runs (and bigger K) only fetch new heights.
 * Rate limit unknown -> small concurrency + exponential backoff on 429/5xx.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://api.coinset.org";
const K = Number(process.env.K) || 30;
const CONC = Number(process.env.CONC) || 4;
const CACHE = "generated/block-costs.jsonl";
const IN = "research/dexie-offers/findings/data/26-month-input.csv";
const OUT = "research/dexie-offers/findings/data/26-actual-usage.csv";

// --- cache: height -> cost (CLVM) ---
const cache = new Map<number, number>();
if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").trim().split("\n")) {
  if (!l) continue; const o = JSON.parse(l); cache.set(o.h, o.c);
}
console.error(`cache: ${cache.size} block costs`);

async function post(path: string, body: any): Promise<any> {
  for (let a = 0; a < 8; a++) {
    try {
      const r = await fetch(`${API}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await Bun.sleep(400 * 2 ** a + Math.random() * 200); continue; }
      return null; // 4xx other than 429 -> give up on this one
    } catch { await Bun.sleep(400 * 2 ** a); }
  }
  return null;
}
async function costForHeight(h: number): Promise<number | null> {
  if (cache.has(h)) return cache.get(h)!;
  const rec = await post("get_block_record_by_height", { height: h });
  const hh = rec?.block_record?.header_hash;
  if (!hh) return null;
  const blk = await post("get_block", { header_hash: hh });
  if (!blk?.success) return null;
  const cost = blk.block?.transactions_info?.cost ?? 0; // non-tx block -> 0
  cache.set(h, cost);
  appendFileSync(CACHE, JSON.stringify({ h, c: cost }) + "\n");
  return cost;
}
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

const rows = readFileSync(IN, "utf8").trim().split("\n").slice(1).map((l) => {
  const [month, min_h, max_h, blocks, offer] = l.split(",");
  return { month, min_h: +min_h, max_h: +max_h, blocks: +blocks, offer: +offer };
});

const out: string[] = ["month,sampled,mean_block_cost,blocks,actual_compute,offer_cost,share_pct"];
let totOffer = 0, totActual = 0;
for (const m of rows) {
  // K distinct random heights in [min_h, max_h]
  const want = Math.min(K, m.max_h - m.min_h);
  const hs = new Set<number>();
  while (hs.size < want) hs.add(m.min_h + Math.floor(Math.random() * (m.max_h - m.min_h + 1)));
  const heights = [...hs];
  const costs: number[] = [];
  await pool(heights, CONC, async (h) => { const c = await costForHeight(h); if (c !== null) costs.push(c); });
  const mean = costs.reduce((s, c) => s + c, 0) / (costs.length || 1);
  const actual = mean * m.blocks;
  const share = 100 * m.offer / actual;
  totOffer += m.offer; totActual += actual;
  out.push(`${m.month},${costs.length},${Math.round(mean)},${m.blocks},${Math.round(actual)},${m.offer},${share.toFixed(2)}`);
  process.stderr.write(`\r${m.month}: mean ${(mean / 1e6).toFixed(0)}M/block, share ${share.toFixed(1)}%   `);
}
writeFileSync(OUT, out.join("\n") + "\n");
console.error(`\nGLOBAL: offers were ${(100 * totOffer / totActual).toFixed(2)}% of actual Chia compute (sampled). cache now ${cache.size}.`);
console.error(`wrote ${OUT}`);
