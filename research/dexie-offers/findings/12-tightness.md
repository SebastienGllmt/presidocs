# 12 — A market maker's eye view: price tightness & pick-off speed

**Thesis (T12).** Treat this dataset the way a market maker (MM) sizing up a venue
would: *How tight is the market, and if I post a resting quote, how badly and how
fast do I get picked off?* The answer the settled data gives is sharp and
two-sided: **spreads are genuinely tight (~1% effective half-spread on the liquid
XCH↔USD market), but depth is thin (~$800/day) and the moment you misprice in the
taker's favor, a bot eats you — favorable offers settle in tens of seconds while
fairly/richly-priced ones sit for many minutes to hours.** So on Chia you must
quote *actively*; a resting quote is an option you are writing to arbitrage bots
for free.

All numbers come from `research/dexie-offers/analysis/12-tightness.sql`, run read-only against
`generated/offers.duckdb` (snapshot 2026-05-23). It reuses T3's price-direction
normalization and trusted-stablecoin universe, T10's `cat_per_xch` normalization,
and T5's time-to-fill construct. Series CSVs in `research/dexie-offers/findings/data/12-*.csv`.

---

## ⚠️ THE INFERENCE BOUNDARY (read this first — it shapes everything below)

**This dataset is SETTLED offers only. There is no resting / cancelled order
book.** dexie records an offer when it *fills on-chain*; it never shows the cloud
of off-price offers that sat unfilled or were cancelled off-chain. Consequences a
MM must internalize:

1. **I cannot directly measure spread the way a CEX order book lets you** (best bid
   vs best ask of *resting* quotes). There are no resting quotes here. So
   "tightness" is inferred from **how concentrated *settled* prices are around a
   rolling fair value** — a realized-price dispersion, not a quoted spread.
2. **I cannot see the offers that *didn't* get picked off.** The pick-off signal is
   inferred from **the SPEED at which favorably-priced offers settle**, not from
   watching cancellations. A maker who posted a smart (rich) quote and cancelled it
   before anyone hit it is simply invisible.
3. **Survivorship cuts the other way too:** every row is a *completed* trade, so
   the deviations we see are deviations that *cleared*. The genuinely absurd
   mispricings never settled (T5: settled-data spam ≈ 0.47%). The market looks
   clean partly *because* settlement is the filter.

Everything below is therefore an **inference about market quality from realized
fills**, and I flag confidence per claim. The pick-off result (Finding 2) is the
strongest because it uses an internal, hard-to-confound axis (favorability vs
time), and it is exactly the MM-relevant question.

**Other caveats inherited from the dataset (`README.md`, 00-recon, T5):**
84.7% coverage biased toward dropping the *oldest* offers of the busiest pairs
(early counts are floors); `date_found` is dexie's first-seen, **not** offer
creation, so time-to-fill is a **floor** on true resting time (67 warp rows with
`date_completed < date_found` dropped); USD figures assume warp coins ≈ $1.

---

## Method (load-bearing constructs)

- **Universe.** The liquid testbed is **single-pair (1×1) XCH↔warp-stablecoin
  offers** (codes `wUSDC.b`, `wUSDC`, `wUSDT` — the validated $1 pegs per T3;
  USDSC/TIBET-LP rejected). **19,910 offers, 19,843 with a usable time-to-fill,
  2024-05-20 → 2026-05-23** (Q0). Generalization tested on the top liquid
  CAT↔XCH pairs (Q7).
- **Direction-normalized price** = `requested.amount / offered.amount`, rebuilt
  from the two legs so both directions of the pair land on one canonical
  `usd_per_xch` scale (T3 machinery). Trimmed to [0.2×, 5×] of the day's raw
  median to drop junk.
- **Fair price (two robust estimators, median never mean).**
  - *Daily fair*: per-(pair, day) median. Simple, but a volatile day's intraday
    drift inflates a fill's apparent deviation → read those as an **upper bound**.
  - *Rolling fair*: median of the **51 nearest-in-time trades** (25 each side),
    time-ordered. Drift-controlled; used for the headline pick-off curve.
- **Taker favorability** (the new construct, the MM axis). A taker *receives* the
  maker's `offered` leg and *pays* the `requested` leg, so a good deal for the
  taker = the maker priced the offered asset **cheap vs fair**:
  - maker offered XCH (selling XCH) → taker is buying XCH, wants price LOW →
    `taker_fav = -(price-fair)/fair`
  - maker requested XCH (buying XCH) → taker is selling XCH, wants price HIGH →
    `taker_fav = +(price-fair)/fair`
  - **`taker_fav > 0` ⇔ the taker got a better-than-fair deal ⇔ the MAKER got
    picked off.** This is the axis a resting MM cares about.

---

## Headline findings

| Claim | Number | Confidence |
|---|---|---|
| Effective half-spread on liquid XCH↔USD (median \|dev\| from rolling fair) | **0.99%** | **High** |
| Settled trades within ±1% / ±2% / ±5% of fair | **51% / 73% / 93%** | **High** |
| Pick-off: median time-to-fill, very-cheap (>+5% favorable) vs fair vs rich (<−2%) | **~38 s vs ~575 s vs ~540 s** | **High** |
| Sub-minute fill share, very-cheap vs fair vs rich | **65% vs 27% vs ~25%** | **High** |
| Pick-off strength (Spearman, favorability vs time-to-fill, n=19,824) | **−0.186** | **High** |
| The pick-off agent: AMM fills vs other/P2P (median ttf, 2025-04+) | **51 s vs 1,111 s**; AMM 53.8% sub-min vs P2P 8.6% | **High** |
| Depth: median trades/day, median USD volume/day, total volume | **17 trades, ~$800, ~$1.7M total** | **High** |
| Tightening over time (median \|dev\|, 2024 → 2025–26) | **~1.6–2.0% → ~1.0–1.2%** | **Medium** |

**Bottom line for a MM:** the price is *known* and *tight* — but the venue is a
**thin retail tape patrolled by fast arbitrage bots (mostly the TibetSwap AMM)**.
Any quote you leave resting that drifts in the taker's favor is filled in seconds;
quotes that stay at-or-above fair just sit. That is the textbook adverse-selection
trap: **you keep the bad fills and lose the good ones.**

---

## Finding 1 — TIGHTNESS: ~1% effective half-spread, but it's realized-dispersion, not a quoted book

**Confidence: HIGH** (large-n, two fair-price estimators agree).

Against the drift-controlled **rolling fair**, the distribution of settled-price
absolute deviation on the liquid XCH↔USD market (Q1, n≈19,891):

| metric | value |
|---|---|
| within ±0.5% of fair | 31.9% |
| **within ±1%** | **50.6%** |
| within ±2% | 72.5% |
| within ±5% | 92.6% |
| **median \|deviation\|** | **0.99%** |
| p75 \|deviation\| | 2.18% |

So a taker hitting a random settled offer faces a **~1% effective half-spread**
(median), and the full ±5% band captures 93% of flow. This is consistent with T3's
independently-derived **1.83% median bid/ask spread** (T3 splits by maker direction;
I measure dispersion around fair — same market, ~1–2% wide). For a thin,
permissionless, off-chain-order venue, **that is tight** — comparable to a
mid-tier CEX altcoin pair.

**The honest caveat:** this is *dispersion of realized fills*, not a quoted
bid-ask. There is no resting book to read a spread off (the inference boundary). A
trade landing "within ±1% of fair" means the price that *cleared* was within 1% of
the rolling median of nearby clears — it does **not** mean a taker could always get
filled within 1% on demand. Depth (Finding 4) is the missing half of that picture.

### Did it tighten as the bots/AMM grew? (Medium confidence)

Quarterly median \|dev\| from the *daily* fair (Q2 — upper bound, since daily fair
absorbs intraday drift):

| quarter | n | median \|dev\| | within ±1% |
|---|---|---|---|
| 2024-Q2 | 424 | 1.65% | 36.6% |
| 2024-Q3 | 745 | 1.33% | 44.2% |
| 2024-Q4 | 2,537 | 2.03% | 29.4% |
| 2025-Q2 | 2,861 | 1.13% | 46.2% |
| 2025-Q3 | 4,408 | **1.04%** | **48.0%** |
| 2026-Q1 | 2,413 | 1.12% | 46.5% |
| 2026-Q2 | 2,343 | 1.19% | 43.9% |

There is a **modest tightening** from the noisy ~1.6–2.0% of 2024 to a steadier
~1.0–1.2% in 2025–26, plausibly as AMM/bot liquidity matured — but it is noisy
(2024-Q4 is a volatile-price outlier) and partly XCH-volatility-driven, so I hold
this at **Medium**. It is consistent with, but not proof of, "bots made it
tighter." (T10 separately shows the AMM does **not** reduce *within-(pair,month)*
dispersion — so attribute any tightening to market maturation, not the AMM curve.)

**Chart 1 — weekly tightness + depth** (data:
`research/dexie-offers/findings/data/12-tightness-weekly.csv`, 105 weeks: week, n_trades,
med_absdev_pct, pct_within_1pct, usd_volume). Sparkline of quarterly median \|dev\|:
`1.65 → 1.33 → 2.03 → … → 1.04 → 1.12 → 1.19`.

---

## Finding 2 — PICK-OFF SPEED (the headline): favorable offers vanish in seconds

**Confidence: HIGH.** This is the core MM result and it uses an internal,
hard-to-confound axis (price-favorability vs time), not an external benchmark.

For every settled XCH↔USD offer, bucket it by **taker favorability** (how far the
maker priced it in the taker's favor vs rolling fair) and read the median
time-to-fill and sub-minute share (Q3, the headline curve):

| favorability (taker's edge vs fair) | n | median time-to-fill | % sub-minute |
|---|---|---|---|
| < −5% (very rich — bad for taker) | 752 | 273 s | 40.6% |
| −5 .. −2% | 1,924 | 530 s | 27.5% |
| −2 .. −1% | 2,139 | 586 s | 23.3% |
| −1 .. −0.2% | 3,415 | 656 s | 23.1% |
| **±0.2% (fair)** | 3,366 | **573 s** | 26.9% |
| +0.2 .. +1% | 3,271 | 211 s | 35.1% |
| +1 .. +2% | 2,179 | 54 s | 52.8% |
| +2 .. +5% | 2,066 | 40 s | 62.9% |
| **> +5% (very cheap — great for taker)** | 712 | **38 s** | 65.4% |

Read the **favorable half (fair → very cheap)**: as the deal gets better for the
taker, median time-to-fill collapses **573 s → 211 → 54 → 40 → 38 s** and the
sub-minute share climbs **27% → 65%**. **A maker who underprices by >2% is filled
in ~40 seconds, two-thirds of the time within a single minute.** That is the
pick-off: *mispriced-cheap offers disappear almost instantly* because arbitrage
bots are watching the tape and snap them. The monotone relationship is confirmed by
a **Spearman correlation of −0.186** between favorability and time-to-fill
(n=19,824, Q4) — small in magnitude (time-to-fill has huge idiosyncratic variance)
but unambiguous in sign and direction at this n.

**The rich half is the mirror image, with one caveat.** Offers priced *against*
the taker (−1 to −5%) sit ~9–11 minutes — they are not attractive, so nobody races
for them; they wait for a patient counterparty. The `< −5% (very rich)` bucket
filling somewhat *faster* (273 s) is the **daily-vs-rolling fair-drift residual**:
on a fast-moving day a fill that looks "5% rich" vs the window median was at-fair
when it actually executed (it is also the adverse-selection signal — see
Finding 3). The clean, drift-controlled signal is the favorable-half monotone
collapse, and it is robust to the fair-price estimator.

**Chart 2 — the pick-off curve** (data:
`research/dexie-offers/findings/data/12-tightness-pickoff-curve.csv`, 9 buckets: fav_bucket, n,
med_ttf_sec, pct_submin). Plot favorability (x) vs median time-to-fill (y, log) and
sub-minute share — the favorable half drops off a cliff.

### Who does the picking off? The AMM. (HIGH)

Splitting 2025-04+ fills (where the taker is labelled) by AMM vs other (Q5):

| taker | n | median ttf | median favorability | % cheap (>+1%) | % sub-minute |
|---|---|---|---|---|---|
| **AMM (tibet2)** | 6,828 | **51 s** | +0.17% | 34.0% | **53.8%** |
| other / P2P (unlabelled) | 6,571 | **1,111 s** | −0.12% | 20.3% | **8.6%** |

The AMM fills in **51 s (54% sub-minute)** and its fills skew *favorable to the
taker* (+0.17% median, 34% are >1% cheap) — it is the bot that scoops underpriced
offers. The "other/P2P" bucket sits **~18 minutes (only 8.6% sub-minute)** and
skews slightly rich. **The fast, opportunistic taker is the AMM; the slow,
patient one is everything else.** (tibet2 is the *only* labelled taker, so "other"
contains unlabelled bots too — meaning the AMM-vs-rest gap is if anything a floor.)

---

## Finding 3 — ADVERSE SELECTION / staleness (the resting-quote killer)

**Confidence: MEDIUM** (the signal is real but partly entangled with daily-fair
drift; the dataset has no order book to confirm the price "moved through" a quote).

The `< −5%` bucket in Finding 2 — offers that look *very rich* against the window
median yet fill relatively fast (273 s, 40.6% sub-minute) — is the staleness
fingerprint. Mechanically: a maker posts a quote; XCH moves; the quote is now
**stale and on the wrong side**, i.e. it has become a *gift* to a taker on the new
level even though it reads "rich" against a fair price that has since moved.
Bots/arbitrageurs take it on the move. This is the **adverse-selection cost of
resting**: the fills you get are disproportionately the ones where the market moved
through your price. A resting MM keeps exactly these (the move went against them)
and loses the fills where the market moved *their* way (those they'd have wanted to
keep, but a faster quote captured them first — invisible here, the inference
boundary).

I flag this **Medium** because with settled-only data I cannot separate "stale
quote picked off on a move" from "daily-fair-drift artifact" cleanly — both produce
a fast fill at an apparently-off price. The directional evidence (rich-but-fast tail
+ AMM favorability skew) is consistent with adverse selection, but it is an
inference, not a measurement of realized markout.

---

## Finding 4 — DEPTH / capacity: the market is TIGHT but THIN

**Confidence: HIGH** (direct counts; USD ≈ $1-peg assumption).

What a MM could realistically clear on the liquid XCH↔USD warp market (Q6):

| scope | active days | median trades/day | p90 trades/day | median USD vol/day | total USD vol |
|---|---|---|---|---|---|
| all (2024-05 → 2026-05) | 715 | **17** | 63 | **~$801** | **~$1.70M** |
| recent (2025-04+) | 416 | 19.5 | 73 | ~$792 | ~$0.96M |

Tie this to T5's **median 0.2 XCH / ~$11.42 trade** and the extreme concentration
(T4 Gini ≈ 0.89): the *entire* trusted XCH↔USD tape is **~17 trades and ~$800 a
day**, ~$1.7M cumulative over two years. (The per-pair 10k API cap truncates the
oldest busiest-pair fills, so early-period depth is a **floor** — but the daily
*rate* is recent-dominated and reliable.) A MM deploying even five figures of
capital here is a **meaningful fraction of daily volume**; you cannot rest size and
wait — there isn't enough flow, and what flow exists is bot-contested. The market
is the opposite of deep: **tight quotes, shallow book.**

---

## Finding 5 — GENERALIZATION: the pick-off pattern holds for CATs too

**Confidence: HIGH for the shape; the deep-discount tail is memecoin-fair-noise.**

The same favorability→speed curve on the top liquid CAT↔XCH pairs (SBX, DBX, BEPE,
MBX, BYC, HOA, NIOC, 🐈; `cat_per_xch` normalization, per-pair daily fair, Q7):

| favorability | n | median time-to-fill | % sub-minute |
|---|---|---|---|
| < −5% (very rich) | 12,872 | **25,784 s (~7.2 h)** | 23.0% |
| −5 .. −2% | 12,063 | 12,403 s (~3.4 h) | 25.6% |
| −2 .. −0.5% | 14,730 | 2,477 s (~41 min) | 32.6% |
| **±0.5% (fair)** | 43,136 | **42 s** | 61.4% |
| +0.5 .. +2% | 17,929 | 59 s | 50.2% |
| +2 .. +5% | 13,094 | 59 s | 50.2% |
| > +5% (very cheap) | 8,873 | 148 s | 40.6% |

The dominant signal is even stronger than for stablecoins: **richly-priced CAT
offers sit for HOURS** (rich = 3–7 h) while **at/near-fair offers fill in ~42 s**
(the giant 43k at-fair bucket = AMM fills clustered at the pool price). The
`> +5% very cheap` tail is *slower* here (148 s) — a CAT-specific effect: a
memecoin's daily-median fair is noisy, and deeply-below-fair CAT offers are often
genuinely-illiquid odd lots, not clean bot targets. But the core MM lesson is
identical: **price your CAT quote rich and it rots; price it at-or-below the pool
and a bot fills it instantly.**

---

## Bottom line for a market maker deploying capital on Chia

1. **Spreads are tight (~1% effective half-spread; 73% of fills within ±2% of
   fair).** The fair price is well-known and the market is honest (settlement
   filters junk to <0.5%). On price quality alone, this looks investable.
2. **But you will be picked off if you rest.** Any quote that drifts >2% into the
   taker's favor is gone in **~40 seconds**, 2/3 of the time within a minute; the
   picker is the **TibetSwap AMM and other bots** (AMM median fill 51 s vs P2P
   ~18 min). Your resting quote is a free option you've written to faster players.
3. **Depth is thin (~17 trades / ~$800 a day; ~$1.7M total; median trade ~$11).**
   There isn't enough flow to rest size profitably even if you weren't being
   picked off.
4. **Therefore: quote actively, don't rest.** To make money here you must be one
   of the fast players — reprice on every XCH move, or run an AMM-style always-on
   quote that updates continuously — not post a static resting order and walk
   away. A passive resting strategy on Chia offer files is structurally
   short-gamma: you keep the adverse fills and lose the good ones. *(This is an
   inference from realized-fill behavior, consistent with standard
   adverse-selection theory; the settled-only data cannot prove the cancelled-quote
   counterfactual — see the inference boundary.)*

---

## Per-claim confidence summary

| claim | confidence | basis |
|---|---|---|
| ~1% effective half-spread; 51/73/93% within ±1/2/5% | HIGH | large-n, two fair estimators agree, matches T3 |
| Favorable offers fill in ~40 s; fair ~575 s (monotone, Spearman −0.186) | HIGH | n=19,824, robust to fair estimator |
| The pick-off agent is the AMM (51 s vs 1,111 s P2P) | HIGH | direct split, 2025-04+ labelled takers |
| Depth ~17 trades / ~$800 / day; ~$1.7M total | HIGH | direct counts (USD ≈ $1 peg) |
| Pattern generalizes to top CAT↔XCH pairs | HIGH (shape) | Q7 |
| Modest tightening over time (~1.6–2.0% → ~1.0–1.2%) | MEDIUM | noisy, daily-fair upper bound, XCH-vol-driven |
| Adverse selection from stale quotes picked off on moves | MEDIUM | inferred; entangled with daily-fair drift; no order book |
| "Quote actively, don't rest" MM takeaway | MEDIUM (inference) | follows from above + theory; cancelled-quote counterfactual unobservable |

**Biggest caveat (restated):** SETTLED offers only — no resting/cancelled book.
Tightness is realized-fill dispersion (not a quoted spread) and the pick-off is
inferred from fill *speed* (not from observing cancellations). `date_found` is
first-seen so all times-to-fill are floors.

## Artifacts

- Query: `research/dexie-offers/analysis/12-tightness.sql` (Q0–Q7 + 2 CSV exports).
- `research/dexie-offers/findings/data/12-tightness-pickoff-curve.csv` (9 favorability buckets).
- `research/dexie-offers/findings/data/12-tightness-weekly.csv` (105 weeks: tightness + depth).
