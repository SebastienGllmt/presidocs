# 01 — AMM vs P2P: automated market-making is a large, growing share of offer-file trades

**Thesis (T1).** Offer files are pitched as trustless peer-to-peer trades, but in
practice automated market-making (AMM) is a large and growing share of real
settled activity. We quantify the AMM-vs-P2P split and show AMM fills are
mechanically distinct from human P2P trades.

All numbers come from `research/dexie-offers/analysis/01-amm.sql`, run read-only against
`generated/offers.duckdb` (snapshot 2026-05-23). Method notes inline.

---

## How we identify AMM activity (and why it's a floor)

dexie stamps `known_taker_source = 'tibet2'` **only** when the taker is the
**TibetSwap AMM**, and **only since 2025-04-02** (zero coverage before; verified
Q0). No other AMM/bot is labeled. So every AMM number here is a **floor** on true
automation — other AMMs and arbitrage bots are invisible in this field.

Trap respected throughout: `coalesce(known_taker_source,'') = 'tibet2'` (a raw
`= 'tibet2'` returns NULL for the 80% of rows where the column is NULL, which
`avg()`/`sum()` silently drop).

**tibet2 fills are pure fungible CAT↔XCH swaps** (Q2), which validates reading
them as AMM swaps:
- **0** of 163,603 tibet2 fills involve an NFT (AMMs don't trade NFTs). ✔
- **163,603 / 163,603 (100%)** involve XCH — consistent with TibetSwap's
  CAT-paired-with-XCH pool model. ✔
- **98.2%** of tibet2 fills are single-pair (1×1) simple swaps, vs 91.6% of P2P.

---

## Headline findings

| Claim | Number | Confidence |
|---|---|---|
| Share of all settled offers since 2025-04 filled by the TibetSwap AMM | **46.2%** (163,603 / 354,521) | **High** (direct label; floor) |
| Recent monthly AMM share (2026-03) | **67.4%**, up from ~36% at the 2025-04 start | **High** (floor; partial end-months noted) |
| AMM median time-to-fill | **0.58 min (~35s)** vs P2P **235.9 min (~3.9h)** | **High** |
| AMM offers settling sub-minute | **70.7%** vs P2P **20.7%** | **High** |
| P2P offers with a round XCH amount (×0.05) | **48.8%** vs AMM **14.7%** | **High** |
| TIBET-* LP tokens involved in offers | **4.49%** of all offers (37,431) | **High** |
| Hidden bot-like fills in the *unlabeled* P2P pool (inference) | **~7.6%** of non-tibet XCH↔CAT offers | **Low–Med (inference)** |

**Bottom line:** since dexie began labeling AMM fills, **~46% of all settled
offer-file trades are AMM swaps, and the share is trending up toward ~60–67% in
2026.** This is a floor. The "trustless P2P trade" framing describes the
mechanism, but the dominant *use* of that mechanism is now a bot quoting against
a liquidity pool.

---

## CHART 1 — AMM share of settled offers, monthly (since 2025-04)

A stacked/line chart of `pct_tibet2` over time. The cleanest single figure for
the thesis: AMM is ~half of all activity and rising.

> Caveat for the figure: **2025-04 is partial** (data starts 2025-04-02) and
> **2026-05 is partial** (snapshot 2026-05-23). Read the interior months for
> trend. Months are noisy (memecoin launches swing the mix), but the floor never
> drops below ~26% and the 2026 cluster sits at 44–67%.

Data (`research/dexie-offers/findings/data/01-amm-monthly-share.csv`):

| month | n_offers | n_tibet2 | pct_tibet2 |
|---|---|---|---|
| 2025-04* | 13,945 | 4,989 | 35.78 |
| 2025-05 | 18,133 | 8,301 | 45.78 |
| 2025-06 | 30,946 | 18,404 | 59.47 |
| 2025-07 | 28,799 | 12,473 | 43.31 |
| 2025-08 | 38,945 | 10,221 | 26.24 |
| 2025-09 | 34,356 | 9,656 | 28.11 |
| 2025-10 | 28,959 | 15,270 | 52.73 |
| 2025-11 | 26,256 | 8,519 | 32.45 |
| 2025-12 | 16,940 | 7,652 | 45.17 |
| 2026-01 | 24,778 | 10,933 | 44.12 |
| 2026-02 | 19,085 | 10,829 | 56.74 |
| 2026-03 | 26,435 | 17,822 | 67.42 |
| 2026-04 | 24,257 | 15,314 | 63.13 |
| 2026-05* | 22,687 | 13,220 | 58.27 |

(*partial month)

---

## CHART 2 — AMM fills settle almost instantly; P2P offers sit

Grouped bars (AMM vs P2P) of median time-to-fill and sub-minute share. This is
the mechanical "tell": an AMM accepts a matching offer the moment it appears; a
human-posted P2P offer waits hours/days for a counterparty. Post-Apr-2025 window,
all offers (Q3).

| metric | AMM (tibet2) | P2P (other) |
|---|---|---|
| n | 163,603 | 190,918 |
| median time-to-fill | **0.58 min** | 235.87 min |
| p90 time-to-fill | 318.7 min | 725,725.9 min (~1.4 yr tail) |
| % settled sub-minute | **70.71%** | 20.70% |
| % settled < 5 min | 84.74% | 31.96% |
| % zero-fee | 60.67% | 90.67% |

Note the fee inversion: AMM takers attach a network fee far more often (only
60.7% zero-fee vs 90.7% for P2P) — consistent with a bot paying to win the
mempool race to fill.

---

## CHART 3 — Amount fingerprint: humans pick round numbers, AMMs emit continuous quotes

Grouped bars of two amount-shape metrics on the common XCH leg, single-pair
XCH↔CAT offers, post-Apr-2025 (Q5). `pct_round_05` = XCH amount is a multiple of
0.05; `pct_many_decimals` = amount has precision finer than 1e-3 (a pool-derived,
non-human number).

| metric | AMM (tibet2) | P2P (other) |
|---|---|---|
| n | 160,622 | 127,681 |
| % round (multiple of 0.05 XCH) | 14.71 | **48.76** |
| % whole XCH | 7.92 | 9.50 |
| % "continuous" amount (>1e-3 precision) | **52.56** | 25.38 |

Supporting size distribution (Q4, XCH leg, single-pair post-Apr): AMM spans dust
to large (p25 0.003 / median 0.21 / p95 9.06 XCH); P2P clusters on tidy numbers
(p25 0.1 / median 0.2 / p75 0.5 / p95 5.0 XCH). Humans trade in round lots; the
AMM quotes whatever the pool math returns.

---

## CHART 4 — TIBET-* LP tokens trade as a P2P secondary market (and even buy NFTs)

LP tokens are AMM liquidity receipts, yet they show up in **4.49% of all offers
(37,431)** — and **only 8.9% (3,335) of those are tibet2-filled**, so LP tokens
are overwhelmingly moved P2P, not minted/burned through the AMM taker path
(Q7). Structure of LP offers (asset kinds appearing alongside the LP token):

| structure | n | reading |
|---|---|---|
| CAT + LP + XCH | 23,761 | liquidity add/remove (deposit XCH+CAT ↔ receive LP) |
| LP + NFT | 12,092 | **LP tokens used as currency to buy/sell NFTs** |
| LP + XCH | 1,525 | pure LP↔XCH secondary swap |
| (other) | 53 | negligible |

So the AMM's footprint on offer files is bigger than the swap count alone: a
whole secondary economy of *trading the liquidity positions themselves* runs over
offer files. The LP-token monthly series is in
`research/dexie-offers/findings/data/01-amm-lp-monthly.csv` (37 months, 2023-05 → 2026-05;
peak 5,154 in 2025-09). Note LP activity predates the `known_taker` label, which
is why it appears back to 2023.

---

## OTHER bot/AMM signals — inference only (do not overclaim)

The tibet2 label is a floor. As a *rough* probe for unlabeled automation, we
applied the AMM fingerprint (sub-minute fill **and** continuous, non-round
amount) to the **non-tibet** single-pair XCH↔CAT population post-Apr-2025 (Q6):

- **9,715 of 127,681 (7.6%)** non-tibet offers carry both bot tells.

This is **suggestive, not conclusive** — some are genuine fast human fills, some
unlabeled AMMs/arbitrage bots, some other dexie-side automation. It is offered
only to substantiate "46% is a floor," not as a second hard number. Confidence:
**Low–Medium (inference)**.

---

## Caveats

1. **AMM share is a floor, not a ceiling.** `tibet2` is the only labeled taker;
   other AMMs/bots are invisible. The true automated share is ≥46%.
2. **Label coverage starts 2025-04-02.** No AMM-share statement can be made about
   the pre-2025-04 era from this field. (LP-token trading, Chart 4, *can* be seen
   earlier because it keys on asset code, not the taker label.)
3. **Per-pair 10k API cap bias.** The dataset undercounts the oldest offers of the
   busiest fungible pairs (CAT↔XCH, stablecoins) — exactly the pairs AMMs trade.
   This biases early-timeline *absolute* counts downward; the **AMM *share*** (a
   ratio within each month) is far more robust than absolute volumes. Treat any
   absolute AMM count, especially pre-2025, as a floor.
4. **Partial end-months** (2025-04 start, 2026-05 snapshot) — flagged on Chart 1.
5. **Price-dispersion comparison was attempted but is inconclusive.** Per-pair
   AMM-vs-P2P relative dispersion does not cleanly favor AMM because tibet2 fills
   span many months and the pool price drifts over that window (a fair test needs
   per-month, per-pair binning). We deliberately did **not** publish a
   "AMM prices are tighter" claim. The time-to-fill and amount-fingerprint
   signals (Charts 2–3) are the strong, defensible AMM-vs-P2P distinctions.

## Per-claim confidence summary
- 46.2% AMM share since 2025-04; monthly trend to ~67%: **High** (direct label; floor).
- AMM fills are fungible CAT↔XCH only (0 NFTs, 100% XCH): **High**.
- AMM settles ~instantly (median 35s, 70.7% sub-minute) vs P2P hours: **High**.
- Amount fingerprint (round vs continuous): **High**.
- LP tokens trade P2P (4.49% of offers, 91% non-AMM-filled; LP+NFT economy): **High**.
- Hidden automation ~7.6% of unlabeled XCH↔CAT: **Low–Medium (inference)**.
