/**
 * How many offer files exist in each lifecycle state? Our analysis dump is
 * status=4 (settled) ONLY — this checks the denominator by reading the API's
 * total `count` per status (one tiny request each; no records downloaded).
 *
 *   bun research/dexie-offers/pipeline/status-counts.ts
 *
 * dexie status enum (confirmed by inspecting a sample offer's date/spent fields):
 *   0 Active/open · 1 Pending · 2 Cancelling · 3 Cancelled · 4 Completed
 *   5 Unknown · 6 Expired   (1/2/5 are transient → ~0 at any snapshot)
 * NOTE: status=0 (Active) is a live SNAPSHOT (stock); Completed/Expired/Cancelled
 * are cumulative since 2022 (flow). Don't add a stock to flows naively.
 */
const BASE = "https://api.dexie.space/v1/offers";
const LABEL: Record<number, string> = {
  0: "Active/open", 1: "Pending", 2: "Cancelling", 3: "Cancelled",
  4: "Completed (settled)", 5: "Unknown", 6: "Expired",
};
async function count(status: number): Promise<number | string> {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${BASE}?status=${status}&page=1&page_size=1`);
    if (r.ok) { const j = await r.json(); return j?.success ? j.count : "(apiErr)"; }
    if (r.status === 429) { await Bun.sleep(2000 * (a + 1)); continue; }
    return `(HTTP ${r.status})`;
  }
  return "(giveup)";
}
for (let s = 0; s <= 6; s++) {
  const c = await count(s);
  console.log(`status=${s}`.padEnd(10), (LABEL[s] ?? "?").padEnd(22), typeof c === "number" ? c.toLocaleString() : c);
  await Bun.sleep(250);
}
