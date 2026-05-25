# O2 — Do Chia NFT creators actually get their royalties?

**Thesis.** Offer files are trustless, off-chain, peer-to-peer trade proposals.
That raises an uncomfortable question for NFT creators: with no marketplace
sitting in the middle to enforce anything, do trades route *around* the creator
royalty? On most chains "royalties" are a marketplace social convention that a
direct P2P trade can simply ignore. On Chia they are different — the royalty is
baked into the NFT's on-chain puzzle (the NFT1 standard), so the settlement
*spend* itself must satisfy it. This deep dive shows (1) royalties are
near-universally **set** (only 7.6% of NFTs are 0%, median 5%, and creators have
been *raising* them over time), and (2) a strong on-chain inference — a clean,
monotonic "extra coin" signal — that royalty-bearing NFT sales actually **create
the extra royalty output**, i.e. the creator gets paid. The interesting twist is
that on Chia, trustlessness *protects* the royalty rather than threatening it.

**Method.** All numbers come from the read-only DuckDB substrate
(`generated/offers.duckdb`), queries committed in
[`research/dexie-offers/analysis/07-royalties.sql`](../../research/dexie-offers/analysis/07-royalties.sql).
Run: `./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/07-royalties.sql"`.
NFT legs and their royalty/creator/collection metadata live in `nft_meta`
(360,302 legs, one per NFT leg; 288,945 distinct NFTs). The "paid" analysis joins
single-pair NFT→XCH sales to `coins` (exploded `involved_coins`). Royalties are in
basis points (500 = 5%). Medians used throughout, never means alone.

**Coverage caveat (applies throughout).** Dataset is **84.7% of global, biased to
dropping the OLDEST offers of the BUSIEST FUNGIBLE pairs**. This bias does **not**
materially hit this thesis: NFT legs are *not* pair-capped (each NFT is its own
`asset_id`; the busiest single NFT traded only 235 times — see `02-nft.md`), so
royalty counts, shares and medians are reliable. The one genuinely soft result is
the "paid" inference in Finding 4, which is explicitly flagged as inference.

---

## Finding 1 — Royalties are near-universal, and the median is 5%

`Q-COV`, `Q1a`, `Q1b`, `Q1c`.

**100% of NFT legs carry a `royalty_bps`** (360,302/360,302; no nulls) — royalty
is a first-class, always-present property of a Chia NFT, not optional metadata.
Only **7.6% of distinct NFTs are set to 0% royalty**; the median NFT charges
**5% (500 bps)** and the trade-weighted median is also 5%.

**Chart 1A — royalty rate, bucketed (`Q1b`):**

| Royalty bucket | Trade legs | % of legs | Distinct NFTs | Collections |
|---|---|---|---|---|
| 0% | 27,306 | 7.6% | 21,830 | 113 |
| >0–5% | 200,583 | 55.7% | 146,715 | 1,085 |
| >5–10% | 104,584 | 29.0% | 94,715 | 677 |
| >10–20% | 14,160 | 3.9% | 12,796 | 162 |
| >20–50% | 12,213 | 3.4% | 11,519 | 57 |
| >50% | 1,456 | 0.4% | 1,370 | 22 |

The mass sits at 5% (the single most common value, 30.3% of legs) and 10% (18.4%),
with 2% (10.4%), 3% (7.4%) and 0% (7.6%) filling out the head. The "set vs paid"
split (`Q1c`) is almost identical whether measured per distinct NFT (median 500,
mean 758, 7.56% zero) or per trade leg (median 500, mean 705, 7.58% zero) — i.e.
zero-royalty and high-royalty NFTs do **not** trade at meaningfully different
rates, so the trade-weighted picture mirrors the set picture.

Confidence: **High** (direct substrate facts, 100% coverage, NFT side uncapped).

---

## Finding 2 — The high-royalty (33%+) buckets are REAL, not junk

`Q1d`. A natural worry with a "anyone can set any number" field is that the
extreme buckets (33%, 50%, 99%) are typos or troll mints. They are not — they
resolve to **coherent, named collections that traded many times across many
distinct NFTs**:

**Chart 2A — what's in the extreme-royalty buckets (`Q1d`, top rows):**

| Royalty | Collection | Trade legs | Distinct NFTs |
|---|---|---|---|
| 33% | The Staker Chad | 3,604 | 3,604 |
| 50% | Chests of Xerxes | 1,961 | 1,849 |
| 33% | TangTalk Zimcards | 1,202 | 1,052 |
| 33% | Shellshares: The 1% Pearl Hunt | 673 | 650 |
| 33% | Shrimp Rush | 668 | 665 |
| 50% | NioMint VIP Membership | 500 | 358 |
| 99% | The 1 Mojo Club | 339 | 309 |
| 99% | Wizard Magic | 153 | 150 |

The 33% (3300 bps) bucket alone is 8,639 legs and is dominated by a handful of
deliberate, high-royalty collections (`The Staker Chad`, the `TangTalk` family).
The 99% bucket is a tiny novelty tier ("The 1 Mojo Club", "Wizard Magic") — a
creator essentially keeping (almost) the entire resale. These are design choices,
not data junk. So the full royalty range, including the tail, reflects real
creator intent.

Confidence: **High** that the buckets are real collections (the per-collection
distinct-NFT counts prove they aren't a single fat-fingered mint). **Medium** on
*why* a collection picks 99% (interpretation; the names are suggestive of
gamified/lottery mints, not independently confirmed).

---

## Finding 3 — Creators have been *raising* royalties over time

`Q1e`, `Q1f` → full monthly series (48 rows) in
[`data/07-royalties-monthly.csv`](data/07-royalties-monthly.csv).

If offer files were eroding royalties, you'd expect creators to give up and set
lower rates. The opposite happened — **the trade-weighted median royalty climbed
from 5% (2022–2024) to 7% (2025) to 10% (2026)**, and the mean rose even faster
(from ~5.5% to ~13%) as more collections adopted the high-royalty tail.

**Chart 3A — royalty by settlement year (trade-weighted, `Q1e`):**

| Year | Trade legs | Median royalty | Mean royalty | % zero-royalty |
|---|---|---|---|---|
| 2022 | 37,906 | 5.0% | 5.5% | 2.5% |
| 2023 | 109,450 | 5.0% | 5.1% | 15.5% |
| 2024 | 62,397 | 5.0% | 6.7% | 7.5% |
| 2025 | 133,479 | **7.0%** | 8.5% | 3.0% |
| 2026 | 17,070 | **10.0%** | 13.1% | 4.5% |

(2023's 15.5% zero-royalty share is a transient — a wave of 0% collections traded
that year — and recedes afterward; the long-run zero share is ~3–8%.) The
direction is clear: in a fully P2P, trustless market with **no marketplace
enforcing anything**, creators felt safe enough to *increase* their take, which
only makes sense if the protocol itself is honoring the royalty (Finding 4).

Confidence: **High** for the trend direction and the medians (uncapped NFT data,
large samples every year). The 2026 figure is a partial year (n=17,070) but the
median is robust.

---

## Finding 4 — Royalties appear to be PAID: a clean "extra coin" signal (INFERENCE)

This is the hard, interesting part: not whether a royalty was *set*, but whether
the settlement actually *paid* the creator. We cannot read the royalty payment
directly without decoding each offer's spend bundle. The cleanest available proxy
is the count of coins in `involved_coins` (table `coins`): a sale that pays a
royalty must create an **extra output coin** (the creator's royalty coin) beyond
the buyer↔seller pair. We compare single-pair NFT→XCH sales that carry a nonzero
royalty against those set to 0%.

**Setup / controls.** `Q2c` confirms **all 224,879 single-pair NFT→XCH sales are
P2P** (zero are `tibet2`/AMM fills) — so the comparison isn't confounded by
AMM-vs-P2P coin structure. Both groups are the same trade type (NFT offered, XCH
requested), settled the same way.

**Chart 4A — coin count by royalty presence (`Q2a`):**

| Group | Sales | Avg coins | Median coins | % with ≥3 coins | % with exactly 1 coin |
|---|---|---|---|---|---|
| **0% royalty** | 24,038 | 1.20 | 1 | **9.5%** | 90.1% |
| **Nonzero royalty** | 200,841 | 1.90 | 1 | **40.3%** | 57.7% |

Royalty-bearing sales are **4.2× more likely to show an extra (3rd+) coin** than
zero-royalty sales (40.3% vs 9.5%), and carry ~0.7 more coins on average — exactly
the footprint you'd expect if a royalty output is being created.

**Chart 4B — dose-response: extra-coin rate tracks the royalty RATE, not sale size (`Q2b`):**

| Royalty bucket | Sales | Avg coins | % with ≥3 coins | Median sale (XCH) |
|---|---|---|---|---|
| 0% | 24,038 | 1.20 | 9.5% | 0.10 |
| 1–3% | 41,101 | 1.56 | 22.5% | 0.10 |
| 4–7% | 83,638 | 1.85 | 39.9% | 0.20 |
| 8–15% | 59,328 | 2.06 | 48.2% | 0.11 |
| >15% | 16,774 | 2.42 | **58.3%** | 0.10 |

This is the strongest evidence in the thesis: the extra-coin rate rises
**monotonically with the royalty rate** (9.5% → 22.5% → 39.9% → 48.2% → 58.3%)
while the **median sale price stays flat at ~0.1–0.2 XCH across every bucket**. So
the extra coin is *not* explained by bigger trades needing more change — it tracks
the royalty *rate* specifically. The natural reading: higher royalty → a royalty
output is (more reliably) present in the settlement → the creator gets paid.

**Why this is an INFERENCE, and what it does NOT prove.** Be explicit:

- `involved_coins` is a **general, partial coin list** — it includes change and
  fee coins, and is incomplete. 90% of *zero-royalty* sales expose only 1 coin,
  even though any trade logically consumes ≥2 — so the field under-reports coins
  and is not a clean per-trade ledger. (Confirmed by spot-reading raw records:
  even plain wUSDC↔XCH trades show 3–4 coins, so a high coin count is not unique
  to royalties.)
- We have **not decoded the offer spend bundle**, so we cannot confirm that the
  extra coin's puzzle hash is the creator's, nor that its amount equals
  `sale × royalty_bps`. We are reading a *correlation* between "royalty was set"
  and "an extra output exists," plus its dose-response with the rate.
- Chia's NFT1 puzzle **enforces** the royalty at the consensus layer (the
  transfer program requires the royalty payment for the spend to be valid), so the
  prior is strong that paid≈set. Our data is consistent with that mechanism but
  does not independently re-derive it.

What we **can** say with confidence: royalty-bearing settlements carry a distinct,
rate-scaled extra-output footprint that zero-royalty settlements lack, and that
footprint cannot be explained by sale size. What we **cannot** prove from this
dataset alone: the exact mojo amount paid, or the recipient address.

Confidence: **Medium-High** that royalties are honored on-chain (consistent
monotonic signal + the NFT1 enforcement mechanism as strong prior). **This remains
an inference** — proving the paid amount requires decoding the bundle, which is
out of scope (the `offer` blob was intentionally not loaded into the substrate).

---

## Finding 5 — The creators: nearly all DIDs, and a concentrated head

`Q3a`, `Q3b`, `Q3c`.

**Chart 5A — DID vs non-DID creators (`Q3a`):**

| Creator type | Trade legs | Distinct creators | Collections | % of legs |
|---|---|---|---|---|
| DID (verified on-chain identity) | 360,141 | 872 | 1,916 | **99.96%** |
| non-DID | 161 | 19 | 1 | 0.04% |

**Essentially every traded NFT (99.96% of legs) was minted by a creator with a
DID** (Chia's decentralized identifier). This matters for the royalty story: a DID
is a persistent, on-chain creator identity, which is what makes a durable royalty
claim meaningful in the first place. Non-DID creators are a rounding error.

**Chart 5B — creator concentration (`Q3b`):**

| | Distinct creators | Trade legs | Top-10 share | Top-25 share | Top-100 share |
|---|---|---|---|---|---|
| All creators | 891 | 360,302 | **43.7%** | 62.1% | 86.2% |

The creator base is **small and concentrated**: just **891 distinct creators**
account for all NFT trading, the **top 10 creators are 43.7% of all trade legs**,
and the top 100 are 86.2%. NFT activity on Chia offer files is driven by a few
dozen prolific mint operations, with a long thin tail. The single largest creator
(`f2bf81…`, a DID) is behind 32,967 legs across 31,557 distinct NFTs at a 10%
median royalty — a one-creator-one-mega-collection profile typical of the head.
Top creators span the full royalty spectrum (medians of 0%, 2%, 5%, 7.5%, 10%,
20% among the top 12), so concentration isn't tied to a single royalty policy.

Confidence: **High** (direct counts). Note `creator_id` identifies the *minting
DID*, not necessarily distinct humans — one operator could hold several DIDs — so
891 is an upper bound on creators / the concentration is a *floor*.

---

## Caveats summary

- **Coverage 84.7%, biased to oldest busy fungible pairs** — does not materially
  affect NFT royalty counts/medians (NFT side is uncapped; max 235 trades/NFT).
- **Finding 4 is an inference.** `involved_coins` is a partial, general coin list,
  not a decoded royalty ledger; the extra-coin signal is a strong, dose-responsive
  *correlate* of royalty payment, not a proof of the paid amount or recipient.
  Decoding the `offer` spend bundle (not loaded into the substrate) would be
  required to prove the exact royalty payout.
- **`creator_id` = minting DID**, not a verified distinct human; concentration
  figures are a floor (an operator may hold multiple DIDs).
- High-royalty *labels* (e.g. "novelty/lottery mint") are interpretive; the trade
  counts and distinct-NFT counts behind them are facts.
- Medians used throughout; means reported alongside only to show the tail's pull.

## Reproduce

```sh
./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/07-royalties.sql"
```

Data series: [`research/dexie-offers/findings/data/07-royalties-monthly.csv`](data/07-royalties-monthly.csv) (48 months).
