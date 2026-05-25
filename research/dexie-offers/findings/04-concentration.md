# T4 — Concentration, asset categories & game economies

**Thesis.** Offer-file activity is *highly* concentrated in a handful of assets
sitting atop a massive dead long tail — and identifiable game/meme economies
(notably **Abandoned Land** and **go4me**) clear substantial volume entirely
through offer files, sometimes as nearly self-contained in-game economies.

All numbers come from `research/dexie-offers/analysis/04-concentration.sql` against
`generated/offers.duckdb` (snapshot 833,145 completed offers, 2022-01-14 →
2026-05-23). Run read-only.

> **CAVEAT carried by EVERY fungible-concentration number here.** The dexie API
> caps each `(offered, requested, status)` pair at the newest 10,000 records.
> That clips the **oldest tail of the BUSIEST fungible pairs** (everything
> ↔XCH, ↔stablecoins). Consequently: measured trade counts/volumes for hot
> fungibles are **floors**, and concentration *among fungibles* is
> **understated** — the true heads are bigger than what we can see, which would
> push every concentration metric (top-N share, Gini) *higher*, not lower. NFT
> assets are each their own per-pair slice, so the NFT universe count and
> NFT→XCH counts are essentially uncapped.

---

## Finding 1 — The asset universe is a few hundred live fungibles + a ~289k NFT cloud (Confidence: HIGH)

(Q1.) Distinct `asset_id`s seen on any leg:

| Universe | Distinct assets |
|---|---|
| All assets | 289,806 |
| NFTs (`is_nft`) | 288,945 |
| Fungible CATs (non-XCH, non-NFT) | **860** |
| …of which carry a ticker `code` | 745 |

The "289k assets" headline is almost entirely NFTs (each NFT is a unique
`asset_id`). The **fungible** economy is tiny by comparison: just **860**
distinct CATs ever traded. Concentration is a story about those 860.

---

## Finding 2 — Fungible trading is brutally concentrated; Gini ≈ 0.89 (Confidence: HIGH for the *direction*; the exact figure is a FLOOR)

(Q3, Q4.) Across the 860 fungible CATs (814,291 offer-leg appearances):

| Metric | Value |
|---|---|
| Top-10 assets' share of fungible trades | **29.2%** |
| Top-25 share | **56.5%** |
| Top-50 share | **74.2%** |
| Gini coefficient (over trade counts) | **0.891** |
| Assets traded ≤ 5 times ("dead on arrival") | 176 / 860 (20.5%) |
| Assets traded exactly **once** | 84 |

Because head-clipping removes trades from the *busiest* assets, the true top-N
shares and Gini are **higher** than these. So 0.89 is a lower bound on an
already-extreme inequality.

### Lorenz curve (Q5) — data: `data/04-concentration-lorenz.csv` exported inline

| Cumulative % of assets (poorest→richest) | Cumulative % of trades |
|---|---|
| 10% | 0.01% |
| 30% | 0.13% |
| 50% | 0.63% |
| 70% | 2.67% |
| 80% | 5.64% |
| 90% | 13.75% |
| 95% | 27.33% |
| 100% | 100% |

Read it: **the bottom 80% of fungible CATs account for 5.6% of all fungible
trades; the top 5% (≈43 assets) carry 73%.** A textbook power-law long tail.

---

## Finding 3 — Category mix: XCH is the hub; NFTs are a co-equal use case; "game" CATs are a real 7%+ slice (Confidence: HIGH)

> **⚠️ SUPERSEDED for the published category numbers.** This coarse bucketing
> (game 7.4%, meme 4.7%, "other" ~50%) was an early pass. The post and final
> taxonomy use the **description-driven classification** (`token-taxonomy.md`,
> `asset-categories.csv`, `15-category-shares.csv`): **Memecoin 27%, Game-economy
> 20%, Protocol 8%, Stablecoin 8%, …, Unclassified 2%.** Those are the authoritative
> shares; the table below is kept only for provenance of the original coarse cut.

(Q6.) Categories are assigned per leg and counted **once per offer they touch**,
so columns **overlap and do not sum to 100%** (most offers are A↔XCH, so they
land in two buckets).

> **Corrected 2026-05-24.** These are the current committed-query numbers. Two
> changes from the original draft: (1) **BYC (Bytecash)** — a Chia-native CDP
> dollar stablecoin — is now counted under `stablecoin` (was in `other_cat`),
> raising stablecoin to 7.8%; (2) the original `meme_cat` 6.7%/55,502 was stale —
> the committed conservative set (🐈/BEPE/GYATT) computes to 4.7%/38,742.

| Bucket | Offers touching it | % of all 833,145 offers |
|---|---|---|
| XCH | 637,725 | **76.5%** |
| other_cat (everything else fungible) | 418,731 | 50.3% |
| NFT | 317,210 | **38.1%** |
| stablecoin (wUSDC.b, USDSC, wUSDC, wUSDT, **BYC**) | 64,585 | **7.8%** |
| game_cat (AL* + G4M) | 61,321 | **7.4%** |
| meme_cat (🐈, BEPE, GYATT) | 38,742 | 4.7% |
| TIBET_LP (TibetSwap AMM LP tokens) | 37,431 | 4.5% |
| unknown_nocode (no ticker, not flagged NFT) | 1,458 | 0.2% |

Notable: **game CATs (7.4%) are on par with the entire stablecoin segment (7.8%,
including the Chia-native BYC) and well ahead of memecoins (4.7%) and LP tokens
(4.5%).** A game economy is, by offer count, a top-tier offer-file use case.

`other_cat` is large but unconcentrated — it is the union of hundreds of
governance/utility/"bucks" tokens (Farmer Bucks, Spacebucks, dexie bucks,
Moonbucks, Bytecash, HOA Coin, NioCoin, …), none individually dominant.

Category mix over time: `data/04-concentration-category-by-month.csv` (344 rows;
month × bucket × offers). Headline shifts visible in it: NFT share spiked in
mid-2022, game_cat dominated late-2022/early-2023 (Abandoned Land) and again
2025 (go4me), stablecoins/TIBET_LP are a steadier mid-period presence.

---

## Finding 4 (signature) — Two real game economies clear on offer files, each a burst-then-die, and Abandoned Land is nearly self-contained (Confidence: HIGH)

(Q9.) `legs.name` identifies the projects unambiguously:

| code | name |
|---|---|
| ALWORK / ALTOOL / ALWOOD / ALFOOD / ALORE / ALGOLD / ALWEAP | **Abandoned Land** — Work / Tool / Wood / Food / Ore / Gold / Weapon |
| G4M | **go4me** |
| TIBET-G4M-XCH | TibetSwap LP G4M-XCH |

**Abandoned Land is a self-contained in-game resource economy.** (Q8.) Of all
legs that appear opposite an AL*/G4M asset:

| Counterparty bucket | Leg appearances | Offers |
|---|---|---|
| AbandonedLand_resource (the cluster trading *itself*) | **394,843** | 47,418 |
| NFT | 26,031 | 23,951 |
| go4me (G4M / its LP) | 26,579 | — |
| **XCH (the chain's money)** | **8,564** | 7,792 |
| AbandonedLand_LP (TIBET-AL*-XCH) | ~650 | — |

The dominant counterparty to an Abandoned Land resource is **another Abandoned
Land resource** — players swap Wood for Ore for Food etc. directly via offer
files, with relatively little cash-out to XCH. That is an in-game crafting
economy clearing on a public DEX protocol rather than a game server.
go4me is different in character: G4M trades against XCH and against **go4.me
profile NFTs** (`go4.me | <handle> | @<x_handle>`) — a social/creator-token +
NFT economy.

### Timeline (Q10) — data: `data/04-concentration-game-timeline.csv` (47 rows)

Selected months (offers/month):

| Month | Abandoned Land | go4me |
|---|---|---|
| 2022-10 | 7,047 | 0 |
| 2022-11 | 6,149 | 0 |
| 2023-03 | 6,199 | 0 |
| 2023-04 | 4,280 | 0 |
| 2024-06 | ~300 | 0 |
| 2025-03 | 13 | 0 |
| 2025-08 | 10 | 4,045 |
| **2025-09** | 0 | **11,390** |
| 2025-10 | 0 | 5,130 |
| 2025-11 | 44 | 3,653 |
| 2026-02 | 15 | 8 |
| 2026-05 | 0 | 4 |

Two **non-overlapping bursts**: Abandoned Land owned late-2022 → early-2023
(~7k offers/mo at peak) then bled out over two years; go4me was *born* in
2025-08, peaked at **11,390 offers in 2025-09**, and was effectively dead by
2026. Each game is its own self-contained boom-and-bust, and offer files were
the settlement rail for both.

---

## Finding 5 — Asset lifecycle: a clear two-population split, not uniform burst-then-die (Confidence: MEDIUM-HIGH)

(Q11.) Span = `last_trade − first_trade` per fungible asset:

| Lifespan bucket | # assets | Median offers |
|---|---|---|
| 0 (single day) | 97 | 1 |
| 1–7 d | 54 | 9.5 |
| 8–30 d | 37 | 11 |
| 31–90 d | 64 | 10.5 |
| 91–365 d | 205 | 47 |
| **> 365 d** | **403** | **216** |

Median fungible asset: 322-day span, 50.5 offers. The population is **bimodal**:
~188 assets (≤30-day span) are short-lived bursts that die quickly (low median
offers), while 403 assets survive >1 year and accumulate real volume (median 216
offers). So "most assets burst then die" is **too strong** for fungibles overall
— the dead tail is real (176 assets ≤5 trades) but a plurality of *traded*
assets are long-lived. The **burst-then-die pattern is sharper at the
game-economy cluster level** (Finding 4) than for the median individual token.
(Note: span is bounded below by head-clipping removing old trades from busy
assets, which can only *shorten* measured spans for the hottest assets — so
long-lived heads are, if anything, understated.)

---

## Caveats summary
- **Fungible concentration metrics are floors** (10k per-pair cap clips busiest
  heads). Direction (extreme concentration) is robust; exact %/Gini understated.
- Category buckets are **per-offer membership and overlap** — do not sum to 100%.
- meme_cat is deliberately conservative (only clear memes 🐈/BEPE/GYATT); many
  "bucks" tokens sit in other_cat by design.
- NFT counts/universe size are reliable (uncapped); fungible counts are floors.
- All medians, not means; outlier-tolerant by construction (counting offers).

## Per-claim confidence
- Universe sizes (Q1): HIGH.
- Concentration shape / Lorenz / Gini direction: HIGH; exact figures are FLOORS.
- Category shares: HIGH (membership is exact; bucket definitions are a choice).
- Game-economy identification + self-contained AL* trading + two bursts: HIGH.
- Lifecycle bimodality: MEDIUM-HIGH (span is shortened for clipped heads).
