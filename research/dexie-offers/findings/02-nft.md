# T2 — NFTs are a first-class use case for Chia offer files

**Thesis.** NFTs are not a sideshow on Chia offer files — they are arguably *the*
defining use case. Over the full dataset **38.1%** of all settled offers involve
an NFT, **NFT → XCH is the single largest trade route (224,879 offers)**, and the
two biggest demand spikes in the entire offer-file history (mid-2022 and the
go4.me wave of 2025) are NFT events. This deep dive traces the full lifecycle:
how NFT trading rose and fell over time, what an NFT actually sells for (and what
that reveals about a sticky XCH "floor" vs. collapsing USD value), how NFT trades
are structured (sold-for-XCH vs. bartered vs. bought with game tokens), and which
collections drive the activity.

**Method.** All offer/leg numbers come from the read-only DuckDB substrate
(`generated/offers.duckdb`), queries in `research/dexie-offers/analysis/02-nft.sql`. Collection
metadata (dropped from the substrate) was recovered in one pass over
`generated/dexie-offers-dedup.jsonl` — `research/dexie-offers/analysis/02-nft-collections.sql`.
NFT legs are identified by `legs.is_nft`. Prices use `price =
requested.amount/offered.amount`; for single-pair NFT→XCH the NFT amount is 1, so
`price` *is* the XCH paid. Medians, junk trimmed to 0.005–1000 XCH.

**Coverage caveat (applies throughout).** Dataset is 84.7% of global, biased to
dropping the *oldest* offers of the *busiest fungible pairs*. **NFT counts and
prices are reliable**: NFT→XCH is *not* pair-capped — each NFT is its own
`asset_id` and the busiest single NFT traded only 235 times (288,945 distinct NFT
assets total). The one place the cap bites this thesis is the derived **XCH/USD FX
series** (built from capped stablecoin pairs) — fine for a median, but its early
months are low-sample/noisy.

---

## Finding 1 — NFTs are 38% of all offers; the #1 route is NFT → XCH

`Q0`, `Q2a`, `Q2b` (`02-nft.sql`):

| Metric | Value | Confidence |
|---|---|---|
| All completed offers | 833,145 | High (fact) |
| Offers involving an NFT | **317,210 (38.07%)** | High (fact) |
| Distinct NFT assets traded | 288,945 | High (fact) |
| Max trades on any single NFT | 235 (so NOT cap-truncated) | High (fact) |
| NFT ↔ fungible | 290,050 offers | High (fact) |
| NFT ↔ NFT barter | 27,160 offers | High (fact) |
| **NFT → XCH (single-pair, NFT sold for XCH)** | **224,879** | High (fact) |

NFT → XCH (224,879) is the single largest pair route in the entire dataset —
larger than any fungible↔fungible pair (which top out at the ~10k API cap). The
direction is overwhelmingly **NFT-sold-for-fungible**, not bought: in single-pair
NFT/XCH offers, 224,879 offer the NFT for XCH vs only 2,346 the reverse. So the
offer file is being used as a **sell-side listing primitive** ("here is my NFT,
pay me X XCH"), which is exactly what you'd expect of a marketplace listing.

Confidence: **High** for all counts (substrate facts, NFT side uncapped).

---

## Finding 2 — The 2022 NFT boom, the long middle, and the 2025 go4.me wave

`Q1` (`02-nft.sql`) → full series in
[`data/02-nft-monthly-share.csv`](data/02-nft-monthly-share.csv) (53 months).

**Chart 2A — NFT share of all offers, by month (selected):**

| Month | Total offers | NFT offers | NFT % |
|---|---|---|---|
| 2022-05 | 1,129 | 0 | 0.0% |
| 2022-06 | 1,544 | 227 | 14.7% |
| **2022-07** | 9,479 | 7,817 | **82.5%** |
| 2022-08 | 8,070 | 6,219 | 77.1% |
| 2022-09 | 9,512 | 7,202 | 75.7% |
| 2022-10 | 15,173 | 5,112 | 33.7% |
| 2023-06 | 24,702 | 15,638 | 63.3% |
| 2024-11 | 14,672 | 2,881 | 19.6% |
| **2025-08** | 38,945 | 23,397 | **60.1%** |
| 2025-09 | 34,356 | 20,034 | 58.3% |
| 2025-11 | 26,256 | 14,847 | 56.5% |
| 2026-03 | 26,435 | 3,152 | 11.9% |
| 2026-04 | 24,257 | 1,466 | 6.0% |
| 2026-05 | 22,687 | 3,165 | 14.0% |

The shape: NFTs appear essentially from zero, **explode to 82.5% of all offer
activity in July 2022** (the Chia NFT mania, right when offer files themselves
were new — for ~3 months NFTs *were* the offer-file ecosystem), settle into a
volatile **30–60% band through 2023–2025**, then a fresh **mid-2025 surge** (the
go4.me wave, see Finding 5) re-lifts the share to ~60%, before falling to a
**6–17% trough in early 2026** as fungible/AMM volume grows and NFT speculation
cools.

⚠️ The mid-2022 absolute counts are a *floor* (the cap+bias drops oldest busy
pairs), but the *share* is dominated by NFTs there regardless, so the boom is real.

Confidence: **High** for shape/share; **Medium** for early absolute counts (floor).

---

## Finding 3 — A sticky XCH "floor" that hides a collapsing USD value

`Q3` / `Q5b` (`02-nft.sql`) →
[`data/02-nft-price-monthly.csv`](data/02-nft-price-monthly.csv) (48 months).
`med_xch` = median XCH paid per NFT (single-pair NFT→XCH). `usd_per_xch` is
derived from single-pair XCH↔stablecoin medians (wUSDC.b/USDSC/wUSDC/wUSDT);
`med_usd = med_xch × usd_per_xch`.

**Chart 3A — Median NFT sale price, XCH vs USD (selected):**

| Month | n sales | Median XCH | XCH/USD | Median USD |
|---|---|---|---|---|
| 2022-07 | 6,792 | 0.20 | 43.65 | $8.73 |
| 2022-12 | 4,120 | 0.10 | 30.95 | $3.10 |
| 2023-06 | 3,581 | 0.21 | 33.60 | $6.98 |
| 2024-01 | 4,149 | 0.10 | 78.00 | $7.80 |
| 2025-03 | 11,157 | 0.20 | 13.27 | $2.65 |
| 2025-08 | 18,760 | 0.10 | 9.73 | $0.97 |
| 2025-11 | 10,791 | 0.20 | 6.91 | $1.38 |
| 2026-02 | 2,958 | 0.21 | 3.04 | $0.64 |
| 2026-04 | 1,276 | 1.00 | 2.35 | $2.35 |
| 2026-05 | 2,765 | 0.50 | 2.53 | $1.27 |

**The story.** The median NFT trades for a remarkably **sticky 0.1–0.2 XCH across
the entire 4-year history** — traders anchor to round XCH amounts (0.1, 0.2, 0.5,
1.0 XCH dominate as psychological "floor" prices), *not* to dollar value. Because
the floor is XCH-denominated, the **USD value of an NFT tracked XCH's price
collapse straight down**: from ~$7–9 in 2022–24 to **~$1–2.50 in 2025–26** — at
one point (2025-08, the go4.me peak) the typical NFT cleared for **under $1**.
The late-2026 uptick in *median XCH* (0.5–1.0 XCH in 2026-04/05) is partly a
low-sample, traders-raising-XCH-asks-as-XCH-cheapens effect, not a real recovery
in dollar terms. There is a clear "floor price" culture, but it is a *floor in
XCH*, and that floor quietly devalued ~5–8× in dollars.

Confidence: **High** that the XCH floor is sticky and USD value tracked XCH down
(both legs from solid samples). **Medium** on exact monthly USD figures — the FX
denominator comes from cap-truncated stablecoin pairs and early-period
low-sample/unit caveats noted in recon.

---

## Finding 4 — Trade structure: mostly sold for XCH, a barter layer, and a game economy

`Q2b`, `Q2c`, `Q4` (`02-nft.sql`).

**Chart 4A — what NFTs are traded against (single-pair, top counterparts):**

| Counterpart | Offers | NFT sold for it | NFT bought with it |
|---|---|---|---|
| XCH | 227,225 | 224,879 | 2,346 |
| TIBET-G4M-XCH | 10,943 | 10,943 | 0 |
| G4M | 10,437 | 10,437 | 0 |
| FBX | 4,340 | 4,277 | 63 |
| MZ | 2,462 | 2,450 | 12 |
| wUSDC.b | 2,185 | 383 | 1,802 |
| HOA | 1,606 | 1,603 | 3 |
| SHD | 1,042 | 1,042 | 0 |

Three structural layers:

1. **Sold for XCH (dominant, ~225k).** The plain marketplace listing. ~99% of
   NFT/XCH offers are NFT-for-XCH (sell-side).
2. **Bartered NFT ↔ NFT (27,160 total; 8,499 single 1:1 swaps, 18,661 multi-leg
   bundles).** A real, if minority, peer-to-peer swap layer — and the multi-leg
   majority means people **bundle multiple NFTs into one atomic trade**, a thing
   offer files are uniquely good at (no escrow, all-or-nothing).
3. **A game/meme-token economy buys NFTs.** The **G4M cluster — `G4M`
   (10,437) + `TIBET-G4M-XCH` LP (10,943) = 21,380 offers** — is NFTs sold for a
   *game token*, the second-largest NFT counterpart after XCH itself. Note these
   are all "sold for G4M" (0 reverse), i.e. NFTs are priced *in* the game's
   currency. Smaller game/meme tokens follow (FBX, MZ, HOA, SHD, PEPE, BEPE, plus
   an "X-animal" CAT family XPIG/XCOW/XCHIN/XSHEP each ~536). Note `wUSDC.b` is the
   one counterpart that flips — there NFTs are mostly *bought with* USD stablecoin
   (1,802 of 2,185), i.e. a few higher-value collections priced in dollars.

Confidence: **High** (substrate facts). Inference that multi-leg barter = bundling
and that G4M is a game economy: **Medium-High** (token names + structure are
strong signals; not independently confirmed against the games).

---

## Finding 5 — Collections: a concentrated head of ~10k-item mints, with go4.me as the 2025 phenomenon

JSONL pass `02-nft-collections.sql`. Collection metadata present on **99.8%** of
NFT legs (1,917 distinct collections). Top collections by trade count (`Q-C2`):

**Chart 5A — top collections by trade count:**

| Collection | Trades | Distinct NFTs | Note |
|---|---|---|---|
| **go4.me PFPs** | **29,772** | 28,398 | 2025 wave (Finding 5B) |
| Kiwi, Requiescat in Pace \| 1967-2023 | 10,429 | — | single-event mint, Jun-2023 |
| CHIA MONSTER TOWER WARRIOR | 10,419 | — | game NFT |
| Farmers of FarmerVerse | 10,414 | — | game NFT |
| DataLayer Minions | 10,156 | — | |
| ChiaPhunks | 10,136 | 8,876 | 10k PFP set |
| Chunks - Chia Punks | 10,102 | 7,650 | 10k PFP set |
| Punk Friends | 10,009 | 9,789 | 10k PFP set |

The tight cluster at **~10,000–10,430 trades** is **not** the API cap (no single
NFT asset is cap-truncated). It reflects the standard **10k-item generative PFP
collection**: e.g. Punk Friends = 9,789 distinct NFTs each traded ~once (ratio
1.02), ChiaPhunks 8,876 NFTs (1.14). Each item mostly sells once — a strong
**primary/first-sale signal** rather than active resale churn.

**Chart 5B — top collections by XCH volume (single-pair NFT→XCH sales, `Q-C3`):**

| Collection | Sales | XCH volume | Median XCH |
|---|---|---|---|
| **Chia Friends** | 5,344 | **59,100** | 7.5 |
| NeckLords | 1,012 | 5,266 | 5.0 |
| Kiwi, RIP | 2,326 | 3,765 | 0.075 |
| ChiaPhunks | 9,983 | 3,455 | 0.1 |
| TangBears on Chia | 1,659 | 3,180 | 1.1 |
| Chunks - Chia Punks | 9,949 | 3,104 | 0.1 |
| Xivion LEGENDARY | 981 | 2,943 | 3.0 |

**Volume rank ≠ count rank.** The trade-count leaders (the 10k-item PFP sets) are
*cheap* (median 0.1 XCH), so they rank low by value. By XCH volume the leader is
**Chia Friends (59,100 XCH from 5,344 sales, median 7.5 XCH each)** — the blue-chip
collection — followed by NeckLords, TangBears, Xivion (all "few-but-pricey").
go4.me, despite 29,772 trades, ranks ~14th by volume (median 0.07 XCH) — a
high-velocity, near-zero-price phenomenon.

**Chart 5C — concentration of NFT→XCH sales (`Q-C4`, 1,746 collections):**

| Bucket | % of sales | % of XCH volume |
|---|---|---|
| Top 10 collections | 34.8% | 54.4% |
| Top 25 | 47.0% | 65.0% |
| Top 100 | 71.0% | 82.6% |

NFT activity is **moderately concentrated with a long tail**: the top 10
collections are over half the XCH value and a third of all sales, top 100 are
~83% of value — but it takes 1,746 collections to span the market. Value is more
concentrated than count (the head is the expensive blue-chips).

**Chart 5D — collection lifecycles** (top-8 monthly series in
[`data/02-nft-collection-lifecycle.csv`](data/02-nft-collection-lifecycle.csv),
peaks summarized):

| Collection | Active | Peak month | Peak trades | Pattern |
|---|---|---|---|---|
| go4.me PFPs | 2025-07 → 2025-12 | 2025-09 | 14,082 | sharp single-wave |
| Kiwi, RIP | 2023-05 → 2026-04 | 2023-06 | 7,279 | event mint + tail |
| Punk Friends | 2025-02 → 2026-05 | 2025-11 | 6,479 | 2025 mint burst |
| DataLayer Minions | 2024-01 → 2026-05 | 2025-08 | 6,243 | sustained |
| ChiaPhunks | 2023-07 → 2026-05 | 2024-05 | 4,570 | long-lived |
| Chunks | 2022-12 → 2026-05 | 2023-09 | 1,906 | long-lived, low rate |

The dominant lifecycle is **mint-spike-then-decay**: a collection drops, trades
burst within 1–3 months (the primary sale), then a thin resale tail. **go4.me is
the cleanest example and the single biggest NFT event of 2025** — 29,772 trades
compressed entirely into Jul–Dec 2025, peaking at **14,082 trades in Sep 2025
alone** — which is the engine behind the 2025 share resurgence in Finding 2.

Confidence: **High** for counts/volume/concentration (direct from data, 99.8%
metadata coverage). **Medium-High** on "primary first-sale" interpretation
(trades-per-NFT ratios ~1.0–1.3 support it strongly but don't prove mint vs.
secondary). Names like "Chia Friends = blue chip" are descriptive, not valued
independently.

---

## Caveats summary

- **Coverage 84.7%, biased to oldest busy pairs.** NFT→XCH counts/prices are
  *reliable* (uncapped, 288,945 distinct assets, max 235 trades/NFT). The **XCH/USD
  FX series is the one cap-exposed input** (stablecoin pairs are truncated) — used
  only for medians, and early months are low-sample.
- **Price junk trimmed** to 0.005–1000 XCH; medians throughout. Multi-leg offers
  excluded from the per-NFT price series (price ambiguous).
- **"Sold vs bought" direction** is from leg side; barter and multi-asset bundles
  are reported separately and not double-counted into the price series.
- **Collection = `collection.name` from JSONL** (grouped on stable `collection.id`).
  0.2% of NFT legs lack collection metadata (bucketed as "(no collection)").
- Game-economy / blue-chip *labels* are interpretive; the trade structure and
  counts behind them are facts.

## Reproduce

```sh
# offer/leg facts, time series, prices (read-only; safe alongside other agents)
./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/02-nft.sql"
# collection pass over the JSONL (~10s; writes nft_legs.parquet + lifecycle CSV)
./tools/duckdb -c ".read research/dexie-offers/analysis/02-nft-collections.sql"
```

Data series: `research/dexie-offers/findings/data/02-nft-monthly-share.csv` (53 mo),
`02-nft-price-monthly.csv` (48 mo), `02-nft-collection-lifecycle.csv` (top-8).
