/**
 * Index dexie's Liquidity Incentive Program (DBX rewards for near-market offers).
 *   bun research/dexie-offers/pipeline/crawl-rewards.ts
 *
 * Pulls three things:
 *  - /v1/rewards/stats      → generated/dexie-rewards-stats.json   (totals snapshot)
 *  - /v1/incentives         → generated/dexie-incentives.json      (incentivized pairs + rates/APR)
 *  - /v1/rewards/claims      → generated/dexie-rewards-claims.jsonl (per-offer reward claims;
 *       ~2.25M rows, newest-first, page_size=1000 honored. Each claim has offer_id,
 *       maker_puzzle_hash (!), claimed_amount (DBX), date_claimed, status, id.)
 * Resumable: checkpoints the last completed page in .state.json; dedup by `id`
 * downstream (claims grow at the front while crawling, same as the offers crawl).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "https://dexie.space/v1";
const PAGE_SIZE = 1000;
const OUT = "generated/dexie-rewards-claims.jsonl";
const STATE = "generated/dexie-rewards-claims.state.json";

async function getJson(url: string): Promise<any | null> {
  for (let a = 0; a < 8; a++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 429) { await Bun.sleep((Number(r.headers.get("retry-after")) || 2 ** Math.min(a, 6)) * 1000); continue; }
      return { __http: r.status };
    } catch { await Bun.sleep(1500 * 2 ** Math.min(a, 5)); }
  }
  return null;
}

// --- snapshots (tiny) ---
const stats = await getJson(`${BASE}/rewards/stats`);
if (stats?.success) writeFileSync("generated/dexie-rewards-stats.json", JSON.stringify(stats.stats, null, 2));
const inc = await getJson(`${BASE}/incentives`);
if (inc?.success) writeFileSync("generated/dexie-incentives.json", JSON.stringify(inc.incentives, null, 2));

// --- claims (paged) ---
const first = await getJson(`${BASE}/rewards/claims?page=1&page_size=${PAGE_SIZE}`);
const total = first?.count ?? 0;
const pages = Math.ceil(total / PAGE_SIZE);
console.error(`claims: ${total.toLocaleString()} over ${pages} pages`);

let startPage = 1;
if (existsSync(STATE) && existsSync(OUT)) {
  startPage = (JSON.parse(readFileSync(STATE, "utf8")).lastPage ?? 0) + 1;
  console.error(`resuming at page ${startPage}`);
} else {
  writeFileSync(OUT, ""); // fresh
}

let saved = 0;
for (let page = startPage; page <= pages; page++) {
  const j = page === 1 && startPage === 1 ? first : await getJson(`${BASE}/rewards/claims?page=${page}&page_size=${PAGE_SIZE}`);
  const claims = j?.claims ?? [];
  if (claims.length) { appendFileSync(OUT, claims.map((c: any) => JSON.stringify(c)).join("\n") + "\n"); saved += claims.length; }
  writeFileSync(STATE, JSON.stringify({ lastPage: page, total }));
  if (page % 25 === 0 || page === pages) process.stderr.write(`\rpage ${page}/${pages} · ${saved.toLocaleString()} claims this run`);
  await Bun.sleep(120);
}
console.error(`\ndone: ${saved.toLocaleString()} claims appended → ${OUT}`);
