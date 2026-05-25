# T3 — Completed offers as an XCH/USD price oracle

**Thesis.** Settled offer-file trades form a *usable* price oracle. From single-pair
XCH↔stablecoin offers I can reconstruct an XCH/USD series that (a) tracks XCH's
real-world decline, (b) is tight and two-sided, and (c) is hard to manipulate via
posted offers — *provided* you pick the right stablecoin. The dataset contains a
booby-trap "USD" code (USDSC) that is not a peg at all; using it naively produces a
$30–$1,000/XCH series that looks like data but is junk.

All numbers below come from `research/dexie-offers/analysis/03-price-oracle.sql`
(run `./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/03-price-oracle.sql`).
Series CSVs in `research/dexie-offers/findings/data/03-price-oracle-*.csv`.

## Method (the load-bearing normalization)

- **Universe:** single-pair (1×1) offers where one leg is XCH and the other is a
  trusted USD stablecoin. `price = requested.amount / offered.amount` — verified
  identical to the stored `offers.price` on **98.9%** (460,295 / 465,422) of
  single-pair offers; the rest is decimal rounding.
- **Direction normalize to USD-per-XCH** (half the offers are the reverse pair):
  - XCH *offered* (selling XCH): `USD/XCH = requested(USD)/offered(XCH)` → use as-is.
  - XCH *requested* (buying XCH): `USD/XCH = offered(USD)/requested(XCH)` → invert.
  I rebuild from the two legs directly so direction is explicit (and queryable as a
  bid/ask split).
- **Robust aggregation:** per period (day/week/month) take the **median**, then
  trim outliers with an **adaptive band** (keep prices within 0.2×–5× of that
  period's raw median). Median + trim, never mean.
- **Coverage caveat (from `README.md`):** the API per-pair 10k cap truncates
  the *oldest* offers of the busiest pairs. XCH↔wUSDC.b sells and XCH↔USDSC sells
  both sit at exactly 9,998 — i.e. capped. So **early-period counts are floors**;
  the *price level* is unaffected (median of what we do have), only sample depth.

## Finding 1 — STABLECOIN VALIDATION: trust the warp.green coins, reject USDSC

This is the most important result and it changes the recon's framing. The recon's
"early-2024 spike to $80–90" is **not** an early-data artifact — it is **USDSC
being a fake oracle the entire time.**

There are 8 "USD" codes (`Q0`). Verdict:

| Code | asset_id (short) | offers | Verdict |
|---|---|---|---|
| **wUSDC.b** | fa4a18… | 27,649 | ✅ **TRUST** — warp.green wrapped USDC (Base), the dominant peg |
| **wUSDC** | bbb51b… | 1,720 | ✅ **TRUST** — warp.green wrapped USDC (Ethereum) |
| **wUSDT** | 634f9f… | 291 | ✅ **TRUST** — warp.green wrapped USDT (thin but on-peg) |
| **USDSC** | 6d95da… | 20,923 | ❌ **REJECT** — *not a USD peg*; see below |
| TIBET-*USD*-XCH (×3) | be6b28…/77b517…/4ea903… | 248/693/95 | ❌ REJECT — these are TibetSwap **LP tokens**, not $1 |

**Why USDSC is junk (the diagnosis).** In months where they overlap, the three
warp coins agree with each other to within a few percent, while USDSC reads
**5×–200× higher** and uncorrelated:

| Month | wUSDC.b | wUSDC | wUSDT | USDSC | USDSC/wUSDC.b ratio |
|---|---|---|---|---|---|
| 2024-08 | 15.27 | 15.36 | 16.08 | **1000.0** | 65× |
| 2024-09 | 13.51 | 13.60 | 13.74 | **984.3** | 73× |
| 2025-06 | 10.48 | 11.16 | — | **688.2** | 66× |
| 2026-04 | 2.35 | 2.29 | — | **538.4** | 229× |

- The ratio is **not a clean constant** (so it is *not* a simple decimals bug you
  could correct by ×100) — it ranges 5× to >10⁹× and *grows* as real XCH falls,
  because USDSC's median price is **sticky around ~$500/XCH** regardless of XCH's
  actual value.
- Pre-2024, USDSC is a coherent but **stale** market: tight IQR ($33.6–$43.7) and
  median drifting $82→$30 across 2022, which *coincidentally* resembles XCH's real
  2022 price — but it then fails to follow XCH down at all. Recent USDSC (2024+,
  n=499) has median $172 with IQR $87.9–$425.1: wide, unanchored.
- Interpretation (corrected post-analysis): USDSC is the **old version of Stably
  USD**, a *genuine* USD stablecoin whose off-chain custodian (**Prime Trust**)
  became **insolvent in 2023** — after which the 1:1 peg was no longer guaranteed.
  So it was a working peg during its heavy-use years (2022–23, ~$37 implied) and a
  **depegged, near-worthless, low-liquidity token afterward** (2024+: $160→$695
  implied, n collapsing 804→13/yr). The earlier guess "delisted / wrong-decimal"
  was wrong; the real cause is a custodian failure. It produces numbers, not prices,
  *after the depeg* — so exclude it from the oracle. Lesson: an on-chain stablecoin
  is only as solid as its off-chain backing.

**Confidence: HIGH.** The cross-coin agreement vs. USDSC divergence is unambiguous
and reproducible (`Q2`, CSV `03-price-oracle-stablecoin-validation.csv`).

> ⚠️ **Synthesis note:** the recon line "early months 2023–24 are low-sample/noisy"
> is true but secondary. The real story is that **the historical USDSC-only series
> (all of 2022→mid-2024) cannot be used for XCH/USD.** The trustworthy oracle only
> begins **2024-05-22** when warp.green coins appear. Do not chart a continuous
> 2022→2026 XCH/USD line from this data.

## Finding 2 — The reconstructed XCH/USD series (2024-05 → 2026-05)

From the trusted coins only (n=19,910 offers over 715 active days). Monthly view
(full daily/weekly series in CSVs):

| Month | n | USD/XCH (median) | | Month | n | USD/XCH |
|---|---|---|---|---|---|---|
| 2024-05 | 191 | 31.5 | | 2025-06 | 1,242 | 10.48 |
| 2024-07 | 62 | 19.7 | | 2025-08 | 1,173 | 9.74 |
| 2024-09 | 452 | 13.5 | | 2025-10 | 740 | 7.10 |
| 2024-12 | 721 | 26.8 | | 2025-12 | 277 | 5.35 |
| 2025-02 | 911 | 13.2 | | 2026-02 | 456 | 3.04 |
| 2025-04 | 640 | 11.1 | | 2026-04 | 1,481 | 2.36 |
| | | | | 2026-05 | 862 | 2.79 |

Shape: ~$31 (May 2024) → a Dec-2024/Jan-2025 bounce to ~$27/$23 → steady decline
to **~$2.4–2.8 (May 2026)**. This qualitatively matches XCH's known real-world
trajectory over the period (a multi-year bleak punctuated by a late-2024 rally).
**No external feed was queried** — this is purely the order flow.

**Chart 1 — Weekly XCH/USD (data: `03-price-oracle-weekly.csv`, 105 weeks).**
105 weekly points, median + IQR + ask/bid. Sparkline of the monthly medians:
`31 → 20 → 13 → 27 → 13 → 11 → 10 → 7 → 5 → 3 → 2.4`.

**Confidence: HIGH** for shape and recent levels; **MEDIUM** for mid-2024 absolute
levels (thin months like 2024-07 have n=62 and the early tail is API-capped).

## Finding 3 — Oracle QUALITY: it is genuinely good

### 3a. Bid/ask spread is tight and two-sided

Splitting each period into XCH-sellers' ask vs XCH-buyers' bid (`Q6`):

- **Median absolute monthly spread = 1.83%**, mean 2.54%, across 25 months.
- The sign flips month to month (sometimes bid > ask) — i.e. there is **no
  persistent maker skew**; it behaves like a real two-sided market, not a
  one-directional dump.
- Worst month is 2026-05 (+17%), and that is a *sampling* artifact of a fast-moving
  partial month (the daily series shows the price moving $2.1→$3.4 within May).

| Month | ask (sell) | bid (buy) | spread% | n_sell / n_buy |
|---|---|---|---|---|
| 2025-05 | 12.70 | 12.70 | +0.02 | 528 / 451 |
| 2025-06 | 10.49 | 10.50 | −0.03 | 744 / 498 |
| 2025-07 | 10.46 | 10.38 | +0.84 | 1,327 / 1,212 |
| 2026-03 | 2.82 | 2.83 | −0.40 | 330 / 352 |

### 3b. Dispersion / noise is low

Whole-period trusted distribution (`Q3`): p05=2.34, p50=10.43, p95=25.75,
p99=32.22, max≈$9.8×10⁸. The fat max confirms junk exists, but it is rare:

### 3c. Spam rate is tiny

Adaptive daily band (`Q4`): of 19,910 trusted offers, **only 19 (0.10%)** sit
outside 0.2×–5× of the day's median, and **only 0.23%** sit outside even a tight
0.5×–2× band. The warp-coin XCH market is **remarkably clean** — most posted offers
are honestly priced.

### 3d. How many trades/day for a stable median?

Daily relative IQR (IQR/median) bucketed by daily sample size (`Q7`):

| trades/day | n_days | median rel-IQR |
|---|---|---|
| 1–2 | 44 | 0.001 |
| 3–5 | 78 | 0.014 |
| 6–10 | 105 | 0.020 |
| 11–20 | 181 | 0.023 |
| 21–50 | 198 | 0.027 |
| 51+ | 109 | 0.028 |

Every bucket is within **±3%**. Counter-intuitively the dispersion is *flat-to-
rising* with volume — not because more trades add noise, but because the high-volume
days are recent (2025–26) when intraday XCH moves were larger. **Takeaway:** even
**~5 trades/day** pins the median to within ~1–2%; the oracle is stable at
surprisingly low volume. Coverage: **617 of 732 calendar days (84%) had ≥5 trades**;
715 days had any data.

**Chart 2 — daily sample size vs rel-IQR** (data inline above; underlying per-day
n & IQR in `03-price-oracle-daily.csv`).

### 3e. Manipulation surface

- The median + ≥5-trade requirement means an attacker must place the **majority**
  of a day's *settled* (on-chain, fee-paying) offers to move the median — posting
  cheap off-chain offers does nothing because only fills enter this dataset.
- The 0.1% spam rate shows wild offers already exist and are simply outvoted by the
  median. The triangulation below is a second independent check.
- **Weakness:** thin days (the 44 days with 1–2 trades) and thin coins (wUSDT, 291
  offers total) are individually manipulable; an oracle should require a minimum
  daily count and aggregate the warp coins together (as this series does).

**Confidence: HIGH** (spread, spam, dispersion all from large-n reproducible queries).

## Finding 4 — Triangulation cross-check (independent confirmation)

Implied XCH/USD via a CAT bridge: **XCH↔BYC** × **BYC↔USD** (`Q9`). BYC is the only
CAT with a deep two-sided USD market (6,128 BYC↔USD offers; the next is NIOC at 74).
BYC available 2026 only. Compared to the **direct** warp series:

| Month | implied (XCH→BYC→USD) | direct (XCH→USD) | diff |
|---|---|---|---|
| 2026-01 | 4.84 | 4.88 | −0.9% |
| 2026-02 | 3.37 | 3.04 | +10.8% |
| 2026-03 | 2.85 | 2.83 | +0.8% |
| 2026-04 | 2.42 | 2.36 | +2.5% |
| 2026-05 | 2.34 | 2.79 | −16% (partial month) |

Two fully independent order-flow paths agree to within a few percent in stable
months. (Aside: BYC itself trades at usd_per_byc ≈ 0.97–1.00, i.e. BYC is *also*
effectively a ~$1 unit, which is why it bridges so cleanly.) **Confidence: MEDIUM**
(single bridge, recent-only; 2026-02 and partial-2026-05 gaps are real but small).

## Caveats (per the dataset rules)

1. **Stablecoin selection is mandatory, not optional.** Including USDSC or the
   TIBET LP "USD" tokens destroys the series. Trust = warp.green only.
2. **Series starts 2024-05-22**, not 2022. There is no trustworthy XCH/USD oracle
   from this data before warp.green coins existed.
3. **Early months are API-capped & thin** (sells of hot pairs truncated at 9,998);
   2024-05→2024-08 absolute counts are floors. Price *levels* still hold (median).
4. **No external validation** was performed beyond internal cross-checks; the
   "matches XCH's real decline" claim is qualitative by instruction.
5. wUSDT is thin (291 offers) — kept for cross-checking, contributes little weight.

## Confidence summary

| Claim | Confidence |
|---|---|
| USDSC is not a USD peg; warp coins are (and agree) | **HIGH** |
| Reconstructed XCH/USD shape ($31→$2.5) & recent levels | **HIGH** |
| Median abs bid/ask spread ≈ 1.8%; two-sided | **HIGH** |
| Spam ≈ 0.1–0.23%; median stable at ≥5 trades/day | **HIGH** |
| Mid-2024 absolute price levels (thin, capped) | **MEDIUM** |
| BYC triangulation agreement | **MEDIUM** |

## Artifacts

- Query: `research/dexie-offers/analysis/03-price-oracle.sql` (Q0–Q9 + 3 CSV exports)
- `research/dexie-offers/findings/data/03-price-oracle-daily.csv` (715 days)
- `research/dexie-offers/findings/data/03-price-oracle-weekly.csv` (105 weeks)
- `research/dexie-offers/findings/data/03-price-oracle-stablecoin-validation.csv` (53 months)
