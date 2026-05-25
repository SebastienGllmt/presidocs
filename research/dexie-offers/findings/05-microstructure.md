# T5 — Market microstructure: how the offer-file market actually functions

**Thesis.** Mechanically, what kind of market is this? Who pays fees and why; how
fast do offers fill; how the file format migrated; how much settled volume is junk;
how partial-fill/aggregation shows up; and how big the trades are.

**Substrate.** All numbers from `generated/offers.duckdb` (833,145 completed
offers, snapshot 2026-05-23) via `research/dexie-offers/analysis/05-microstructure.sql`, plus
`research/dexie-offers/analysis/05-related-offers.ts` (streams the deduped JSONL to recover the
`related_offers` field, which was dropped from the substrate). Long monthly series
are in `research/dexie-offers/findings/data/05-microstructure-*.csv`.

**Headline.** This is a **retail micro-trade market with two settlement layers**:
a fast **AMM/bot layer** (sub-minute fills, mostly TibetSwap, pays priority fees)
sitting on top of a slow **resting-order layer** (NFTs and patient swaps that sit
hours-to-months and pay nothing). The maker pays a fee only when racing for block
inclusion; the typical trade is **0.2 XCH / ~$11**.

---

## Coverage caveats (apply to every number below)

- 84.7% of global, **biased to dropping the oldest offers of the busiest pairs**
  (↔XCH/stablecoins). Early-timeline counts are **floors**.
- **`date_found` is dexie's first-seen, NOT offer creation.** Time-to-fill is
  measured first-seen → settled; it is a floor on true resting time, and 19,646
  offers have `date_completed < date_found` (first-seen lag) — excluded from
  time-to-fill stats.
- `known_taker_source` (TibetSwap/`tibet2`) is only recorded from **2025-04**;
  AMM-share figures are floors and only valid post-2025-04 (per 00-recon trap #1).

---

## Finding 1 — Fees: 81% pay nothing; the ~19% who pay are racing for a block

**Confidence: HIGH (direct counts).**

81.39% of settled offers pay **zero** fee. Among the 18.61% that pay, the fee is
tiny — median **0.000187 XCH**, p99 0.0055 XCH (max 3.125 XCH is a lone outlier).

| fee bucket (XCH) | offers | % |
|---|---|---|
| 0 | 678,117 | 81.39 |
| <1e-6 (dust) | 22,398 | 2.69 |
| 1e-6 .. 1e-5 | 4,986 | 0.60 |
| 1e-5 .. 1e-4 | 31,116 | 3.74 |
| 1e-4 .. 1e-3 | 70,103 | 8.41 |
| 1e-3 .. 1e-2 | 25,511 | 3.06 |
| 0.01 .. 0.1 | 852 | 0.10 |
| ≥0.1 | 62 | 0.01 |

**Who pays — and the answer is "people in a hurry."** The single cleanest
predictor of paying a fee is **settlement speed**:

| time first-seen → settled | offers | % paying a fee |
|---|---|---|
| <1 min (instant) | 262,776 | **42.0** |
| <1 hr | 159,236 | 16.2 |
| <1 day | 153,099 | 5.4 |
| <30 day | 121,353 | 4.5 |
| >30 day | 117,035 | **0.7** |

And by asset category: **fungible swaps pay (29.0%), NFT trades almost never
(2.4%)**, stablecoin 24.9%.

| category | offers | % paying a fee |
|---|---|---|
| fungible-only | 467,794 | 28.98 |
| stablecoin | 48,141 | 24.87 |
| NFT-involved | 317,210 | 2.37 |

**Fee-paying share rose then settled (monthly series:
`data/05-microstructure-fee-by-month.csv`).** Quarterly digest:

| quarter | offers | % paying a fee |
|---|---|---|
| 2023-Q1 | 49,411 | 1.4 |
| 2023-Q4 | 50,360 | 5.9 |
| 2024-Q2 | 50,995 | 27.3 |
| 2025-Q2 | 63,024 | **42.7** |
| 2025-Q3 | 102,100 | 21.7 |
| 2026-Q1 | 70,298 | 14.3 |
| 2026-Q2 | 46,944 | 20.7 |

**Hypothesis (INFERENCE, medium confidence):** Chia mempool fees are zero when
blocks aren't full. A nonzero fee is a *priority bid* paid only when there is
contention for inclusion in the next block. So fees concentrate exactly where you'd
expect competitive racing: fast-filling fungible swaps (arbitrage bots / AMM
takers) during busy periods (2024–25 peaks). NFT one-off trades and months-old
resting orders have no race to win, so they ride for free. The 2025-Q2 spike (43%)
is a congestion episode, not a behavior change — by 2026 it relaxes back to ~15–20%.

---

## Finding 2 — Time-to-fill is bimodal: an instant AMM layer over a slow resting layer

**Confidence: HIGH for the shape; MEDIUM on absolute times (date_found is first-seen).**

Distribution of first-seen → settled (n=813,499; p50 = 2,285 s ≈ 38 min, p90 ≈ 92 d,
p99 ≈ 661 d):

| time-to-fill | offers | % |
|---|---|---|
| <10 s | 49,572 | 6.1 |
| **10–60 s** | **213,204** | **26.2** |
| 1–10 min | 104,856 | 12.9 |
| 10–60 min | 54,380 | 6.7 |
| 1–24 hr | 153,099 | 18.8 |
| 1–7 day | 79,782 | 9.8 |
| 7–30 day | 41,571 | 5.1 |
| **>30 day** | **117,035** | **14.4** |

Two clear modes: a spike at **10–60 s** (the instant-fill / AMM / bot mode, 32%
of offers fill sub-minute) and a fat tail where **14% sit over a month**.

**The instant mode IS the AMM.** Among 2025-04+ offers (where the taker is
labelled), **76.0%** of sub-minute fills are **TibetSwap**, vs 23.8% of resting
(≥60 s) fills. By category, fungibles fill in seconds while NFTs sit ~19.5 hours:

| category | offers | median time-to-fill | % instant (<60s) |
|---|---|---|---|
| fungible | 456,606 | **62 s** | 49.2 |
| stablecoin | 47,424 | 2,050 s (34 min) | 21.8 |
| NFT | 309,469 | **70,314 s (19.5 hr)** | 9.0 |

This is the core mechanical picture: offer files serve *both* an automated
swap market (AMM-mediated, seconds) and a human listing/auction market for NFTs
and illiquid CATs (the resting tail).

---

## Finding 3 — Format migration (mod_version v1→v2) was a hard cliff in early 2023

**Confidence: HIGH (direct counts).** v1 = 111,670 (13.4%), v2 = 721,475 (86.6%).

The switch happened almost overnight (monthly series:
`data/05-microstructure-modversion-by-month.csv`):

| month | offers | % v2 |
|---|---|---|
| 2023-01 | 18,069 | 0.0 |
| **2023-02** | 14,225 | **14.3** |
| **2023-03** | 17,117 | **89.3** |
| 2023-06 | 24,702 | 96.4 |
| 2024-01 onward | — | ~100 |

v2 appears in **Feb 2023**, dominates by **Mar 2023**, and is effectively 100% from
mid-2024. The **last v1 offer ever settled was 2023-08-23**; the small post-cliff
v1 tail is old v1 offers settling late (the time axis is settlement, not creation).
This is the on-chain footprint of the Chia offer-format upgrade rolling out in early
2023. (INFERENCE on cause; the dates are fact.)

---

## Finding 4 — Junk prices barely make it into *settled* data (≈0.5%)

**Confidence: HIGH for settled-data spam rate; this is a key reframing.**

Detector: single-pair offer whose **direction-normalized** price (canonical
asset-id order, `requested/offered`) deviates from its **(pair, month) median** by
>10× or <1/10×, judging only pairs with ≥20 monthly observations (NFTs are unique
assets and can't be median-judged). Of 460,295 single-pair offers with a usable
price, 425,667 fall in judgeable pairs.

| threshold | % of judged offers flagged |
|---|---|
| >5× / <1/5× | 0.98 |
| **>10× / <1/10×** | **0.47** |
| >100× / <1/100× | 0.13 |
| >1000× | 0.058 |

**The interpretation matters:** dexie's dataset is **settled** trades only. Anyone
can *post* a junk offer ("1 XCH for $0.32"), but somebody has to *accept* it for it
to settle — and almost nobody does. So junk pricing is overwhelmingly a
**posting-side** phenomenon that settlement filters out. Spam in settled data is
rare and **declining** (`data/05-microstructure-spam-by-month.csv`):

| year | judged | spam | % spam |
|---|---|---|---|
| 2022 | 28,837 | 297 | 1.03 |
| 2023 | 77,541 | 648 | 0.84 |
| 2024 | 84,751 | 406 | 0.48 |
| 2025 | 141,002 | 337 | 0.24 |
| 2026 (partial) | 93,536 | 321 | 0.34 |

**What little spam exists hits low-cap meme/illiquid CATs, not liquid pairs:**
XCH/XPCD 67%, XCH/MRBL 39%, XCH/GRAPE 19.8%, XCH/🥔 9.5% — whereas liquid
XCH/USDSC is 0.5%. (Coordination note: T3, the price-oracle agent, also touches
noise; this is the *general settled-spam-rate characterization* T5 owns. The high
per-pair rates above double as a warning to T3: build price series from liquid
pairs and trim, or these illiquid CATs will poison a median.)

---

## Finding 4b — Aggregation has two distinct mechanical signatures

**Confidence: HIGH on the facts; MEDIUM on the mechanism inference.**

The starting "mempool_combined = 100%" was an **artifact**: `mempool_combined` is
**never `false`** — it is `true` (160,881 / 19.31%) or `NULL` (672,264 / 80.69%).
The recon's quick check saw only the non-null rows. It is a *presence flag*.

`combined=true` offers are ~100% single-pair, carry a higher mempool cost
(median 232M vs 182M), and have `mempool_fees` median of **1 mojo** (vs 100,000
when not combined). It only appears from **2024** and rises (0% in 2022/23 → 49%
in 2026). Among 2025-04+ offers, **combined=true is 81% TibetSwap**. Read:
**`combined` = dexie's "Combined Swap"** — the documented liquidity-aggregator
feature (launched 2024) that routes a single user swap through multiple sources
(combined offers + the TibetSwap AMM), settled atomically in one offer file. This
was originally inferred here as an "AMM batch-settlement footprint"; the dexie
launch post (see `README.md` sources) **confirms the mechanism and names it**.
Cross-check (2025-04+): combined=true is 81% TibetSwap, and **59% of TibetSwap
fills are combined** — i.e. much of the "AMM takeover" is dexie's aggregator
routing orders to the pool, not direct AMM use. NB: the 99.9%-single-pair shape
fits (Combined Swap aggregates *sources*, the user swap is still A↔B). The 1%
Combined Swap service fee is NOT in the `fees` field (that's the network fee).

`related_offers` is a *separate* aggregation signal — an array of **other offer
ids** (recovered via the JSONL pass). 15,307 offers (1.84%) carry one; 91% point to
exactly one sibling. **Every one of the 17,482 referenced ids is OUTSIDE this
status=4 completed set (0 matches)** — they reference *non-completed* siblings,
consistent with **partial-fill remainders / replacement offers**. These offers are
100% single-pair, **0% combined**, 2.8% pay a fee. So the two aggregation
mechanisms are mutually exclusive: `combined` = AMM batching, `related_offers` =
partial-fill chains.

(Multi-leg as an aggregation signal: 89.7% of offers are single-pair; multi-leg is
real but small and is owned descriptively by 00-recon — not re-litigated here.)

---

## Finding 5 — Trade size: a micro-trade market

**Confidence: HIGH (direct quantiles), within single-pair offers having the leg.**

| metric | n | p10 | p25 | **p50** | p75 | p90 | p99 |
|---|---|---|---|---|---|---|---|
| XCH-leg trade (XCH) | 607,825 | 0.001 | 0.042 | **0.20** | 0.84 | 2.71 | 20.49 |
| stablecoin-leg trade (USD) | 49,302 | 1.00 | 2.91 | **11.42** | 42.95 | 140.00 | 1,000.00 |

The median XCH-side trade is **0.2 XCH**; the median dollar-denominated trade is
**$11.42**. Even the 99th percentile is only ~20 XCH / ~$1,000. (USD assumes the
stablecoin codes are ~1:1; flagged as a unit caveat by 00-recon for some "USD"
codes — treat the dollar figures as approximate. Stablecoin trades are a 6% slice.)

---

## Per-claim confidence summary

| claim | confidence | basis |
|---|---|---|
| 81.4% zero-fee; nonzero median 0.000187 XCH | HIGH | direct counts |
| Fee-paying tracks settle speed (42% instant vs 0.7% >30d) & is fungible-only | HIGH | direct counts |
| Fees are a block-priority bid (why ~19% pay) | MEDIUM | inference from speed/category/congestion correlation |
| Time-to-fill bimodal; instant mode is 76% TibetSwap | HIGH (shape) / MEDIUM (abs. time = first-seen) | counts; date_found caveat |
| v2 migration cliff Feb–Mar 2023; last v1 2023-08-23 | HIGH | direct counts |
| Settled-data spam ≈0.47% (10×), declining, concentrated in low-cap CATs | HIGH | direct counts |
| `mempool_combined` is a presence flag = AMM batch settlement | HIGH (flag) / MEDIUM (mechanism) | counts; tibet correlation |
| `related_offers` = partial-fill sibling chains (all refs outside status=4) | HIGH (refs) / MEDIUM (mechanism) | JSONL pass + join |
| Median trade 0.2 XCH / $11.42 | HIGH | direct quantiles |

**Biggest caveat:** `date_found` is dexie's first-seen, not creation, so all
time-to-fill figures are floors / first-seen-relative; and the 84.7% coverage drops
the oldest busiest-pair offers, so early-period counts are floors.
