/**
 * Measure the on-chain block-space cost of CANCELLED offers (status=3), to size
 * how much the settled-only footprint chart undercounts. Cancellations are batched
 * (many offers per spend bundle), so we dedup by mempool.id and sum DISTINCT bundle
 * costs. dexie prunes/caps status=3 at the newest ~10k, so this is a recent window;
 * we compute the cancel-cost ÷ settled-cost ratio in that same window.
 *   bun research/dexie-offers/analysis/25-cancel-cost.ts
 */
import { appendFileSync, writeFileSync } from "node:fs";
const BASE = "https://api.dexie.space/v1/offers";
const OUT = "generated/dexie-cancels.jsonl";
writeFileSync(OUT, "");
let saved = 0;
for (let page = 1; page <= 100; page++) { // page_size clamps to 100 → max 10k
  let j: any = null;
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${BASE}?status=3&page_size=100&page=${page}&sort=date_completed`);
    if (r.ok) { j = await r.json(); break; }
    if (r.status === 429) { await Bun.sleep(2000 * (a + 1)); continue; }
    break;
  }
  const offers = j?.offers ?? [];
  if (!offers.length) break;
  appendFileSync(OUT, offers.map((o: any) => JSON.stringify({
    id: o.id, mempool_id: o.mempool?.id ?? null, cost: o.mempool?.cost ?? null,
    combined: o.mempool?.combined ?? null, date_completed: o.date_completed,
    spent_block_index: o.spent_block_index,
  })).join("\n") + "\n");
  saved += offers.length;
  if (page % 10 === 0) process.stderr.write(`\rpage ${page} · ${saved} cancels`);
  await Bun.sleep(150);
}
console.error(`\nwrote ${saved} cancelled offers → ${OUT}`);
