# 21 — The Liquidity Incentive Program: dexie pays makers to provide liquidity

**Thesis.** dexie runs a DBX-rewards program that pays **market makers** to keep
**open** offers within 5% of the market price. This reframes the market-maker
economics from the pick-off finding (`12-tightness.md`): yes, a resting quote gets
picked off and constant repricing costs fees — but makers are **paid 16–31% APR**
(on the liquid pairs) to do exactly that, and *only open offers earn*, so they're
subsidized to keep quotes live. It also exposes the **maker address**
(`maker_puzzle_hash`) the offers dump lacks, and reveals enormous reward-farming
churn behind the open-offer stock.

**Data.** `research/dexie-offers/pipeline/crawl-rewards.ts` →
- `dexie-rewards-stats.json` (all-time totals), `dexie-incentives.json` (pairs+APR),
- `reward_claims` table (2,252,779 claims, **2025-08-01 → 2026-05-24**, deduped by id).
  The claims endpoint only goes back to **2025-08** (~10 months), so per-claim figures
  below are for that window; the all-time total comes from the stats endpoint.
DBX ≈ **0.0082 XCH** (token_meta `current_avg_price`); XCH figures are rough (DBX's
price varied over the program's life).

## Finding 1 — The program, and the APR hook

`/v1/incentives`: 4 pairs incentivized (XCH paired with wUSDC.b, wUSDC, DBX, SBX),
both directions, **100 DBX/day each**, **≤5% spread** to qualify, rewards shared
among qualifying offers and **higher closer to market**:

| pair | est. APR |
|---|---|
| XCH ↔ wUSDC.b | 21–29% |
| XCH ↔ wUSDC | 16–31% |
| XCH ↔ DBX | 110–131% |
| XCH ↔ SBX | **306–341%** |

The liquid stablecoin pairs pay ~16–31% APR; the thin pairs (DBX, SBX) post
triple-digit APRs (less competing liquidity → higher per-offer reward). Confidence:
**High** (direct from the endpoint).

## Finding 2 — Scale: a steady ~24k DBX/month, a net subsidy

- All-time claimed: **683,601 DBX** (stats endpoint); steady **~24k DBX/month**
  (≈ 800 DBX/day × 8 entries) in the 10-month window we have claims for.
- **Properly valued via the order flow** (DBX→XCH from single-pair DBX↔XCH offers,
  ×XCH→USD from the price oracle — `22-reward-value.sql`), the recent 10 months
  (230,997 DBX) is **≈1,570 XCH ≈ $8,646**. **Key nuance:** the DBX payout is flat,
  but its **USD value eroded ~5×** — **~$1,700/mo (Aug 2025) → ~$355/mo (2026)** —
  because the reward is fixed in a token whose value fell with XCH. (Don't value the
  whole 683k DBX at one current price: the pre-2025-08 months, ~2× the claims volume,
  were paid when XCH/DBX were worth far more, so all-time USD is materially higher
  than a flat-price estimate but can't be pinned without the pre-Aug-2025 claim history.)
- For scale vs the fee streams (`20-fees.sql`): in XCH, all-time rewards (~5,600 XCH at
  a flat current DBX price; more if time-valued) are **on the order of / above** the
  ~2,860 XCH dexie *collected* in Combined-Swap service fees — i.e. a **net subsidy**
  to liquidity (caveat: DBX is dexie's own token, so dexie's *cost* to mint it ≠ its
  market value *to makers*).

Confidence: **High** on DBX totals + the USD-erosion shape; **Medium** on absolute USD
levels (oracle + DBX-price reconstruction); the all-time USD is **unvalued** (no
pre-2025-08 monthly claims).

## Finding 3 — A few pro market makers earn almost everything (and we can NAME them)

The claims expose `maker_puzzle_hash` — the maker address missing from the offers
dump. Over the 10-month window: **12,712 distinct maker addresses**, but rewards are
brutally concentrated (`data/21-reward-concentration.csv`):

| top-N makers | % of all DBX rewards |
|---|---|
| 1 | **18.6%** |
| 10 | **49.2%** |
| 50 | 76.3% |
| 100 | 85.7% |
| 500 | 93.4% |

The single top maker earned **43,030 DBX (~353 XCH)** in 10 months; the **median**
maker earned **0.26 DBX** (dust), and **8,877 of 12,712 (70%)** earned under 1 DBX.
So "market making on Chia" is really a few dozen professional operations plus a long
tail of dabblers. **This is the partial answer to "who's trading" we'd flagged as
unindexed** — for the market-maker side, identity *is* available (just in the rewards
data, not the offers), and it's a small, concentrated cast.

Confidence: **High** for the concentration; maker count is an **upper bound** (one
operator may run several addresses → true concentration is even higher), and it
covers only reward-earning makers in the 10-month window.

## Finding 4 — Reward-farming is enormous churn: 99.7% of rewarded offers never settle

**2,215,021 distinct offers earned rewards in 10 months** — already more than the
**833,145 settled offers all-time**. Yet only **5,885 (0.3%)** of those reward-earning
offers appear in the settled set: **99.7% never filled.** They are open offers,
re-posted constantly to track the market within the 5% band, each earning a sliver of
DBX. So the incentive program is a major engine behind the huge non-settled offer
universe (the ~599k open + expired/cancelled in the lifecycle section): most offer
files that have ever existed are reward-farming quotes, not trades.

Confidence: **High** (direct join; the 0.3% is exact for our settled set, itself 84.7%
coverage — so the true settle rate of rewarded offers is ≤~0.4%, still negligible).

**Pruning confirmed (why the lifecycle counts undercount).** Sampling reward offer
ids and querying `/v1/offers/{id}`: 5/5 *old* ones (claimed before 2025-10) return
`success=false` — dexie has **pruned** them. In a 150-offer random sample, 83% were
gone; every one still present was status 3 (cancelled) or 6 (expired), **none settled,
none still open**. So reward offers ≈ a census of market-maker churn that dexie does
not retain — exactly why the `status=3/6` snapshot (91k/228k) is a floor.

**Churn-vs-settled ratio (`23-mm-churn.csv`).** Reward-earning offers run
**150k–280k/month vs 17k–39k settled** → **~8–9× (mean 8.7×, median 8.2×, range
6.9–14.1)**, reasonably steady. ⚠️ **Do NOT extrapolate this ratio to pre-2025** to
reconstruct historical cancellations (the author's idea): the churn is a product of
the incentive program, which was smaller/absent before 2025-08, so the ratio almost
certainly wasn't ~8× in 2022–24. The defensible claim is a **floor**: ≥2.2M
cancelled/expired incentivized offers in 10 months → cumulative cancellations are in
the **millions**, orders of magnitude above the pruned status counts. (Post charts:
`chart-churn`, `chart-churn-ratio`.)

## What this changes in the post
- **Market-maker section:** the pick-off story gets its other half — makers are *paid*
  (16–31% APR, ~24k DBX/mo) to keep providing liquidity; only open offers earn. + the
  concentration chart.
- **"Who's actually trading":** correct/extend — for market makers we *can* count and
  rank them (12,712 addresses, top-10 = ~half), via the rewards data's `maker_puzzle_hash`.
- **Lifecycle / open offers:** reward-farming churn explains the big open-offer stock.

## Reproduce
`bun research/dexie-offers/pipeline/crawl-rewards.ts` → `./tools/duckdb generated/offers.duckdb < research/dexie-offers/pipeline/build-rewards-substrate.sql`;
queries in this doc are runnable against the `reward_claims` table.
