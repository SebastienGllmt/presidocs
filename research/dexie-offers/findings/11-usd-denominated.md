# T11 (S4′) — USD-denominated trading: who prices in dollars, and is it more rational?

**Thesis.** Some traders price directly in USD stablecoins instead of XCH.
(a) How much of the market does this, and is it growing? (b) Do USD-denominated
trades behave more "rationally" than the XCH-anchored ones — which T2 showed have a
sticky XCH floor whose USD value collapsed ~5–8×?

All numbers come from `research/dexie-offers/analysis/11-usd-denominated.sql` (run read-only:
`./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/11-usd-denominated.sql`).

**Trusted "USD" = warp.green only** (`wUSDC.b`, `wUSDC`, `wUSDT`), per
`03-price-oracle.md`. **USDSC** (a fake $1 peg, reads 5–229× the real coins) and the
**TIBET-*-XCH LP "USD" tokens** are *excluded* from every "USD" measure here. The one
place USDSC appears is Finding 4 (the migration story), where it is the *zombie* being
fled, never used as a dollar value.

---

## FEASIBILITY VERDICT (read this first)

**USD-denominated pricing is a real but small and highly concentrated corner of the
offer-file market, and almost all of the volume that *looks* USD-denominated is
actually something else.** Specifically:

- **3.5%** of all 833,145 offers touch a trusted USD coin (`Q0`: 29,465 offers).
  (The recon's 6.1% counted USDSC; stripping the depegged USDSC roughly halves it.)
- Of the **28,484** *single-pair* USD offers, the split is (`Q1`):

  | Counterpart | Offers | What it really is |
  |---|---|---|
  | **XCH** | 19,910 | the XCH/USD **price oracle** (T3) — by definition the XCH-anchored side, not "an asset priced in USD" |
  | **CAT** | 6,389 | **~96% is BYC**, and BYC itself trades at **~$0.98** (`Q4`) — i.e. stable↔stable, not a volatile asset priced in dollars |
  | **NFT** | 2,185 | the only genuine "volatile asset priced in USD" slice — and it's **RWA**, see Finding 3 |

- **So the genuinely-USD-denominated-volatile-asset volume is ~2,200 NFT offers plus a
  few hundred misc CAT offers (NIOC, BEPE, ECO… all <75 each) — well under 0.4% of the
  dataset.** Everything bigger is either the oracle flow (XCH↔USD) or stable↔stable
  (BYC↔USD).

**Bottom line for each sub-question:**
- **(a) How much / growing:** Quantifiable and **growing**, but from a tiny base and in
  discrete event-driven bursts (an RWA-NFT wave in 2025-07, a BYC market that switched
  on in 2026-01), not a smooth secular rise. See Finding 2.
- **(b) More rational:** **Yes, where n supports it** — the USD-priced assets are
  exactly the ones a rational actor *would* price in dollars (tokenized real estate /
  GPU hardware), and for at least one collection traded in BOTH units the USD price is
  flat while the XCH price climbs as XCH falls (Finding 3). But "n supports it" is a
  real constraint: only ~3 collections have enough dual-denominated trades to compare,
  so this is an **illustration, not a population-level result.**

---

## Finding 1 — The shape of the USD market: oracle + one stablecoin-CAT + an RWA-NFT niche

`Q1`, `Q2`, `Q4`, `Q5`.

The "top USD counterparts" list (`Q2`) is starkly concentrated:

| Counterpart | USD offers | Note |
|---|---|---|
| XCH | 19,910 | oracle flow (T3 territory) |
| BYC | 6,128 | a ~$1 CAT → stable↔stable |
| NFT (any) | 2,185 | the RWA niche (Finding 3) |
| NIOC | 74 | |
| BEPE | 28 | meme CAT |
| ECO.* (×6) | ~80 total | |
| everything else | <20 each | |

Two structural facts reframe the thesis:

1. **The CAT↔USD slice is not "volatile CATs priced in dollars" — it's BYC, a
   dollar unit.** `Q4`: BYC↔USD median = **$0.9775**, p10–p90 = **$0.953–$1.001**
   (n=6,128). BYC is itself a ~$1 instrument (T3 used it as a USD bridge for exactly
   this reason). So a BYC↔wUSDC.b trade is two dollar-pegged things swapping — it tells
   you nothing about a trader choosing to denominate a *risky* asset in USD.

2. **NFT↔USD inverts the usual NFT trade direction.** `Q5`: of 2,185 NFT↔USD offers,
   **1,802 are "NFT bought with USD"** and only **383 "NFT sold for USD."** Contrast
   T2, where NFT↔XCH is ~99% *sell-side* listings. USD-priced NFT activity is
   predominantly **bids posted in dollars** — a different behavior (a buyer saying "I'll
   pay $X"), consistent with the RWA reading below.

**Confidence: HIGH** (all substrate facts; BYC peg is a large-n median).

---

## Finding 2 — Trend: small, event-driven, and (weakly) growing — starts only 2024-05

`Q3` → [`data/11-usd-denominated-monthly.csv`](data/11-usd-denominated-monthly.csv)
(25 months; the whole trusted-USD market postdates warp.green's 2024-05 arrival, so
there is *no* USD-denominated history before then — USDSC was the only "USD" earlier
and it is not a peg).

**Chart 2A — monthly single-pair USD-denominated offers by counterpart (selected):**

| Month | XCH↔USD | CAT↔USD | NFT↔USD | Total |
|---|---|---|---|---|
| 2024-05 | 191 | 0 | 0 | 191 |
| 2024-10 | 469 | 13 | 59 | 541 |
| 2024-11 | 1,348 | 19 | 74 | 1,441 |
| 2025-05 | 979 | 17 | 177 | 1,173 |
| 2025-06 | 1,242 | 3 | 232 | 1,477 |
| **2025-07** | 2,539 | 2 | **1,196** | 3,737 |
| 2025-10 | 740 | 3 | 157 | 900 |
| **2026-01** | 1,275 | **2,913** | 56 | 4,244 |
| 2026-02 | 456 | 1,149 | 3 | 1,608 |
| 2026-04 | 1,491 | 961 | 0 | 2,452 |
| 2026-05 | 863 | 292 | 2 | 1,157 |

Two discrete "switch-on" events dominate the growth, not a smooth ramp:
- **2025-07 NFT spike (1,196):** a single RWA-NFT collection ("2405 Pollen Way")
  cleared ~1,190 dollar-priced sales in one month (Finding 3). NFT↔USD is otherwise
  <250/month.
- **2026-01 CAT spike (2,913):** the **BYC↔USD** stable↔stable market turns on and
  sustains ~300–1,150/month thereafter. This is the "2026 BYC market" T3 also saw.

XCH↔USD (the oracle) is the steady backbone — a few hundred to ~2,500/month, broadly
flat-to-up, consistent with T3.

**Confidence: HIGH** for the counts and the event-driven shape (substrate facts).
*Caveat:* XCH↔USD early months (2024-05→2024-08) are **API-cap floors** (the hot
XCH↔wUSDC.b pair is truncated at ~9,998 oldest-first, per `README.md` / T3); the
NFT and CAT slices are *not* cap-exposed (many distinct assets).

---

## Finding 3 — Behavior: the USD-priced NFTs are RWAs, and they hold dollar value while the XCH floor drifts

This is the heart of sub-question (b). `Q6`, `Q7`, `Q7b`.

**What is priced in USD turns out to be exactly what a rational actor would
dollar-price.** The USD-priced NFT collections (`Q6`) are **tokenized real-world
assets** — street addresses (real estate) and GPU hardware:

**Chart 3A — NFT collections priced in USD, and how they also trade in XCH (`Q6`):**

| Collection | USD sales | XCH sales | Kind |
|---|---|---|---|
| 2405 Pollen Way | 1,248 | 120 | real-estate address |
| 336 Sarava Ln | 172 | 0 | real-estate address |
| 2428 Egret Dr | 155 | 35 | real-estate address |
| 621 Martha Ave | 128 | 27 | real-estate address |
| 1050 44th Ave N | 122 | 1 | real-estate address |
| 147 Coach Dr | 117 | 68 | real-estate address |
| 421 Shelby St | 82 | 54 | real-estate address |
| 1527 White Bluff Rd | 82 | 49 | real-estate address |
| Pantheon 4090 | 30 | 0 | GPU hardware |
| FarmGPU 4090 | 25 | 0 | GPU hardware |

These collections trade **predominantly in USD** (USD ≫ XCH) — the *opposite* of the
rest of the NFT market (T2: NFTs are an XCH-floor culture). That alone is the
qualitative answer to (b): the assets whose value is genuinely dollar-anchored in the
real world are the ones traders chose to denominate in dollars on-chain.

**Chart 3B — "2405 Pollen Way": USD price is flat; the XCH price climbs as XCH falls
(`Q7`).** The one collection with enough trades in *both* units to compare directly:

| Month | unit | n | median price | XCH/USD that month (T3) | implied $ |
|---|---|---|---|---|---|
| 2025-05 | XCH | 84 | **2.02 XCH** | ~$12.7 | ~$25.6 |
| 2025-05 | USD | 26 | **$25.0** | — | $25.0 |
| 2025-06 | XCH | 35 | **2.24 XCH** | ~$10.5 | ~$23.5 |
| 2025-06 | USD | 7 | **$25.0** | — | $25.0 |
| 2025-07 | USD | 1,190 | **$28.47** | — | $28.5 |
| 2025-10 | XCH | 1 | 3.0 XCH | ~$7.1 | ~$21 |

The USD-denominated sellers held a **flat ~$25–28** across the whole period. The
XCH-denominated sellers of the *same* collection raised their ask **2.02 → 2.24 → 3.0
XCH** as XCH fell from ~$12.7 to ~$7 — i.e. they were *manually tracking dollars by
re-pricing in XCH*, landing at the same ~$21–26. So even the XCH side of an RWA isn't
"sticky-XCH-floor" the way ordinary PFP NFTs are (T2 Finding 3); it's *trying* to track
dollars, which is precisely why a dollar-denominated quote is the more rational
primitive for it.

**Chart 3C — cross-check across all RWA collections (`Q7b`).** In the months with
*both* USD and XCH sales, the USD-direct median and the XCH-implied-USD median agree
closely — two independent denominations pricing the same dollar value:

| Month | n_usd | USD-direct | n_xch | XCH-implied-USD |
|---|---|---|---|---|
| 2024-07 | 9 | $475 | 50 | $498 |
| 2024-11 | 74 | $208 | 33 | $223 |
| 2025-05 | 177 | $28.5 | 85 | $25.6 |
| 2025-06 | 232 | $25.0 | 102 | $25.4 |

(The aggregate's month-to-month *level* jumps because different-priced collections
dominate different months — read the agreement *within* a row, not the trend down the
column; the per-collection view in 3B is the clean version.)

**Contrast with T2's PFP-NFT floor.** T2 showed the *typical* NFT sits at a sticky
0.1–0.2 XCH "floor" whose dollar value collapsed from ~$7–9 (2022–24) to ~$1 (2025).
The RWA NFTs here do the opposite: they pin a **dollar** value and let the XCH number
float. Same dataset, two opposite pricing cultures — and only the second is "rational"
in the dollar sense the thesis asks about.

**Confidence:**
- RWA collections are USD-priced and trade mostly in USD: **HIGH** (`Q6` facts).
- "2405 Pollen Way" USD-flat / XCH-rising: **MEDIUM-HIGH** — the pattern is clear and
  the implied-dollar cross-check agrees, but the USD and XCH activity only partly
  overlap in time and the comparison rests on one collection (+ a handful of others
  with smaller n).
- "RWA ⇒ rational dollar pricing" as a general claim: **MEDIUM** (strong signal from
  the asset *type* + the dual-denomination agreement; not proven population-wide
  because the n outside RWAs is too thin to test).

---

## Finding 4 — Bonus: a datable flight to the credible peg (USDSC → warp.green)

`Q8` → [`data/11-usd-denominated-stablecoin-migration.csv`](data/11-usd-denominated-stablecoin-migration.csv)
(53 months). Counts every stablecoin **leg appearance** (USDSC vs the warp.green set),
so it measures the whole "USD-ish" footprint, depegged USDSC included.

**Chart 4A — USDSC vs warp.green stablecoin legs/month (selected):**

| Month | USDSC | warp.green |
|---|---|---|
| 2023-01 | **3,749** | 0 |
| 2023-06 | 1,345 | 0 |
| 2024-03 | 82 | 0 |
| 2024-04 | 8 | 0 |
| **2024-05** | 62 | **261** ← warp.green appears |
| 2024-06 | 20 | 293 |
| 2024-09 | 184 | 513 |
| 2025-01 | 18 | 1,134 |
| 2025-07 | 15 | 4,047 |
| 2026-01 | 7 | 4,260 |
| 2026-05 | 2 | 1,159 |

The story is clean and **datable to 2024-05**: USDSC carried essentially *all*
"USD-labeled" offer-file activity from 2022 through early 2024 (peaking 3,749 legs in
Jan-2023), but it was a low-liquidity **zombie** whose price had already decoupled from
$1 (T3). It was *already* fading by early 2024 (down to ~8–80 legs/month). When the
credible warp.green wrapped stablecoins arrived in **May 2024**, they immediately
overtook USDSC (261 vs 62 in the very first month) and USDSC went to **~0 by 2025**.
This is a textbook flight-to-the-credible-peg, and it's why the *trustworthy*
USD-denominated market only exists from 2024-05 onward.

**Confidence: HIGH** that warp.green displaced USDSC starting 2024-05 (the leg counts
are unambiguous substrate facts). **MEDIUM** on calling it strictly *causal* "flight"
vs. coincident decline — USDSC was already shrinking pre-warp, so warp arrival
accelerated/finished a decline rather than single-handedly starting it.

---

## Caveats (per dataset rules)

1. **"USD" = warp.green only.** USDSC and TIBET-* LP tokens are excluded from every USD
   value/price measure (USDSC appears only as the *zombie* in Finding 4). Using USDSC as
   $1 would corrupt all of this.
2. **The market is thin** — that *is* a primary finding, not a footnote. Outside
   XCH↔USD (oracle) and BYC↔USD (stable↔stable), genuine USD-denominated-volatile-asset
   volume is ~2,200 NFT + a few hundred misc CAT offers. Behavior conclusions (Finding
   3) rest on ~3 collections; treat as illustration, not population statistics.
3. **No USD history before 2024-05.** The trustworthy USD market starts with warp.green;
   do not chart a continuous USD-denominated series back to 2022.
4. **API-cap floor** bites XCH↔USD early months (truncated oldest-first at ~9,998); the
   NFT/CAT slices are not cap-exposed (many distinct assets).
5. **Medians throughout**, prices include junk; BYC peg and the FX bridge are reused
   from T3's validated method. The XCH-implied-USD column in 3C uses T3's monthly
   XCH/USD oracle as the FX denominator (so it inherits T3's MEDIUM confidence on thin
   months).
6. **RWA labels** ("real estate", "GPU") are read from `collection_name`
   (`nft_meta`); the trade structure and counts behind them are facts, the real-world
   interpretation is descriptive.

## Confidence summary

| Claim | Confidence |
|---|---|
| USD touches 3.5% of offers; single-pair split 19,910 XCH / 6,389 CAT / 2,185 NFT | **HIGH** |
| CAT↔USD is ~96% BYC, and BYC ≈ $0.98 (stable↔stable, not USD-priced volatile asset) | **HIGH** |
| Genuine USD-denominated-volatile-asset volume is <0.4% of the dataset | **HIGH** |
| Growth is event-driven (2025-07 RWA-NFT, 2026-01 BYC), not a smooth ramp; starts 2024-05 | **HIGH** |
| USD-priced NFTs are RWAs (real estate / GPU) and trade mostly in USD | **HIGH** |
| For dual-denominated RWAs, USD price is flat while XCH ask rises as XCH falls | **MEDIUM-HIGH** |
| "USD-denominated ⇒ more rational" as a general population claim | **MEDIUM** (n-limited) |
| warp.green displaced the USDSC zombie starting 2024-05 | **HIGH** (causal framing: MEDIUM) |

## Artifacts

- Query: `research/dexie-offers/analysis/11-usd-denominated.sql` (Q0–Q8 + CSV export)
- `research/dexie-offers/findings/data/11-usd-denominated-stablecoin-migration.csv` (53 months)
- Monthly trend (25 months) is inline in Finding 2 (under the 30-row CSV threshold);
  regenerate via `Q3`.
