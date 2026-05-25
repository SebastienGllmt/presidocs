# O5 — On-chain cost footprint: how heavy is the offer-file market on the chain?

**Thesis.** Every settled offer is a CLVM spend bundle that consumes block space.
Measuring `mempool_cost` (the CLVM program cost dexie recorded for each fill) tells
us the real resource cost of each kind of trade — and whether the market prices that
cost rationally. Two headline results: (1) **cost is driven by *structure* (leg
count), not by asset class** — an NFT swap is actually *cheaper* than a CAT swap at
equal leg count, refuting the naive "NFT spends cost more" intuition; and (2) the
mojo **fee is uncorrelated with CLVM cost** (Pearson 0.05–0.06), so the fee is a
*block-priority bid*, not a cost-recovery price — directly confirming T5's
hypothesis. Aggregate footprint: the **entire** offer-file market runs at
**~0.2–1.0% of Chia's block capacity** (a monthly series that tracks volume, peaking
~1.0% in mid-2025 — corrected from an earlier ~2.9% that used a wrong block rate; see
Finding 6), which is *why* most fills pay nothing.

**Substrate.** All numbers from `generated/offers.duckdb` (833,145 completed offers,
snapshot 2026-05-23) via `research/dexie-offers/analysis/09-onchain-cost.sql`. Long monthly series
in `research/dexie-offers/findings/data/09-onchain-cost-*.csv`. Builds on T5
(`05-microstructure.md`) for fees — I own COST and do not re-litigate the human-unit
fee buckets.

---

## Coverage caveat (apply to every number below)

**Confidence: HIGH (direct counts).** `mempool_cost` and `mempool_fees` are present
on **777,712 / 833,145 = 93.35%** of offers, spanning **2022-10-20 → 2026-05-23**.
The missing 6.65% is **not random and not imputed**: dexie simply did not record the
`mempool` block before **Oct 2022** (0% coverage Jan–Sep 2022; 48.9% in the
transition month 2022-10; **~99% every month from 2022-11 onward**). So all
cost numbers describe the **post-Oct-2022** era and silently exclude the earliest
~46k offers. The separate 84.7%-and-biased dataset-coverage caveat from
`README.md` (oldest offers of busiest pairs dropped) still applies on top.
(See `data/09-onchain-cost-coverage-by-month.csv`.)

---

## Finding 1 — The cost distribution: a tight ~185M core with a long heavy tail

**Confidence: HIGH (direct quantiles, n=777,712).**

| stat | min | p10 | p25 | **p50** | p75 | p90 | p99 | max | mean |
|---|---|---|---|---|---|---|---|---|---|
| mempool_cost | 7.7M | 153.5M | 166.8M | **185.2M** | 288.4M | 702.0M | 3.81B | 6.86B | 396M |

The typical settled offer costs **~185M CLVM**. The mean (396M) sits above p75
because of a heavy right tail (p99 = 3.81B, ~20× the median). That tail is what the
rest of this deep dive explains: it is multi-leg bundles and AMM batch settlements,
not NFTs.

---

## Finding 2 — Leg count is THE cost driver (≈ +130–200M CLVM per extra leg)

**Confidence: HIGH (direct counts).**

Cost rises monotonically and roughly linearly with the total number of legs
(`n_offered + n_requested`):

| total legs | offers | median cost |
|---|---|---|
| **2** (single-pair) | 699,284 | **178.8M** |
| 3 | 59,837 | 306.3M |
| 4 | 3,184 | 521.2M |
| 5 | 8,205 | 640.0M |
| 6 | 3,902 | 700.8M |
| 7 | 1,622 | 943.1M |
| 8 | 46 | 1.02B |
| … 32 (max) | 1 | 4.83B |

Each additional leg adds roughly **130–200M CLVM** (its own puzzle reveal + spend).
Since **89.7%** of offers are single-pair (2 legs), the distribution's core is the
178.8M two-leg cost; the heavy tail is the small fraction of genuinely multi-leg
bundles. This is the cleanest causal statement in the deep dive.

---

## Finding 3 — Cost by trade type: NFTs are NOT the expensive case

**Confidence: HIGH (direct counts).** Category = NFT-involved > stablecoin >
fungible-only (priority order; stablecoin = any `wUSDC.b/USDSC/wUSDC/wUSDT` leg).

| category | offers | p25 | **median** | p75 | p90 |
|---|---|---|---|---|---|
| stablecoin | 41,813 | 101.3M | **174.6M** | 364.5M | 1.09B |
| NFT-involved | 288,784 | 165.1M | **176.3M** | 254.4M | 357.4M |
| fungible-only | 447,115 | 172.4M | **220.8M** | 347.4M | 1.08B |

NFT-involved has the **lowest p90 (357M)** of all three and a near-median p50. The
naive hypothesis "NFT spends should cost more" is **refuted**. To isolate structure
from asset class, restrict to single-pair (2-leg) offers:

| single-pair offer | offers | median cost |
|---|---|---|
| has an NFT leg | 259,043 | **173.9M** |
| no NFT leg (CAT/XCH swap) | 440,241 | **203.7M** |

**At equal leg count, an NFT trade is ~15% *cheaper* than a fungible swap.**
(INFERENCE on mechanism, MEDIUM): a CAT swap carries the CAT puzzle layer on *both*
the offered and the requested legs, whereas an NFT↔XCH trade pairs one (singleton)
NFT puzzle with bare XCH; the CAT outer-puzzle overhead is what costs, not the NFT.
The stablecoin/fungible heavy p90 tails (≈1.08B) come from aggregation
(`combined=true`, Finding 5), not from the asset itself.

Format barely matters: v1 median 178.5M vs v2 186.7M (n=69,166 / 708,546).

---

## Finding 4 — The fee is uncorrelated with CLVM cost (fee = priority bid, not a price)

**Confidence: HIGH for the (lack of) correlation; this is the core cost↔fee result.**

`mempool_fees` is the **same number** as the human-unit `fees` field, just in mojos
(`mempool_fees == fees × 1e12`, verified on samples). One refinement of T5 falls out
of the finer unit: **304,251 offers have `fees = 0` (human XCH) but
`mempool_fees > 0`** — dust fees that round to zero in the human field. So at mempool
granularity **only 42.1% of fills pay nothing**, versus T5's 81% on the rounded
`fees` field. (This *refines*, not contradicts, T5: the extra "payers" are paying
sub-0.0005-XCH dust.)

The key question is whether that fee tracks the CLVM cost it is paying for. It does
not:

| measure | value |
|---|---|
| Pearson corr(mempool_cost, mempool_fees), all rows | **0.052** |
| Pearson corr, fee-payers only (n=450,094) | **0.061** |
| fee-per-cost-unit (mojo / cost), p10 | 4.5e-6 |
| fee-per-cost-unit, **p50** | **0.67** |
| fee-per-cost-unit, p90 | 7.1 |

The fee a maker pays per unit of CLVM cost spans **six orders of magnitude** with
**essentially zero correlation** to the actual cost incurred. A maker spending 185M
cost units and one spending 1B units pay statistically indistinguishable fees. This
is exactly what T5's "fee = block-priority bid" predicts: on Chia, fees are 0 when
blocks aren't full and become an arbitrary congestion bid when they are — they are
**not** a cost-recovery price keyed to the spend's size. **The market does *not*
price block space rationally per-cost; it prices *urgency*.**

---

## Finding 5 — `combined=true` (AMM batch settlement) owns the heavy tail

**Confidence: HIGH on the facts; MEDIUM on mechanism (builds on T5 4b).**

| combined | offers | median | p90 | p99 |
|---|---|---|---|---|
| true | 160,881 | 232.2M | **2.17B** | **5.09B** |
| NULL | 616,831 | 182.1M | 452.4M | 2.64B |

`combined=true` offers (T5: AMM batch-settlement footprint) carry a modestly higher
median but a **~5× heavier p90** — they are the offers that ride inside a large
multi-spend bundle and so account for most of the distribution's heavy right tail.
This dovetails with Finding 2: batched/aggregated settlements are exactly the
high-leg-count bundles.

---

## Finding 6 — Aggregate footprint: ~0.2–1.0% of block capacity, rising with volume

> **⚠️ SUPERSEDED 2026-05-24 — two corrections (see `README.md` → measure (3)).**
> (1) **Double-count:** `sum(mempool_cost)` counted each Combined-Swap bundle once
> per offer in it → overcounted **~1.78×**. Corrected total is **173.2T** (not the
> 307.75T below), and the capacity peak is **~0.53%** (not ~1.0%), via bundle-dedup
> on `mempool.id`. (2) **Measure (3) now exists:** offers are **~10.5% of *actual*
> Chia compute all-time, ~35% in 2025–26** (coinset block-cost sampling,
> `26-actual-blockspace.ts`) — the capacity % below was always "low by design," not
> offers' real share of on-chain activity. Numbers in the rest of this section are the
> pre-correction values, kept for provenance.

> **Which "block space"? This is measure (2): COMPUTE CAPACITY.** = offer CLVM cost ÷
> (blocks × per-block cost limit). It is NOT (4) transaction-count share, nor (3)
> share of *actual* block usage. Offers are low here *by design* (cheap settlement
> puzzles) — a strength, not irrelevance. Because Chia blocks run far below full, by
> transaction count / actual usage offers are a **much larger** slice of real on-chain
> activity; quantifying (3)/(4) needs full-node block totals (transactions/cost per
> block) we don't have. Don't read "~1% of capacity" as "unimportant."


**⚠️ CORRECTED 2026-05-24 (denominator fix).** The original draft used an assumed
~1,661 blocks/day (~52s/block) and reported "<3%, peak 2.90%". That block rate was
**~2.8× too low** — the chain empirically runs **~4,620 blocks/day** (max−min
`spent_block_index` ÷ days = 4,620; matches Chia's ~18.75s target), which had
inflated every % by ~2.8×. Recomputed using each month's **actual** block count
(`max−min spent_block_index`), no assumed rate (CSV: `data/18-blockspace-by-month.csv`):

| month | offers | total CLVM cost | % of that month's block space |
|---|---|---|---|
| 2025-07 (peak) | 28,730 | 15.87T | **1.01%** |
| 2025-08 | 38,910 | 14.73T | 0.94% |
| 2025-09 | 34,300 | 12.67T | 0.83% |
| 2026-01 | 24,769 | 12.44T | 0.79% |
| 2024-08/09 (troughs) | — | — | ~0.20% |

**It is NOT a constant 3% — it's a monthly series ~0.2%→1.0% that tracks trading
volume**, peaking near **1.0%** in mid-2025. Total recorded CLVM cost across all
777,712 offers with data: 307.75 trillion units. Caveats on the %: (1) **settlements
only.** Verified against the API: **expired** offers (status=6) have NO on-chain spend
(`spent_block_index` null, no `mempool.cost`) — the maker's coins are never moved, so
zero footprint. **Cancelled** offers (status=3) DO spend on-chain (30/30 sampled had
`spent_block_index`; 24/30 a CLVM cost ~98–122M), but are **batched** (~3 offers/spend).
**Measured** (`25-cancel-cost.ts`: crawled the newest 10k status=3 offers, deduped by
spend bundle, vs settled cost in the overlapping window 2026-05-22→23): cancellation
block-space = **0.195× the settled cost**. **Full decomposition (same window, all
measured)** so it isn't a black box: 4,421 cancelled offers vs 1,109 settled =
**4.0× more cancellations by count**; batched 3.1/spend → **1,429 cancel spends** vs
1,109 settled = 1.29× more *spends*; median cost **33M per cancel spend** (a plain
coin-reclaim) vs **173M settled / 491M mean** (settlements often route a Combined Swap
through several pools) → each cancel spend is **0.15× the cost**. So
`1.29 × 0.151 = 0.195`. An early hand-estimate of "~2×" was wrong: it ignored that
cancel spends cost ~6× *less* than settlements. So true offer-file footprint is
**~1.2× the settled line** (peak ~1.0% → ~1.2%). `chart-blockspace` now
shows both bands (settled measured + cancellations at 0.20×). (2) share of theoretical
**capacity** (blocks × 11e9), Chia blocks run far below full → not offers' share of
*actual* traffic. (3) coverage *floor* (84.7%). Qualitative punchline holds —
featherweight tenant, ~1% settled / ~1.2% with cancellations, not 3%; expirations add
zero. (0.20× is one recent window applied flat.)

**Did the AMM era change cost/trade? No.** Splitting at AMM-labeling (2025-04):

| era | offers | median cost | mean cost |
|---|---|---|---|
| pre-2025-04 | 424,455 | 191.6M | 407M |
| 2025-04+ | 353,257 | 176.9M | 382M |

Per-trade cost is essentially **flat** (a slight *decrease*). Within the labelled
era, TibetSwap fills are a touch heavier at the median (194.5M vs 171.9M non-Tibet)
— the AMM's own coin spend rides along — but the dramatic cost lives in
`combined=true` batches (Finding 5), not in AMM fills per se. AMM dominance grew the
*number* of trades, not the *cost of each*.

---

## Charts for the post (data inline above + CSV)

1. **Cost vs leg count** (Finding 2 table) — bar of median cost by total legs; the
   clean monotonic story. Data inline; full per-leg in query Q5.
2. **Cost by trade type + NFT-vs-CAT at equal legs** (Finding 3 tables) — the
   counterintuitive "NFTs are cheap" result. Data inline.
3. **Fee vs cost scatter / corr** (Finding 4) — corr ≈ 0.06; headline that fee ≠
   cost-price. Data inline (corr + fee-per-cost quantiles).
4. **Monthly CLVM footprint vs % block space** (Finding 6) — area/line of monthly
   % of capacity (~0.2–1.0%), peak ~1.0% mid-2025 annotated. → post `chart-blockspace`.
   `data/09-onchain-cost-footprint-by-month.csv` (44 rows).

---

## Per-claim confidence summary

| claim | confidence | basis |
|---|---|---|
| mempool_cost coverage 93.35%, post-Oct-2022 only, not imputed | HIGH | direct counts |
| Median cost 185M, heavy tail (p99 3.81B) | HIGH | direct quantiles |
| Cost ≈ linear in leg count (+130–200M/leg) | HIGH | direct counts |
| NFTs cheaper than CAT swaps at equal leg count | HIGH (fact) / MEDIUM (CAT-layer mechanism) | direct counts; inference |
| Fee uncorrelated with cost (corr ≈ 0.06) ⇒ priority bid not price | HIGH | corr + fee-per-cost spread |
| mempool_fees == fees×1e12; 42% (not 81%) zero at mempool granularity | HIGH | field identity + counts |
| combined=true owns the heavy tail (p90 2.17B vs 452M) | HIGH (fact) / MEDIUM (AMM-batch mechanism, via T5) | direct counts |
| Whole market ~0.2–1.0% of block capacity (peak ~1.0%, mid-2025; varies w/ volume) | HIGH (within-data, per-month actual block counts) / MEDIUM (capacity-not-usage; coverage floor) | sum ÷ actual block count |
| AMM era did not raise cost/trade (flat ~177–192M median) | HIGH | direct counts |

**Biggest caveat:** `mempool_cost` is **post-Oct-2022 only** (93.35% coverage, 0%
before 2022-10 — not imputed); and the block-space % is a *floor* because dataset
coverage (84.7%) is biased to dropping the oldest offers of the busiest pairs.
