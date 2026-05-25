# 10 — Does an active TibetSwap (AMM) pool TIGHTEN a pair's price?

**Thesis (S3).** A standing AMM should make a pair's price *tighter* — lower
within-period price dispersion — because a constant-product pool quotes a single
deterministic price that arbitrage keeps pinned, instead of a scatter of
independent human asks. Finding 01 (T1) **declined to claim this** (its Caveat
#5): a naive AMM-vs-P2P dispersion compare is confounded because a CAT's tibet2
fills span many months and the **pool price drifts** over that window, so any
"AMM is noisier/tighter" reading is really cross-period level drift. This is the
rigorous redo with **per-(pair, month) binning**.

**Result: NULL — reversed, in fact.** With drift removed by binning, an active
TibetSwap pool does **not** tighten within-period price dispersion. When you hold
the pair *and* the month fixed, the AMM's own fills are if anything **slightly
wider**-dispersed than the contemporaneous P2P fills of the same pair. The
apparent "AMM markets are tighter" signal you get from a naive cross-pair compare
is an artifact of *which CATs* have pools (composition) and of markets maturing
over time — not of the AMM compressing price.

All numbers come from `research/dexie-offers/analysis/10-amm-tightening.sql`, run read-only
against `generated/offers.duckdb` (snapshot 2026-05-23). Method notes inline.

---

## Method (what makes this immune to the T1 drift trap)

- **Universe (fact).** Single-pair (1×1) offers where one leg is XCH and the
  other is a **non-NFT (fungible) CAT**: **380,600 offers across 416 CATs**
  (Q0). Dispersion is only meaningful for fungible pairs — an NFT's "price" is
  per-unique-item, so the 227k NFT↔XCH single-pair offers are excluded by design.
- **Direction-normalized price.** `p = cat_per_xch = CAT_amount / XCH_amount`,
  rebuilt from the two legs so **both directions of the pair land on one canonical
  scale** (CAT priced against XCH). Reuses T3's normalization discipline.
- **Robust relative dispersion** (level-drift-proof *within* a bin):
  `rel_iqr = (Q75−Q25)/median`, with `rel_mad = median(|p−median|)/median` as a
  robustness check (Q-A3). **Median/robust only, never mean.**
- **Binning is the whole point.** Every comparison is computed **inside a single
  (pair, month) cell** (or weekly, Q-A2). We never compare dispersion across
  months of a drifting price.
- **AMM label.** `coalesce(known_taker_source,'') = 'tibet2'` (the NULL trap).
  tibet2 is the only labeled AMM taker and **exists only 2025-04+** — so the
  within-cell AMM-vs-P2P split is restricted to `date_completed >= 2025-04-01`
  (204,262 offers; all 160,622 tibet2 fills fall in this window, Q0).
- **Sample floors.** A cell needs enough fills to estimate dispersion: the paired
  split requires **≥10 fills of *each* side**; cell-level tests use ≥15/≥20.

**Coverage caveat** (`README.md`): the per-pair 10k API cap drops the
*oldest* offers of the busiest CAT↔XCH pairs, so the earliest cells' **sample
depth is a floor**. Dispersion is a within-month *ratio* of the offers we do have,
so the price *level* is unaffected; only the thinnest early cells are noisier.

---

## Headline findings

| Claim | Number | Confidence |
|---|---|---|
| Within the same (pair, month), AMM-fill rel-IQR vs P2P-fill rel-IQR | **0.149 vs 0.127** — AMM *not* tighter (n=207 cells) | **High** |
| Cells where AMM is the tighter side (the rest P2P) | **88 of 207** (P2P tighter in 119) | **High** |
| Same test, weekly bins (less intra-period drift) | **0.070 vs 0.056** — same direction (P2P tighter 197/343) | **High** |
| Same test, MAD/median instead of IQR/median | **0.060 vs 0.049** — robust to metric | **High** |
| Same test, **high-liquidity** cells (≥50 each side) | **0.136 vs 0.102** — effect *strengthens* (P2P tighter 53/84) | **High** |
| Naive cross-pair "no-AMM cells are tighter" signal | driven by **one peg-like CAT (MJO)**, rel-IQR ≈ 0.0001 — composition artifact | **High** |
| Event study: a CAT's rel-IQR pre- vs post- its pool appearing | drops **0.30 → 0.18** (63/89 CATs tighter) … | **Medium** |
| …but the **placebo** (CATs that *never* get a pool) tightens *more* | **0.46 → 0.22** over their own lifetime | **Medium** |

**Bottom line:** the clean, drift-controlled test (hold pair *and* month fixed)
says **the AMM does not tighten price dispersion** — its continuous quotes are
marginally *wider*-scattered than contemporaneous human offers, which cluster on
repeated/round anchors. T1 was right to punt; the honest answer once you bin
properly is a **null**, and the tempting "yes" you get from a naive compare is
two confounds (CAT composition + market maturation) in disguise.

---

## CHART 1 — Within-(pair,month) AMM vs P2P dispersion: AMM is *not* tighter

The decisive figure. For each (pair, month) cell with ≥10 fills of **each** side
(2025-04+), compute the rel-IQR of the AMM (tibet2) fills and of the P2P fills
**in that same cell**, then take the median across cells. Pair and month are both
held fixed, so CAT identity and price-level drift cancel — the exact control T1
lacked. Robustness rows vary the bin width, the dispersion metric, and the
liquidity floor; the sign never flips.

| variant | n cells | AMM med rel-disp | P2P med rel-disp | cells AMM tighter | cells P2P tighter |
|---|---|---|---|---|---|
| monthly, IQR/median (primary) | 207 | **0.149** | **0.127** | 88 | 119 |
| weekly, IQR/median | 343 | 0.070 | 0.056 | 146 | 197 |
| monthly, MAD/median | 207 | 0.060 | 0.049 | 89 | 118 |
| monthly, ≥50 each side (liquid) | 84 | 0.136 | 0.102 | 31 | 53 |

(Per-cell detail: `research/dexie-offers/findings/data/10-amm-tightening-within-cell-paired.csv`,
210 rows — code, month, n_amm, n_p2p, both rel-IQRs, amm_tighter flag.)

Reading: in every variant the AMM's fills are *more* dispersed, P2P wins the
majority of cells, and the gap **widens** on the most liquid pairs (where the AMM
should help most if the thesis were true). Monthly medians swing 0.07–0.25 cell to
cell (memecoin volatility) with no side consistently ahead — itself evidence of
*no systematic* AMM tightening.

---

## CHART 2 — Why the naive cross-pair test LIES (the confound, made visible)

If you skip binning and just bucket (pair, month) cells by their AMM share and
compare overall dispersion, you get a seductive but **false** "AMM helps" picture
— because the buckets contain *different CATs*. Post-Apr cells, n≥20 (Q-B1):

| AMM share of cell | n cells | median rel-IQR | median n |
|---|---|---|---|
| none (<5%) | 25 | **0.0001** | 172 |
| low (5–33%) | 22 | 0.353 | 70 |
| mid (33–66%) | 79 | 0.168 | 145 |
| high (≥66%) | 814 | 0.173 | 55 |

The "no-AMM" bucket's near-zero dispersion looks like a slam-dunk for "AMM markets
are *less* clean", but it is **composition**: that bucket is dominated by **MJO**
(10 of 25 cells, rel-IQR ≈ 0.0001 — a peg-like fixed-price CAT), plus a handful of
one-off low-volume CATs (Q-B2). It says nothing about the AMM. This is precisely
the T1 trap restated, and it's why only the **within-cell paired** test (Chart 1)
can answer the thesis.

---

## CHART 3 — Event study + placebo: tightening is market maturation, not the AMM

The brief's required transition test. For each CAT, find the first month it gets
AMM activity (≥3 tibet2 fills) and compare that CAT's *own* rel-IQR before vs
after (within-CAT, so composition is controlled). Then a **placebo**: CATs that
*never* get a pool, split at their median month, early-half vs late-half.

| group | n CATs | "before"/early rel-IQR | "after"/late rel-IQR | within-CAT Δ | tighter after/late |
|---|---|---|---|---|---|
| **AMM-transition** (Q-C1) | 90 | 0.301 | 0.179 | −0.084 | 63 / 89 |
| **PLACEBO, never-AMM** (Q-D1) | 20 | 0.457 | 0.220 | −0.171 | 13 / 20 |

(Per-CAT event-study detail: `research/dexie-offers/findings/data/10-amm-tightening-event-study.csv`,
90 rows.)

Yes, a CAT's price dispersion drops after its pool appears (0.30→0.18). But CATs
that **never** get a pool tighten just as much, in fact **more** (0.46→0.22), over
their own lifetimes. The tightening is **market maturation** — new CATs launch
chaotic and settle down as liquidity and a consensus price form — and the AMM is
*not* the cause. (Placebo n=20 is small and the splits aren't calendar-aligned, so
this is Medium confidence, but it's directionally decisive: the event study cannot
be read as an AMM effect.)

---

## CHART 4 — Mechanism: AMMs emit a continuous quote; humans cluster on anchors

*Why* would AMM fills be no tighter? Modal-price concentration per cell (post-Apr,
n≥20, Q-E1):

| fill type | median modal-price share | median distinct-prices ratio |
|---|---|---|
| P2P (human) | 0.039 | 0.905 |
| AMM (tibet2) | 0.022 | **1.000** |

Every AMM fill is a **distinct** price (ratio 1.0) — the constant-product curve
moves with each trade and tracks every intra-period XCH wobble, so the AMM samples
the *whole* price path within a month. P2P offers repeat prices more (90.5%
distinct vs 100%) and cluster on round-number anchors (per finding 01: 48.8% of
P2P XCH amounts are ×0.05, vs 14.7% for AMM). That clustering mechanically
*compresses* P2P's measured dispersion. So the AMM isn't "noisier" in a bad sense
— it is a faithful continuous quote, while human dispersion is partly an illusion
of discretization. Either way, the thesis "AMM ⇒ lower dispersion" is **not**
supported by the data.

---

## What this does and doesn't say

- It says: **conditional on a trade settling, AMM fills are not less price-
  dispersed than contemporaneous human fills of the same pair, in the same month.**
  The clean within-cell test (Chart 1) is unambiguous and robust.
- It does **not** say the AMM is useless or harmful. The AMM's real, defensible
  contributions are documented in finding 01: it fills ~46%+ of volume, settles in
  ~35 s vs ~3.9 h, and provides always-available liquidity. *Tightening realized
  price dispersion* is simply not one of its demonstrable effects here.
- It does **not** measure on-chain *bid-ask spread* or slippage (the offer dataset
  has no resting order book — only fills). "Dispersion of settled prices" is the
  closest proxy the data allows, and it is the metric the thesis is framed in.

---

## Caveats

1. **Label coverage starts 2025-04-02.** The within-cell AMM-vs-P2P split
   (Charts 1, 4) can only use 2025-04+ data — tibet2 is the only labeled AMM taker
   and is blank before. Event study (Chart 3) uses all history but inherits this
   for defining "first AMM month."
2. **tibet2 is a floor on AMM activity.** Unlabeled AMMs/bots sit in the "P2P"
   group, which would, if anything, make the P2P group *look more AMM-like* and
   bias *toward* the thesis — yet the thesis still fails. So the null is
   conservative.
3. **Per-pair 10k cap.** Oldest fills of the busiest CAT↔XCH pairs are truncated,
   so early-cell sample depth is a floor. Dispersion is a within-cell ratio, so the
   level is robust; the effect is computed on cells with ≥10–50 fills, well above
   the noise floor.
4. **Placebo is small (n=20).** Few CATs have ≥4 high-volume months and *zero*
   tibet2 fills. The placebo is directional, not a precise counterfactual — hence
   Medium confidence on the maturation attribution (Chart 3). The within-cell test
   (Chart 1) does not depend on it and is High confidence.
5. **Discretization confound runs the *other* way.** P2P round-number clustering
   compresses P2P dispersion (Chart 4), making the null *understate* how
   not-tighter the AMM is. Adjusting for it would only deepen the null, not reverse
   it.

## Per-claim confidence summary

- AMM not tighter within (pair, month): **High** (robust across bin width, metric,
  liquidity floor; majority of cells favor P2P).
- Naive cross-pair signal is a composition artifact (MJO): **High** (traced to the
  specific CAT).
- Event-study pre/post drop is maturation, not AMM (placebo): **Medium** (small
  placebo n; directionally decisive).
- Mechanism (AMM continuous vs human anchored): **High** for the descriptive
  modal-share fact; **Medium** as the *explanation* for the null.

## Artifacts

- Query: `research/dexie-offers/analysis/10-amm-tightening.sql` (Q0, Q1, Q-A1…A5, Q-B1/B2,
  Q-C1, Q-D1, Q-E1 + 2 CSV exports).
- `research/dexie-offers/findings/data/10-amm-tightening-within-cell-paired.csv` (210 cells).
- `research/dexie-offers/findings/data/10-amm-tightening-event-study.csv` (90 CATs).
