// Offline aggregation: turn the local crawls into the small WEEKLY series that
// posts/offer-files.html bakes inline for its tabbed chart. We ship ~100 points
// per series, never the ~982k raw swaps.
//
// Inputs (whichever exist):
//   generated/dexie-all-daily.json    — full crawl {total, usdCount, days:[{d,nAll,nUsd,vu}]}
//   generated/dexie-xch-usdc-daily.json — XCH/USDC pair {…, days:[{d,p,n,vu}]} (price + fallback)
//
// If the full crawl isn't ready yet, falls back to the XCH/USDC pair for the
// swap-count / volume series and prints a loud INTERIM warning (numbers will be
// the single-pair subset, not all-asset, until the crawl lands).
//
// Output: re-injects the aggregate into the post's inline <script id="dexie-xch-usdc">.
// Run: bun research/dexie-offers/charts/aggregate-charts.ts

const ALL_PATH = "generated/dexie-all-daily.json";
const PRICE_PATH = "generated/dexie-xch-usdc-daily.json";
const POST = "posts/offer-files.html";
const FALLBACK_TOTAL = 982599;

interface DayAll { d: string; nAll: number; nUsd: number; vu: number }
interface DayPrice { d: string; p: number; n: number; vu: number }

async function loadJson<T>(p: string): Promise<T | null> {
  const f = Bun.file(p);
  if (!(await f.exists())) return null;
  try {
    const txt = await f.text();
    return txt.trim() ? (JSON.parse(txt) as T) : null; // empty mid-crawl → not ready
  } catch {
    return null; // partial/invalid JSON → treat as not ready
  }
}

function monday(dateStr: string): string {
  const dt = new Date(dateStr + "T00:00:00Z");
  const day = dt.getUTCDay(); // 0=Sun
  dt.setUTCDate(dt.getUTCDate() - (day === 0 ? 6 : day - 1));
  return dt.toISOString().slice(0, 10);
}
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const all = await loadJson<{ total: number; usdCount: number; days: DayAll[] }>(ALL_PATH);
const priceDs = await loadJson<{ days: DayPrice[]; totalAllAssets?: number }>(PRICE_PATH);
const priceDays = priceDs?.days ?? [];
const priceByDay = new Map(priceDays.map((d) => [d.d, d.p]));

let countDays: { d: string; nAll: number; vu: number }[];
let totalAllAssets: number;
let usdCount: number;
const interim = !(all && all.days?.length);

if (!interim) {
  countDays = all!.days.map((d) => ({ d: d.d, nAll: d.nAll, vu: d.vu }));
  totalAllAssets = all!.total;
  usdCount = all!.usdCount;
} else {
  process.stderr.write("⚠️  INTERIM: full crawl not found — using XCH/USDC pair only for swap counts & volume (placeholder).\n");
  countDays = priceDays.map((d) => ({ d: d.d, nAll: d.n, vu: d.vu }));
  totalAllAssets = priceDs?.totalAllAssets ?? FALLBACK_TOTAL;
  usdCount = priceDays.reduce((s, d) => s + d.n, 0);
}

// Weekly buckets.
const buckets = new Map<string, { nAll: number; vu: number; ps: number[] }>();
for (const row of countDays) {
  const w = monday(row.d);
  const b = buckets.get(w) ?? { nAll: 0, vu: 0, ps: [] };
  b.nAll += row.nAll;
  b.vu += row.vu;
  const p = priceByDay.get(row.d);
  if (p) b.ps.push(p);
  buckets.set(w, b);
}
// Make sure weeks with no count row but a price still carry price (rare); skip for simplicity.

const weeks = [...buckets.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([w, b]) => ({ w, nAll: b.nAll, vu: Math.round(b.vu), p: Number(median(b.ps).toFixed(2)) }));

const dataset = { totalAllAssets, usdCount, asOf: countDays.at(-1)?.d ?? "", interim, weeks };
const blob = JSON.stringify(dataset);

const html = await Bun.file(POST).text();
const re = /(id="dexie-xch-usdc">)(\[.*?\]|\{.*?\})(<\/script>)/s;
if (!re.test(html)) throw new Error("inline data <script id=dexie-xch-usdc> not found in post");
await Bun.write(POST, html.replace(re, `$1${blob}$3`));

process.stderr.write(
  `${interim ? "[INTERIM] " : ""}injected: ${weeks.length} weeks · total ${totalAllAssets.toLocaleString()} · usd ${usdCount.toLocaleString()} (${((usdCount / totalAllAssets) * 100).toFixed(1)}%) · ${blob.length} bytes\n`,
);
