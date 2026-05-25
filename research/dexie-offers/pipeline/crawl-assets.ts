/**
 * Fetch the full dexie asset registry (CAT metadata) so we can classify tokens
 * by their real `description`, not by guessing from tickers/names.
 *
 *   bun research/dexie-offers/pipeline/crawl-assets.ts
 *
 * This is a SMALL one-time pull (~3k assets, ~31 pages) over /v1/assets — wholly
 * separate from the 2.9 GB offers crawl, so the "don't re-hit the API" rule for
 * the offer dump doesn't apply. We store the COMPLETE record per asset (id, code,
 * name, description, is_nft, verifications, …) — there are few enough tokens that
 * keeping everything is cheap, and we'd rather not discard a field we want later.
 * Output: generated/dexie-assets.jsonl (one raw JSON asset per line).
 */
import { appendFileSync, existsSync, rmSync } from "node:fs";

const BASE = "https://api.dexie.space/v1";
const PAGE_SIZE = 100;
const OUT = "generated/dexie-assets.jsonl";

async function getPage(page: number): Promise<any[] | null> {
  const url = `${BASE}/assets?page_size=${PAGE_SIZE}&page=${page}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (j?.success && Array.isArray(j.assets)) return j.assets;
        return []; // success but no assets → end
      }
      if (r.status === 429) {
        const wait = (Number(r.headers.get("retry-after")) || 2 ** Math.min(attempt, 6)) * 1000;
        console.error(`  429 on page ${page} — backing off ${Math.round(wait / 1000)}s`);
        await Bun.sleep(wait);
        continue;
      }
      console.error(`  HTTP ${r.status} on page ${page} — stopping`);
      return null;
    } catch (e) {
      await Bun.sleep(1500 * 2 ** Math.min(attempt, 5)); // network blip
    }
  }
  return null;
}

if (existsSync(OUT)) rmSync(OUT); // fresh each run; it's tiny
let total = 0;
for (let page = 1; page <= 1000; page++) {
  const assets = await getPage(page);
  if (assets === null) { console.error("aborting (hard error)"); break; }
  if (assets.length === 0) { console.error(`page ${page}: empty — done`); break; }
  appendFileSync(OUT, assets.map((a) => JSON.stringify(a)).join("\n") + "\n");
  total += assets.length;
  process.stderr.write(`\rpage ${page} · ${total} assets saved`);
  if (assets.length < PAGE_SIZE) { console.error(`\npage ${page}: short page — done`); break; }
  await Bun.sleep(120); // be polite
}
console.error(`\nwrote ${total} assets → ${OUT}`);
