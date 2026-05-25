// One-off authoring data pull: XCH <> wUSDC.b settled trades from dexie's
// public API, aggregated to a daily series for baking inline into
// posts/offer-files.html (the prod CSP forbids a runtime fetch).
//
// Each *completed* offer (status=4) is one settled trade. We query both
// directions, normalize every trade to USDC-per-XCH, and aggregate per UTC
// day. Daily price is the MEDIAN of per-trade prices (robust to the junk/spam
// offers anyone can post, e.g. 1 XCH for $0.32). We also keep daily trade
// count and USD volume for the activity bars.
//
// Run: bun research/dexie-offers/pipeline/pull-dexie-xch-usdc.ts > generated/dexie-xch-usdc-daily.json

const BASE = "https://api.dexie.space/v1";
const PAGE_SIZE = 100; // hard cap on the API

interface Leg { id: string; code: string; amount: number }
interface Offer {
  date_completed: string | null;
  offered: Leg[];
  requested: Leg[];
}
interface Trade { ts: number; day: string; usdcPerXch: number; xch: number; usd: number }

async function fetchPage(offered: string, requested: string, page: number): Promise<{ offers: Offer[]; count: number }> {
  const url = `${BASE}/offers?offered=${offered}&requested=${requested}&status=4&compact=true&page_size=${PAGE_SIZE}&page=${page}&sort=date_completed`;
  for (let attempt = 0; attempt < 7; attempt++) {
    const r = await fetch(url);
    if (r.ok) {
      const j = (await r.json()) as { success: boolean; offers?: Offer[]; count?: number };
      if (j.success) return { offers: j.offers ?? [], count: j.count ?? 0 };
      process.stderr.write(`  page ${page}: success=false body\n`);
    } else {
      const retryAfter = Number(r.headers.get("retry-after")) || 0;
      process.stderr.write(`  page ${page}: HTTP ${r.status}${retryAfter ? ` retry-after=${retryAfter}s` : ""}\n`);
      if (retryAfter) { await Bun.sleep(retryAfter * 1000); continue; }
    }
    await Bun.sleep(2000 * 2 ** attempt); // exponential backoff: 2s,4s,8s,16s,32s,64s
  }
  throw new Error(`failed page ${page} for ${offered}->${requested}`);
}

function legBy(legs: Leg[], code: string): Leg | undefined {
  return legs.find((l) => l.code === code || (code === "XCH" && l.id === "xch"));
}

async function pullDirection(offered: string, requested: string, out: Trade[]): Promise<void> {
  const first = await fetchPage(offered, requested, 1);
  const total = first.count;
  const pages = Math.ceil(total / PAGE_SIZE);
  process.stderr.write(`${offered} -> ${requested}: ${total} trades, ${pages} pages\n`);
  for (let page = 1; page <= pages; page++) {
    const { offers } = page === 1 ? first : await fetchPage(offered, requested, page);
    if (!offers.length) break;
    for (const o of offers) {
      if (!o.date_completed) continue;
      const xchLeg = legBy([...o.offered, ...o.requested], "XCH");
      const usdLeg = legBy([...o.offered, ...o.requested], "wUSDC.b");
      if (!xchLeg || !usdLeg || !xchLeg.amount || !usdLeg.amount) continue;
      const usdcPerXch = usdLeg.amount / xchLeg.amount;
      if (!isFinite(usdcPerXch) || usdcPerXch <= 0) continue;
      const ts = Date.parse(o.date_completed);
      out.push({ ts, day: o.date_completed.slice(0, 10), usdcPerXch, xch: xchLeg.amount, usd: usdLeg.amount });
    }
    if (page % 20 === 0) process.stderr.write(`  …page ${page}/${pages}\n`);
    await Bun.sleep(450); // stay under dexie's rate limit
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Platform-wide completed-offer count across EVERY asset pair (the headline
// adoption number). One request: the unfiltered status=4 query reports a global
// `count`. This dwarfs the single-pair count because most swaps aren't against
// a USD asset — which is exactly why we surface it alongside the legible pair.
async function fetchGlobalCount(): Promise<number> {
  const r = await fetch(`${BASE}/offers?status=4&page_size=1`);
  const j = (await r.json()) as { success: boolean; count?: number };
  return j.success ? (j.count ?? 0) : 0;
}

const trades: Trade[] = [];
await pullDirection("XCH", "wUSDC.b", trades);
await pullDirection("wUSDC.b", "XCH", trades);
const totalAllAssets = await fetchGlobalCount();
process.stderr.write(`collected ${trades.length} trades; ${totalAllAssets} completed offers across all assets\n`);

// Aggregate by UTC day.
const byDay = new Map<string, Trade[]>();
for (const t of trades) {
  const arr = byDay.get(t.day) ?? [];
  arr.push(t);
  byDay.set(t.day, arr);
}

const series = [...byDay.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([day, ts]) => ({
    d: day,
    p: Number(median(ts.map((t) => t.usdcPerXch)).toFixed(4)), // robust daily price
    n: ts.length, // trade count
    vu: Number(ts.reduce((s, t) => s + t.usd, 0).toFixed(2)), // USD volume
  }));

process.stderr.write(`${series.length} days, ${series[0]?.d} … ${series[series.length - 1]?.d}\n`);
process.stdout.write(
  JSON.stringify({
    totalAllAssets, // platform-wide completed swaps (every asset pair)
    pair: "XCH / wUSDC.b", // the legible USD pair detailed below
    asOf: series[series.length - 1]?.d ?? null,
    days: series, // daily {d, p (median USDC/XCH), n (count), vu (USD volume)}
  }),
);
