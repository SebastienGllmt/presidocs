# Recon — lay of the land (shared ground for all deep dives)

This is the **shared scratchpad** for the offer-files data analysis (post:
`posts/offer-files-data.html`). It records the high-level recon that seeded the
deep-dive theses. Each deep dive appends/maintains its own
`research/dexie-offers/findings/NN-<slug>.md`. **The published post is written by synthesis at
the end — do not write the post directly from a deep-dive agent.**

Read `research/dexie-offers/README.md` first for dataset provenance, coverage (84.7%,
biased), and gotchas.

## The query substrate (use this — do not re-stream the JSONL)

One streaming pass (`research/dexie-offers/pipeline/build-substrate.sql`) turned the 2.7 GB
deduped JSONL into a DuckDB database, queryable in seconds:

- **`generated/offers.duckdb`** — query with `./tools/duckdb generated/offers.duckdb -c "SELECT ..."`
  - **`offers`** (833,145 rows, one per offer): `id, status, date_found,
    date_completed, date_pending, date_expiry, block_expiry, spent_block_index,
    price, fees, mod_version, trade_id, known_taker_name, known_taker_source,
    mempool_cost, mempool_fees, mempool_combined, n_offered, n_requested,
    is_single_pair`.
  - **`legs`** (1,812,373 rows, one per offer×side×leg — tidy/long):
    `offer_id, date_completed, side ('offered'|'requested'), leg_idx, asset_id,
    code, name, amount, is_nft`.
- Portable exports: `generated/offers.parquet`, `generated/legs.parquet`.
- The huge bech32 `offer` blob, `involved_coins`, and NFT/collection nesting were
  intentionally **not** loaded (not needed; would bloat). If a deep dive needs a
  dropped field, re-read from `generated/dexie-offers-dedup.jsonl` with explicit
  columns (see the build script for the pattern).

Substrate validated against `README.md` known numbers: 833,145 unique
rows, all `status=4`, span **2022-01-14 → 2026-05-23**, multi-leg 4.26% offered /
6.47% requested. ✔

## Headline numbers (snapshot 2026-05-23)

| Metric | Value | Notes |
|---|---|---|
| Offers (completed) | 833,145 | = 84.7% of global, biased to missing oldest of busiest pairs |
| Legs total | 1,812,373 | avg 2.18 legs/offer |
| Single-pair (1×1) offers | **89.7%** | the simple "A for B" swap dominates |
| Involve XCH | **76.5%** | XCH is the hub asset (637,725 offers) |
| Involve an NFT | **38.1%** | huge — NFTs are a first-class use case |
| Involve a USD stablecoin | 6.1% | wUSDC.b, USDSC dominant |
| Involve a TIBET-* LP token | 4.6% | TibetSwap AMM liquidity tokens |
| Zero-fee offers | **81.4%** | median fee = 0 |
| Legs with no `code` | 20% (~362k) | 99.6% of these are NFTs; key on `asset_id` |
| Format `mod_version` | v2: 721,475 / v1: 111,670 | format migration over time |
| Time-to-settle (date_found→completed) | p50 ≈ **38 min**; p90 ≈ 92 d; p99 ≈ 660 d | long tail of offers that sat for months |

## Key structural findings & traps (read before forming conclusions)

1. **`known_taker` is a TibetSwap-only field, and only since ~2025-04.** dexie
   records `known_taker_source` *only* when the taker is the **TibetSwap AMM**
   (`tibet2`), and only began doing so in **2025-04** (zero coverage before).
   `pct_has_taker_info == pct_tibet` every month. So:
   - **Since 2025-04, 46.1%** of settled offers (n=354,521) were filled by the
     TibetSwap AMM. ⚠️ This is a *floor on AMM share* — other AMMs/takers are
     simply unlabeled. Do **not** read pre-2025-04 AMM share from this field.
   - Trap: `NULL = 'tibet2'` is `NULL` (not false), which `avg()` silently drops.
     Always `coalesce(known_taker_source,'')='tibet2'`.

2. **The #1 trade is NFT → XCH (224,879 single-pair offers).** NFTs aren't a
   sideshow. NFT share by month spiked to ~82% in mid-2022 (the Chia NFT boom),
   settled to 30–50% through 2023–25, and fell to ~6–17% in 2026.

3. **Top fungible pairs are truncated at the 10k API cap.** Many pairs land at
   exactly ~10,000 (XCH↔🐈, ↔NIOC, ↔wUSDC.b, ↔USDSC, ↔SBX, …). These are the
   per-pair-cap floors from `README.md`. **Any concentration / total-volume
   claim on hot fungible pairs is undercounted** — surface this caveat. NFT→XCH at
   225k is *not* capped (many distinct NFT assets, each its own slice).

4. **A game economy runs on offer files.** A tight cluster of CATs —
   `ALWORK/ALTOOL/ALWOOD/ALFOOD/ALORE/ALGOLD` (an "AL*" resource set), `G4M` +
   `TIBET-G4M-XCH`, and meme cats like `🐈`, `BEPE`, `GYATT` — show up in the top
   assets. Worth a concentration / category breakdown.

5. **Derived XCH/USD price tracks reality.** From single-pair XCH↔stablecoin
   offers (median, trimmed), the recent series reads ~$10 (mid-2025) declining to
   ~$2.5 (2026), matching XCH's real decline. Early months (2023–24) are
   low-sample and noisy and need per-stablecoin unit checks (some "USD" codes may
   not be 1:1). Promising as a "price oracle reconstruction" angle.

## Round-2 substrate extension (for O1/O2 — built 2026-05-24)

`research/dexie-offers/pipeline/build-substrate-extra.sql` added two more tables to
`generated/offers.duckdb` (also `generated/coins.parquet`, `nft-meta.parquet`):

- **`coins`** (2,220,331 rows): `offer_id, date_completed, coin_id` — exploded
  `involved_coins`. ⚠️ Coins are **single-use** (consumed on spend), so 1.97M of
  the 2.22M are unique — a shared coin across offers is the exception, arising
  mainly when a maker funds offer B with the **change coin** of offer A. So the
  useful signal is the **coin graph's connected components** (a UTXO change-chain
  clustering ≈ one wallet's offer stream), not raw coin reuse.
- **`nft_meta`** (360,302 rows, one per NFT leg): `offer_id, date_completed,
  price, side, asset_id, code, creator_id, creator_is_did, royalty_bps,
  mint_height, collection_id, collection_name`. **100% carry a `royalty_bps`**
  (modes: 500=5%, 1000=10%, 200, 0, 300). `creator_id` is a DID where present.

**Identity is a DATA GAP, not anonymity (record this).** Our indexed offer records
expose **no maker address** — `mempool.originator.puzzle_hash` is 0.7% coverage (3
distinct) and `known_taker` is only the AMM. But **Chia is a public chain**: the
maker/taker addresses are in the on-chain settlement spend; we simply didn't crawl
the chain to resolve the `involved_coins` → puzzle hashes. So per-trader counts are
**recoverable in principle** (a future on-chain indexing pass), just not from what
we collected. Until then, participant estimates come from the coin-graph components
(O1) or proxies (NFT creator DIDs, behavioral fingerprints).

## Per-thesis caveats reminder
- Early-timeline absolute counts/volumes for major pairs are **floors** (cap + bias).
- ~43%/20% of legs lack `code` (denominator-dependent) — bucket as NFT/unknown, never drop.
- Prices include spam/junk — use **median**, trim outliers, normalize direction
  (`price = requested.amount / offered.amount`).
- All numbers must come from a **committed, reproducible** query/script.
