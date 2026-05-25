// Full historical dump of dexie completed offers, WORKING AROUND the API's hard
// pagination ceiling.
//
// The problem: GET /v1/offers caps pagination at page 100 with page_size clamped
// to 100 — so any single query returns at most the NEWEST 10,000 records
// ("Max page is 100." beyond that). There are ~982k completed offers and the ONLY
// honored filters are offered / requested / status; sort is date-descending only.
// No date range, no price/amount, no ascending sort (all silently ignored). So a
// single (offered, requested, status) triple is hard-capped at its newest 10k.
//
// The workaround: partition by the offered/requested asset filters so each slice
// is < 10k, then page within each slice.
//
//   Level 1 — offered=A for every asset A in a COMPLETE universe:
//             /v1/assets (CATs)  ∪  {xch}  ∪  every asset in /v1/pairs.
//             (xch is the native coin and is NOT in /v1/assets — missing it drops
//             every offer that OFFERS XCH, ~222k records. That was the bug.)
//   Level 2 — if offered=A has > 10k, page its newest 10k AND collect the requested
//             assets that actually appear in that data, then sub-split by
//             requested=B over those discovered partners ∪ the /v1/pairs co-trade
//             map. (Driving the split off /v1/pairs ALONE was the second bug: many
//             overflow assets aren't listed there, so they were split into nothing
//             and saved zero records.)
//   Level 3 — if a fixed pair A→B STILL has > 10k, we keep its newest 10k; the
//             oldest (count-10k) are genuinely unreachable via this API (they live
//             only on the Chia blockchain). We log them so the loss is explicit.
//
// Duplicates are expected (multi-leg offers; the mixed newest-10k of an overflow
// asset overlaps its per-B sub-queries). Every record carries a stable `id`, so
// dedup is done DOWNSTREAM, where aggregate-charts.ts reads this dump.
//
// Resumable: each completed query is checkpointed; re-run to continue. Ctrl+C
// saves state and exits. Adaptive pacing eases down on 429 and back up when calm.
//
// This is the ONLY dexie crawler — it dumps the raw offers; all slicing/aggregation
// happens off the local dump (so we never re-hit the API to re-slice).
//
// Run (fresh):  bun research/dexie-offers/pipeline/crawl-dexie.ts
// Resume:       bun research/dexie-offers/pipeline/crawl-dexie.ts                       (same command)
// Top up an existing dump from an earlier run, fetching only what's missing and
// appending (keeps the existing .jsonl):
//               PATCH=1 bun research/dexie-offers/pipeline/crawl-dexie.ts
// Completeness pass: for every overflow asset, sub-query requested=B over the
// WHOLE universe to recover old partners that the default newest-10k partner
// discovery misses. Slower (probes every asset's count) but pushes coverage to
// the API ceiling. Appends to the existing dump:
//               FULL=1 bun research/dexie-offers/pipeline/crawl-dexie.ts
// Fresh start:  rm generated/dexie-offers-full.jsonl generated/dexie-offers-full.state.json
// Scoped test:  LIMIT_ASSETS=20 bun research/dexie-offers/pipeline/crawl-dexie.ts

import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const BASE = "https://api.dexie.space/v1";
const PAGE_SIZE = 100;
const MAX_PAGE = 100; // dexie's hard cap → 10,000 records per query
const HARD_CAP = MAX_PAGE * PAGE_SIZE; // 10,000
const DUMP = process.env.DUMP || "generated/dexie-offers-full.jsonl";
const STATE = process.env.STATE || "generated/dexie-offers-full.state.json";

const DELAY_MIN = 60;
const DELAY_MAX = 5000;
const EASE_AFTER = 60;
const LIMIT_ASSETS = Number(process.env.LIMIT_ASSETS) || 0; // 0 = all
const PATCH = process.env.PATCH === "1";
const FULL = process.env.FULL === "1"; // completeness pass (see header)

interface Query { o: string; r?: string }
interface Overflow { o: string; r?: string; count: number; missed: number }
interface State {
  seeded: boolean;
  patched?: boolean; // true once the PATCH=1 top-up has been seeded (so resume skips it)
  fulled?: boolean; // true once the FULL=1 completeness pass has been seeded
  universe?: string[]; // every asset id we partition over (persisted for FULL/resume)
  coTrade: Record<string, string[]>; // asset id → co-traded asset ids (from /v1/pairs)
  queue: Query[];
  doneKeys: string[];
  saved: number;
  overflows: Overflow[];
  startedAt: number;
}

let delayMs = 150;
let okStreak = 0;
let total429 = 0;

const keyOf = (q: Query) => `${q.o}|${q.r ?? ""}`;

function loadState(): State | null {
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(readFileSync(STATE, "utf8")) as State; } catch { return null; }
}
function saveState(s: State): void { writeFileSync(STATE, JSON.stringify(s)); }

function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}

function logLine(msg: string): void { process.stdout.write("\r\x1b[K" + msg + "\n"); }

let lastPaint = 0;
function paint(s: State, qDone: number, qTotal: number, sessStart: number, force = false): void {
  const now = Date.now();
  if (!force && now - lastPaint < 250) return;
  lastPaint = now;
  const elapsed = (now - sessStart) / 1000;
  const rate = qDone / Math.max(0.001, elapsed);
  const eta = (qTotal - qDone) / Math.max(0.0001, rate);
  const pct = qTotal ? ((qDone / qTotal) * 100).toFixed(1) : "0.0";
  process.stdout.write(
    `\r\x1b[K[${pct}%] query ${qDone}/${qTotal} · ${s.saved.toLocaleString()} recs · ` +
    `${s.queue.length} queued · ${rate.toFixed(1)} q/s · ETA ${fmtDur(eta)} · ` +
    `429s:${total429} · pace ${Math.round(delayMs)}ms`,
  );
}

// Fetch one URL: parsed JSON on success, a tagged marker on 429, or a permanent error.
async function getJson(url: string): Promise<any | null> {
  const r = await fetch(url);
  if (r.ok) { const j = await r.json(); return j?.success ? j : { __apiError: true }; }
  if (r.status === 429) {
    total429++; okStreak = 0;
    delayMs = Math.min(DELAY_MAX, delayMs + 300);
    return { __rateLimited: true, retryAfter: Number(r.headers.get("retry-after")) || 0 };
  }
  let body: any = null; try { body = await r.json(); } catch { /* ignore */ }
  return { __httpError: r.status, message: body?.error_message };
}

// Fetch a page with adaptive retry/backoff; null on giveup. Permanent 4xx → no retry.
async function fetchPage(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 12; attempt++) {
    let res: any = null;
    try { res = await getJson(url); } catch { /* network blip */ }
    if (Array.isArray(res?.offers)) {
      okStreak++;
      if (okStreak >= EASE_AFTER && delayMs > DELAY_MIN) { delayMs = Math.max(DELAY_MIN, Math.round(delayMs * 0.85)); okStreak = 0; }
      return res;
    }
    if (res?.__httpError && !res.__rateLimited) {
      logLine(`✗ HTTP ${res.__httpError}${res.message ? ` (${res.message})` : ""} — not retrying: ${url.slice(BASE.length)}`);
      return null;
    }
    const backoff = res?.retryAfter ? res.retryAfter * 1000 : Math.min(120000, 1500 * 2 ** Math.min(attempt, 6));
    if (res?.__rateLimited) logLine(`⚠ 429 — backing off ${fmtDur(backoff / 1000)}; pace now ${Math.round(delayMs)}ms`);
    await Bun.sleep(backoff);
  }
  return null;
}

function offersUrl(q: Query, page: number): string {
  let u = `${BASE}/offers?status=4&page_size=${PAGE_SIZE}&page=${page}&sort=date_completed&offered=${q.o}`;
  if (q.r) u += `&requested=${q.r}`;
  return u;
}

const saveOffers = (offers: any[]) => {
  if (offers.length) { appendFileSync(DUMP, offers.map((o) => JSON.stringify(o)).join("\n") + "\n"); state.saved += offers.length; }
};

// Result of paging one query.
interface QResult { count: number; overflowed: boolean; partners?: Set<string> }

// Page through a query, saving everything reachable (≤ newest 10k). For an
// offered-only query we ALSO collect the requested assets seen, so the caller can
// sub-split. Returns null on giveup (so the caller can re-queue).
async function runQuery(q: Query): Promise<QResult | null> {
  const partners = q.r ? undefined : new Set<string>();
  const collect = (offers: any[]) => {
    if (!partners) return;
    for (const o of offers) for (const leg of o.requested ?? []) if (leg?.id) partners.add(leg.id);
  };

  const first = await fetchPage(offersUrl(q, 1));
  if (!first) return null;
  const count: number = first.count ?? 0;
  if (count === 0) return { count: 0, overflowed: false };

  saveOffers(first.offers); collect(first.offers);
  const lastPage = Math.min(MAX_PAGE, Math.ceil(count / PAGE_SIZE));
  for (let p = 2; p <= lastPage; p++) {
    const j = await fetchPage(offersUrl(q, p));
    if (!j) return null;
    saveOffers(j.offers); collect(j.offers);
    if (j.offers.length < PAGE_SIZE) break;
    await Bun.sleep(delayMs);
  }
  return { count, overflowed: count > HARD_CAP, partners };
}

// ---- one-time setup: complete asset universe + co-trade map ----
async function buildSeed(): Promise<{ universe: string[]; coTrade: Record<string, string[]> }> {
  const universe = new Set<string>(["xch"]); // native coin, absent from /v1/assets
  const a1 = await getJson(`${BASE}/assets?page_size=${PAGE_SIZE}&page=1`);
  const pages = Math.min(MAX_PAGE, Math.ceil((a1?.count ?? 0) / PAGE_SIZE));
  for (const a of a1?.assets ?? []) if (a?.id) universe.add(a.id);
  for (let p = 2; p <= pages; p++) {
    const j = await getJson(`${BASE}/assets?page_size=${PAGE_SIZE}&page=${p}`);
    for (const a of j?.assets ?? []) if (a?.id) universe.add(a.id);
    await Bun.sleep(delayMs);
  }
  // /v1/pairs: co-trade map (both directions) + fold its assets into the universe.
  const pj = await getJson(`${BASE}/pairs`);
  const coTrade: Record<string, string[]> = {};
  const link = (x?: string, y?: string) => { if (x && y) (coTrade[x] ??= []).push(y); };
  for (const pr of pj?.pairs ?? []) {
    const b = pr.base?.id, q = pr.quote?.id;
    if (b) universe.add(b); if (q) universe.add(q);
    link(b, q); link(q, b);
  }
  for (const k in coTrade) coTrade[k] = [...new Set(coTrade[k])];
  return { universe: [...universe], coTrade };
}

// ---- main ----
let state = loadState() ?? {
  seeded: false, coTrade: {}, queue: [], doneKeys: [], saved: 0, overflows: [], startedAt: Date.now(),
};
const done = new Set(state.doneKeys);

const globalHead = await getJson(`${BASE}/offers?status=4&page_size=1`);
const globalCount: number = globalHead?.count ?? 0;

const needPatchSeed = PATCH && existsSync(DUMP) && !state.patched;
const needFullSeed = FULL && existsSync(DUMP) && !state.fulled;
if (!state.seeded || needPatchSeed || needFullSeed) {
  console.error("Building seed (complete asset universe + co-trade map)…");
  const { universe, coTrade } = await buildSeed();
  state.coTrade = coTrade;
  state.universe = universe;

  if (needFullSeed) {
    // Completeness pass: partner-discovery (default) only finds partners present in
    // an overflow asset's NEWEST 10k, so assets that traded with it only long ago
    // are never sub-queried. Here we probe every asset's offered count and, for any
    // > 10k, enqueue requested=B over the ENTIRE universe (skipping pairs already
    // fetched). Recovers the old-only-partner tail; appends to the existing dump.
    state.queue = []; // prior pass is complete; rebuild cleanly (safe to re-seed if interrupted mid-probe)
    const pool = LIMIT_ASSETS ? universe.slice(0, LIMIT_ASSETS) : universe;
    let probed = 0, overflowAssets = 0, enqueued = 0;
    for (const o of pool) {
      const j = await getJson(`${BASE}/offers?status=4&page_size=1&offered=${o}`);
      if (++probed % 200 === 0) process.stderr.write(`  probed ${probed}/${pool.length} offered counts…\n`);
      const c: number = j?.count ?? 0;
      if (c > HARD_CAP) {
        overflowAssets++;
        for (const r of universe) { if (r === o) continue; const k = `${o}|${r}`; if (!done.has(k)) { state.queue.push({ o, r }); enqueued++; } }
      }
      await Bun.sleep(delayMs);
    }
    console.error(`FULL: ${overflowAssets} overflow asset(s) → ${enqueued.toLocaleString()} requested-pair queries enqueued (most return 0).`);
  } else if (needPatchSeed) {
    // Keep the existing dump; only fetch what an older run missed:
    //   • xch + any universe asset never attempted as offered, and
    //   • every overflow asset re-done with the corrected sub-split logic
    //     (un-mark just their offered-only key so they re-run; keep their already
    //      saved per-pair sub-queries marked done to avoid re-fetching them).
    const overflowAssets = new Set(state.overflows.map((o) => o.o));
    for (const a of overflowAssets) done.delete(`${a}|`);
    state.overflows = [];
    const want = LIMIT_ASSETS ? universe.slice(0, LIMIT_ASSETS) : universe;
    const seen = new Set<string>();
    let redo = 0, fresh = 0;
    for (const o of want) {
      if (done.has(`${o}|`)) continue; // a small asset already fully paged — leave it
      if (seen.has(o)) continue; seen.add(o);
      state.queue.push({ o });
      overflowAssets.has(o) ? redo++ : fresh++;
    }
    console.error(`PATCH: keeping existing dump (${(statSync(DUMP).size / 1e6).toFixed(0)} MB). ` +
      `Re-running ${redo} overflow asset(s) + ${fresh} never-seen asset(s) (incl. xch).`);
  } else {
    const want = LIMIT_ASSETS ? universe.slice(0, LIMIT_ASSETS) : universe;
    state.queue = want.map((o) => ({ o }));
    console.error(`Seeded ${state.queue.length} offered-asset queries.`);
  }
  state.seeded = true;
  if (needPatchSeed) state.patched = true;
  if (needFullSeed) state.fulled = true;
  state.doneKeys = [...done];
  saveState(state);
  console.error(`Global completed offers: ${globalCount.toLocaleString()} · universe ${universe.length} assets`);
} else {
  console.error(`Resuming: ${state.queue.length} queries queued, ${done.size} done, ${state.saved.toLocaleString()} records saved.`);
}
console.error("Press Ctrl+C to pause (progress saved; re-run to resume).\n");

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true; state.doneKeys = [...done]; saveState(state);
  process.stdout.write("\r\x1b[K");
  console.error(`\nPaused — ${state.queue.length} queries left, ${state.saved.toLocaleString()} records saved. Re-run to resume.`);
  process.exit(0);
});

const sessStart = Date.now();
let qDone = 0;
while (state.queue.length && !interrupted) {
  const qTotal = qDone + state.queue.length;
  const q = state.queue[0]!;
  if (done.has(keyOf(q))) { state.queue.shift(); continue; }

  const res = await runQuery(q);
  if (res === null) {
    logLine(`✗ query ${keyOf(q)} failed — re-queuing at end`);
    state.queue.push(state.queue.shift()!);
  } else {
    if (res.overflowed) {
      if (!q.r) {
        // offered-only overflow: split by discovered partners ∪ co-trade map.
        const partners = new Set<string>([...(res.partners ?? []), ...(state.coTrade[q.o] ?? [])]);
        let added = 0;
        for (const r of partners) { const sq = { o: q.o, r }; if (!done.has(keyOf(sq))) { state.queue.push(sq); added++; } }
        logLine(`↳ offered ${q.o.slice(0, 8)} = ${res.count.toLocaleString()} (>10k) — kept newest 10k, split into ${added} requested-pairs`);
      } else {
        state.overflows.push({ o: q.o, r: q.r, count: res.count, missed: res.count - HARD_CAP });
        logLine(`! pair ${q.o.slice(0, 8)}→${q.r.slice(0, 8)} = ${res.count.toLocaleString()} — kept newest 10k, lost ${(res.count - HARD_CAP).toLocaleString()} oldest (chain-only)`);
      }
    }
    done.add(keyOf(q));
    state.queue.shift();
    qDone++;
  }
  state.doneKeys = [...done];
  saveState(state);
  paint(state, qDone, qTotal, sessStart);
  await Bun.sleep(delayMs);
}

paint(state, qDone, qDone, sessStart, true);
process.stdout.write("\n");

const lostToOverflow = state.overflows.reduce((a, o) => a + o.missed, 0);
console.error(
  `\nDone: ${state.saved.toLocaleString()} records (with dups) appended to ${DUMP}` +
  `\nGlobal completed-offer count: ${globalCount.toLocaleString()}` +
  (state.overflows.length
    ? `\nUnreachable: ${state.overflows.length} pair(s) over the 10k ceiling — ~${lostToOverflow.toLocaleString()} oldest records exist only on-chain.`
    : `\nNo per-pair overflow this run.`) +
  `\nNext: dedup by id, then compare the unique count to the global count to confirm coverage.`,
);
if (existsSync(DUMP)) console.error(`Dump size: ${(statSync(DUMP).size / 1e6).toFixed(0)} MB`);
