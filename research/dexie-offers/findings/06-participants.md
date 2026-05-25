# 06 — Participants & concentration: how many actors are behind 833k offers?

**Thesis (O1).** Behind 833,145 settled offers there is a *much* smaller and more
concentrated set of actors than the offer count suggests. We can prove the
concentration; we **cannot count individual makers from this dataset** — but that's
a **data-collection gap, NOT anonymity**. Chia is a public chain and the addresses
exist on-chain; we just didn't index them.

All numbers come from `research/dexie-offers/analysis/06-participants.sql` and
`research/dexie-offers/analysis/06-participants.ts` (union-find), run read-only against
`generated/offers.duckdb` (snapshot 2026-05-23). Re-confirmed against
`generated/dexie-offers-dedup.jsonl`.

---

## The limit: we didn't index the addresses (they're on-chain, not absent)

State this precisely — it is a gap in *our* data, not a property of the chain:

- **The dexie offer records we indexed carry no maker address.** A record exposes
  the `involved_coins` (coin ids) but not the puzzle hashes (addresses) of the
  parties; the `offer` blob reserves coins and *announces* required payments
  without naming the maker.
- The only originator-like field, `mempool.originator.puzzle_hash`, is present on
  just **0.66%** of offers and takes only **3 distinct values** (re-verified on a
  200k sample) — dexie infrastructure hashes, not a user population.
- `known_taker` is *only* the TibetSwap AMM, and only since 2025-04.

**But the identities are recoverable.** Chia is public: every offer settles
on-chain, so each `involved_coins` entry resolves to a puzzle hash via a full node
/ chain indexer (or a service like SpaceScan/MintGarden). A future on-chain pass
could attach maker/taker addresses and answer "how many distinct traders" directly.
We did not do that here — so within *this* dataset any user count is a proxy
estimate, not a headcount. The honest framing is "not yet indexed," not "unknowable."

Confidence: **High** (measured gap; recoverability is a property of a public chain).

---

## The coin graph: a defensible *lower bound on linkage*, and why it stays tiny

**Construction.** Nodes = offers; an edge links two offers that share a `coin_id`
(table `coins`, 2,220,331 rows exploded from `involved_coins`). Coins are
single-use — spent the moment they back a trade — so the *only* legitimate way two
**settled** offers share a coin is a **change-chain**: offer A settles and emits a
change coin; the same wallet funds offer B with that change coin → shared id. A
connected component over this graph ≈ one wallet's sequential offer stream.

**The artifact we must exclude.** Of 1,967,834 distinct coins, **1,940,478 (98.6%)
are single-use** (appear in exactly one offer) — exactly as the UTXO model
predicts. Only **27,356 coins** are shared at all. But a handful are shared by
*hundreds to thousands* of offers (max **10,168**). A genuine change coin is spent
exactly once and can link at most **2** offers; a coin linking thousands is a
structural artifact (recurring settlement/contract/pool coin), and including it as
an edge collapses the whole graph into one false "wallet." So we cap edge
multiplicity at `MAX_MULT` and report sensitivity.

Coin-multiplicity distribution (Q1):

| coins shared by… | n_coins | offer-links | reading |
|---|---|---|---|
| 1 (single-use) | 1,940,478 | 1,940,478 | the norm — UTXO single-use |
| **2 (change-chain)** | 10,645 | 21,290 | the clean signal |
| 3–5 | 9,309 | 34,527 | plausible chains / small merges |
| 6–10 | 3,636 | 27,003 | |
| 11–20 | 1,811 | 25,443 | |
| 21–50 | 1,452 | 41,458 | |
| 51–200 | 423 | 36,293 | artifacts |
| **200+ (hub)** | **80** | **93,839** | artifacts (max k = 10,168) — excluded |

The 2-offer coins behave like change-chains: median gap between the two
settlements is **~298 min (≈5h)** — A settles, change later funds B (Q1b). ✔

### Result: the graph barely links anything

At the strict change-chain cap (`MAX_MULT=2`):

- **Only 19,838 offers (2.38%) link to *any* other offer.** The other 813,307
  (97.6%) are graph singletons.
- Those linked offers form **9,846 components**, median size **2**, **largest = 6
  offers**. No mega-wallet emerges.
- Top-100 largest components hold just **1.68% of linked offers** (0.04% of all).

This holds up under generous loosening. Even at `MAX_MULT=50` (treating
50-way-shared coins as wallet links — almost certainly too loose), only **15.67%**
of offers link to anything and the largest component is **226 offers**.

**Interpretation.** The coin graph yields a *lower bound on linkage*, not a user
count, and that bound is weak: the data resists wallet reconstruction. Change-chains
exist but are rare because makers rarely chain offers off a single change coin within
the captured set. Note this only says the *coin-id crumbs we have* don't stitch the
offers together — it is **not** evidence of anonymity. The proper identity signal
(puzzle hashes resolved on-chain) wasn't indexed; resolving it is the real way to
count traders, and the coin-graph is just the weak proxy available without it.

Confidence on the components themselves: **High** (deterministic union-find).
Confidence that they ≈ wallets: **Low–Medium** — see caveats.

### CHART 1 — Linkage stays sparse at every threshold (cap sensitivity)

`research/dexie-offers/findings/data/06-participants-cap-sensitivity.csv`

| MAX_MULT | linked_offers | % of all offers | n_components | largest_component |
|---|---|---|---|---|
| 2 (strict change-chain) | 19,838 | **2.38%** | 9,846 | 6 |
| 3 | 32,639 | 3.92% | 13,997 | 19 |
| 5 | 51,643 | 6.20% | 18,084 | 52 |
| 10 | 75,713 | 9.09% | 20,955 | 68 |
| 20 | 97,376 | 11.69% | 22,112 | 173 |
| 50 (very loose) | 130,532 | 15.67% | 22,805 | 226 |

Takeaway: there is no cap at which the graph collapses into a few large wallets.
Linkage grows roughly linearly with how much artifact we admit, never revealing
hidden concentration. The coin graph cannot answer "how many users."

### CHART 2 — Component-size distribution (MAX_MULT=2)

`research/dexie-offers/findings/data/06-participants-component-dist.csv`

| component size | n_components | n_offers |
|---|---|---|
| 2 | 9,733 | 19,466 |
| 3–5 | 110 | 354 |
| 6–10 | 3 | 18 |

98.9% of components are just a single change-chain pair. The wallet streams we
*can* see are short.

---

## Cross-checks / proxies (where concentration *does* show up)

Because the graph can't count users, we triangulate with three proxies. They don't
agree on a number — they're different lenses — but all point the same way:
**a small set of actors drives most activity.**

### PROXY A — NFT creators: 891 DIDs behind 289k assets

NFTs touch 38% of offers; the substrate's `nft_meta.creator_id` is a DID where
present (Q2):

- **891 distinct creators** (872 of them DIDs) sit behind **288,945 distinct NFT
  assets** in 1,917 collections. One creator mints a whole collection.
- **DID-adoption is essentially universal among traded NFTs: 99.96%** of NFT legs
  carry a DID creator — a clean adoption-rate datapoint.
- Creator concentration is steep (Q2b): top-1 creator = **9.15%** of NFT legs,
  **top-10 = 43.7%**, top-50 = **74.6%**.

`research/dexie-offers/findings/data/06-participants-creator-concentration.csv`

| top-N creators | NFT legs | % of NFT legs |
|---|---|---|
| 1 | 32,967 | 9.15% |
| 10 | 157,457 | 43.70% |
| 50 | 268,739 | 74.59% |

This counts *creators*, not buyers/sellers, so it is a floor on total participants
but a strong statement about the **supply side**: the NFT economy on offer files is
produced by **hundreds**, not hundreds of thousands. Confidence: **High** (direct
distinct-count) for the creator count; **Medium** as a participant proxy (says
nothing about collectors).

### PROXY B — the AMM is a single mega-participant

`tibet2` is **one** smart contract, and it is the counterparty to (Q3):

- **163,603 offers — 19.6% of ALL settled offers**, and **46.1% of all offers
  since the label began (2025-04)**.

So a *single* automated actor accounts for nearly one in five trades across the
whole history and nearly half recently. One "participant," one-fifth of the
dataset. This is the strongest single piece of evidence that the offer count
vastly overstates the human population. Confidence: **High** (direct label; and a
*floor* — other unlabeled AMMs/bots exist).

### PROXY C — automation predates the label (bot fingerprint over time)

Reusing the 01-amm fingerprint (sub-minute fill **and** continuous >1e-3 XCH
amount) on single-pair XCH↔CAT offers, across the whole timeline (Q4):

`research/dexie-offers/findings/data/06-participants-botshare-yearly.csv`

| year | n XCH↔CAT | labeled AMM | unlabeled bot-like | total bot-like | % bot-like |
|---|---|---|---|---|---|
| 2022 | 21,158 | 0 | 126 | 126 | 0.6% |
| 2023 | 52,031 | 0 | 18,930 | 18,930 | **36.4%** |
| 2024 | 76,111 | 0 | 38,907 | 38,907 | **51.1%** |
| 2025 | 140,907 | 93,092 | 13,954 | 58,081 | 41.2% |
| 2026 | 90,393 | 67,530 | 4,354 | 20,913 | 23.1% |

The headline: **36–51% of XCH↔CAT offers look automated in 2023–24 — years before
the `tibet2` label existed** (labeled AMM = 0 in those rows). So the "few automated
agents, not 833k humans" reading is not an artifact of the AMM label; the
machine-shaped trades were always there. This is *suggestive* (the fingerprint also
catches fast human fills): Confidence **Low–Medium (inference)** — offered to show
the AMM share is a floor and automation is long-standing, not as a hard count.

---

## What is knowable vs not (summary)

| Question | Answer | Confidence |
|---|---|---|
| How many distinct *human* makers? | **Not answerable from this dataset** — addresses weren't indexed (but they're on-chain; recoverable via a chain pass) | High |
| Can the coin graph reconstruct wallets? | Only weakly: ≤2.4% of offers link under the strict reading, ≤15.7% under a loose one | High |
| Is participation concentrated? | **Yes, strongly** — 1 AMM = 19.6% of all offers; top-10 NFT creators = 43.7% of NFT legs | High (per proxy) |
| Min distinct linkage-clusters implied | ~823k (cap=2) → ~725k (cap=50) "clusters" — but this is dominated by graph singletons and is **not** a user count | Low (illustrative only) |

The "implied clusters" figure (n_components + singleton offers) is reported in the
script for completeness but is **not** a participant estimate — it's near the offer
count precisely *because* linkage fails. We deliberately do **not** headline it.

---

## Caveats (the change-chain method breaks in five ways)

1. **Parallel coins break chains.** A wallet making several offers at once funds
   each from a different coin → no shared id → counted as separate "wallets."
   Under-links (over-counts participants).
2. **Coin-combine merges chains.** A wallet that combines coins, or two wallets
   that transact, can share a coin → falsely merged. Over-links.
3. **Taker coins contaminate.** `involved_coins` includes the *taker's* coins too,
   so a shared coin may reflect a shared *counterparty* (esp. the AMM), not a
   shared maker. This is exactly why hub coins (k up to 10,168) appear and must be
   excluded — they're shared takers/contracts, not maker change-chains.
4. **The AMM dominates recent data**, so recent offers are disproportionately
   "linked through the taker" rather than through a maker wallet — another reason
   we cap multiplicity hard.
5. **Coverage is 84.7% and biased** (oldest offers of the busiest pairs dropped),
   so any change-chain spanning a missing offer is silently broken. Linkage is a
   **lower bound** on what the full chain would show.

Net: every bias makes the recovered linkage *weaker* (more fragmentation), so
"≤2.4% of offers are linkable" is a conservative floor — the real point stands
regardless: **the coin graph cannot count users.**

## Per-claim confidence
- No maker address; 0.66% originator coverage / 3 distinct values: **High**.
- 98.6% of coins single-use; change-chain edges sparse: **High**.
- Coin graph links ≤2.4% (strict) / ≤15.7% (loose) of offers; largest component
  6 (strict) / 226 (loose): **High** (deterministic).
- Components ≈ wallets: **Low–Medium** (the 5 caveats).
- 891 NFT creator DIDs; 99.96% DID-adoption; top-10 = 43.7% of NFT legs: **High**
  (count); **Medium** as participant proxy.
- AMM = 1 actor = 19.6% of all / 46.1% since 2025-04: **High** (floor).
- 36–51% bot-like XCH↔CAT in 2023–24 pre-label: **Low–Medium (inference)**.
