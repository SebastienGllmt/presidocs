# dexie.space dataset — findings

A living record of how we sourced the dexie.space completed-offer dataset that
backs the charts in `posts/offer-files-data.html`, what its limits are, and (later)
what the aggregation and analysis turned up. Sections are appended as we go.

- **Source:** `https://api.dexie.space/v1/offers` (`status=4` = completed/settled)
- **Pipeline:** `crawl-dexie.ts` → `dedup-dexie.ts` → `aggregate-charts.ts`
- **Raw dump:** `generated/dexie-offers-full.jsonl` (~3.9 GB, one JSON offer per line, with duplicates)
- **Analysis dataset:** `generated/dexie-offers-dedup.jsonl` (~2.9 GB, deduped by `id`, full records; use this — see [Preparing for analysis](#preparing-for-analysis))
- **Snapshot:** crawled through **2026-05-23**; data spans **2022-01-14 → 2026-05-23** (`date_completed`)
- **Coverage at snapshot:** **833,145 unique offers** of **983,597** reported globally — **84.7%**.
  (The global count drifts upward with live inflow, so re-running the coverage check
  later compares against a larger denominator; pin analyses to the snapshot above.)
- **⚠️ This dataset is `status=4` (settled) ONLY — that's only part of the offer-file
  universe.** See [Offer lifecycle](#offer-lifecycle-settled-is-about-half) below.

---

## Offer lifecycle: most offers never fill (settled ≈ 1 in 8)

Our analysis dump is **completed/settled (`status=4`) only**. That's correct for the
*financial* analysis (only fills move money on-chain), but it badly undercounts
**how many offer files have ever existed**. dexie's API returns a total `count` per
status, so we can size the other states cheaply without downloading them
(`research/dexie-offers/pipeline/status-counts.ts`). As of 2026-05-24:

| Status | Meaning | Count | Kind |
|---|---|---:|---|
| 4 | **Completed (settled)** ← our dataset | 985,102 | cumulative |
| 0 | Active / open (available right now) | 599,334 | **snapshot (stock)** |
| 6 | Expired (hit expiry, never taken) | 228,072 | cumulative |
| 3 | Cancelled (maker spent the coins to invalidate) | 91,361 | cumulative |
| 1 / 2 / 5 | Pending / Cancelling / Unknown (transient) | ~0 | — |

Status labels confirmed by inspecting a sample offer per status (e.g. Expired has
`date_completed == date_expiry` and no `spent_block_index`; Cancelled has a
`spent_block_index` but the spend was a maker reclaim, not a fill).

**⚠️ These per-status counts UNDERCOUNT churn — do NOT read "settled ≈ half".** An
earlier draft computed "~76% of resolved settled / ~half of ~1.9M" from these counts.
That is wrong: `status=3/6` (cancelled/expired) are a **pruned snapshot**, not a
cumulative ledger — dexie ages them out. We know this because the **reward-claims
data** (see Liquidity Incentive Program below) references **2.2M distinct offers in
just 10 months, 99.7% of which never settled** — already more than the entire ~1.9M
status snapshot. So cumulative offer *creation* is in the **millions** (dominated by
market-maker quotes that expire/cancel), and settled offers (~985k all-time) are a
**small minority**, not half. Use the status counts only as "current state," and the
reward data for the true churn. (Active=599k is also just a live snapshot.)

Caveats: these are **dexie-observed** offers (propagated over Splash); offers
**cancelled off-chain** (maker just deletes/withholds the file) are invisible, so the
true number of offer files ever *created* is higher still. Active (599k) is a live
snapshot and will itself resolve into completed/expired/cancelled over time.

---

## Liquidity Incentive Program (DBX rewards) — why offers sit open

dexie pays **market makers in DBX** (its governance token) to keep **open** offers
within a tight spread of the market price. This reframes the maker economics: a
maker who constantly cancels/recreates offers to track the price pays fees (network
+ the 1% Combined-Swap fee), but the incentive program *pays them back* — and **only
open offers earn**, so makers are paid to keep offers live rather than cancel. This
is almost certainly a big driver of the **~599k currently-open offers** (status=0).

**Three endpoints (indexed by `research/dexie-offers/pipeline/crawl-rewards.ts`):**
- **`/v1/rewards/stats`** → `generated/dexie-rewards-stats.json`. Snapshot (2026-05-24):
  `total_claimed` **683,601 DBX**, `last_month_claimed` 23,500, `outstanding_claims`
  2,884, `daily_reward_rate` **800 DBX/day** (= 8 incentive entries × 100/day).
  DBX ≈ **0.0082 XCH** (token_meta) → all-time rewards ≈ **~5,600 XCH** (rough;
  DBX price varied) — i.e. comparable to / larger than the ~2,860 XCH dexie *collected*
  in Combined-Swap service fees. The program looks like a **net subsidy** to liquidity.
- **`/v1/incentives`** → `generated/dexie-incentives.json`. The currently-incentivized
  pairs (8 entries = 4 pairs × both directions), each with `rewardRate` (DBX/day),
  `maxSpread` (**5%** — offers must be within 5% of market to qualify), `range`
  (min/max size), `marketPrice`, and an **`estimatedAPR`**:

  | pair (both directions) | reward | max spread | est. APR |
  |---|---|---|---|
  | XCH ↔ wUSDC.b | 100 DBX/day | 5% | 21–29% |
  | XCH ↔ wUSDC | 100 DBX/day | 5% | 16–31% |
  | XCH ↔ DBX | 100 DBX/day | 5% | 110–131% |
  | XCH ↔ SBX | 100 DBX/day | 5% | **306–341%** |

  Rewards are higher closer to market price and **shared among all qualifying offers**
  in a pair (so APR falls as more liquidity competes). The thin pairs (DBX, SBX) post
  triple-digit APRs; the liquid stablecoin pairs ~16–31%.
- **`/v1/rewards/claims`** → `generated/dexie-rewards-claims.jsonl`. **2,252,779**
  per-offer reward claims (newest-first, `page_size`≤1000). Fields: `id`, **`offer_id`**
  (links to an offer), `status`, `claimed_amount` (DBX), **`maker_puzzle_hash`**,
  `target_puzzle_hash`, `date_claimed`, `distribution_coin`, `public_key`, `signature`.

**⭐ The `maker_puzzle_hash` unlock.** Claims expose the **maker's address** —
exactly the field missing from the offers dump. So for reward-earning (market-maker)
offers we *can* identify and count makers (and measure reward concentration). It only
covers incentivized makers, not all traders, but it's a real partial answer to the
"who's trading" question we'd flagged as unindexed.

**Open analysis threads (post-crawl):**
1. **Do incentives subsidize market-making?** Rewards paid (~683k DBX ≈ ~5,600 XCH)
   vs fees (service ~2,860 XCH + network ~130). Is providing liquidity net-profitable
   (the 16–31% APR)? Reframes the pick-off finding: makers are *paid* to absorb it.
2. **Do incentives explain the open-offer stock?** Join claims' `offer_id` to status=0
   open offers — what share of the 599k open are incentivized? Are incentivized pairs
   over-represented among open offers?
3. **Market-maker identity & concentration** (via `maker_puzzle_hash`): how many
   distinct makers earn rewards; do a few dominate the 683k DBX?
4. **Did incentives tighten the incentivized pairs?** The 4 pairs vs non-incentivized
   (ties to the pick-off / tightness work, `12-tightness.md`).

---

## Background: what "offer files" are (read this if you're new to the concept)

This dataset is a pile of **completed Chia offers**. If you don't already know what
an offer file is, here's the context so you understand what each record represents.

**The core idea.** An *offer file* is a self-contained, trustless trade proposal
that lives **off-chain** as a plain text string. The maker writes "I'll give X for
Y", and that intent is captured in a file anyone can hold, copy, or post anywhere.
The blockchain is touched **only when someone accepts** (settles) the offer — not
when it's created, listed, or cancelled. It's an *intent* system: orders are free
and off-chain; only a fill costs an on-chain transaction.

**Chia's version (what this dataset is).** On Chia, an offer file is an
*incomplete, partially-signed spend bundle* encoded as a bech32 string (prefix
`offer1…`). It reserves the maker's coins and uses a `settlement_payments` puzzle
that *announces* the payments required for the trade to complete, so the spend
**fails unless both sides are satisfied in the same block** — atomic, no
counterparty risk, no intermediary. Properties that matter when reading the data:

- **Trustless / tamper-proof:** any change to the file invalidates it. Anyone can
  accept it; you can't alter the terms.
- **Partial fills & aggregation:** payments are specified as "this puzzle hash for
  this amount," not a specific coin, so change works and multiple parties can
  combine to fill one offer.
- **Two ways to cancel:** off-chain (just don't share / delete it) or **on-chain
  (spend the reserved coins**, which invalidates any copy already circulating).
  The on-chain cancel is why a coin can only ever back one settled trade.
- **Lifecycle / status:** `PENDING_ACCEPT` → `PENDING_CONFIRM` → `CONFIRMED`
  (or `CANCELLED`). **This dataset is `status=4` = completed/settled only.**

**dexie + Splash (where this data comes from).** [dexie.space](https://dexie.space/)
is an aggregator/indexer/marketplace for Chia offers. Offers propagate over
**Splash**, a libp2p (gossipsub + Kademlia DHT) peer-to-peer network for sharing
offer files across the Chia ecosystem; dexie observes Splash and indexes every
offer. Each record here is one offer dexie saw settle on-chain.

**Why this dataset exists.** It's the real-world track record of offer-file
trading &mdash; evidence of how much volume the offer-file model has actually
carried &mdash; collected to back charts in a blog post about offer files. For
*this* doc, only the Chia/dexie mechanics above matter; you need nothing beyond
them to understand the data.

### Sources / further reading

| Source | What it covers |
|---|---|
| [Chia Offers — Chialisp docs](https://chialisp.com/offers/) · local: [`sources/chia-offers.md`](sources/chia-offers.md) | Official mechanism: settlement-payments puzzle, spend bundles, atomicity, trustlessness |
| [Chia Offers CLI tutorial](https://docs.chia.net/guides/offers-cli-tutorial/) · local: [`sources/chia-offers-cli.md`](sources/chia-offers-cli.md) | Lifecycle in practice: `make_offer` / `take_offer` / `cancel_offer`, statuses |
| [dexie.space](https://dexie.space/) · API `https://api.dexie.space/v1/` | The aggregator this dataset is crawled from (see [How the sync works](#how-the-sync-works)) |
| [Splash (github.com/dexie-space/splash)](https://github.com/dexie-space/splash) | The libp2p P2P network offers propagate over before dexie indexes them |
| dexie blog — "Combined Swap" launch (2024) | dexie's liquidity aggregator: routes one swap through combined offers + the TibetSwap AMM, settled atomically in one offer. Explains the **`mempool_combined`** flag (≈half of recent offers; 59% of TibetSwap fills are routed Combined Swaps) and a 1% XCH service fee (not in the `fees` field). |

---

## How the sync works

### The wall: 10,000 records per query

`GET /v1/offers` is hard-capped. Empirically (all verified against the live API):

- **`page` ≤ 100**, and **`page_size` is silently clamped to 100** — so any single
  query returns at most the **newest 10,000** records. Page 101 returns
  `400 {"error_message":"Max page is 100."}`.
- **The only honored filters are `offered`, `requested`, and `status`.**
- **Sort is descending-only** (`date_completed` or `date_found`). There is **no
  ascending sort, no date-range filter, and no price/amount filter** — every such
  parameter we tried (`completed_after`, `before`, `min_price`, `mod_version`, …)
  is silently *ignored* (returns the unfiltered newest-first set).

With ~983k completed offers and no date cursor, naive offset paging can never see
more than the most recent 10,000. (This is the classic Elasticsearch
`index.max_result_window` limit surfaced as "Max page is 100.")

### The workaround: partition by asset, then page within each slice

Since `offered`/`requested` *do* filter, we slice the query space so each slice is
under 10k, then page within it:

1. **Level 1 — partition by offered asset.** Run `offered=A` for every asset `A`
   in a *complete* universe. Every offer has an offered leg, so the union covers
   everything. The universe is
   `/v1/assets` (3,013 CATs) **∪** every asset in `/v1/pairs` **∪** `{xch}`.
   - ⚠️ **`xch` is the native coin and is *not* in `/v1/assets`.** Missing it
     silently drops every offer that *offers* XCH (~222k records) — this was the
     single biggest bug while building the crawler.
2. **Level 2 — sub-split overflow assets.** If `offered=A` exceeds 10k, sub-query
   `requested=B` for `B` over the universe to break it into smaller slices.
3. **Level 3 — accept the floor.** If a fixed `(offered=A, requested=B)` pair
   *still* exceeds 10k, we keep its newest 10k; the older remainder is
   unreachable (see [Limitations](#limitations--known-gaps)).

Duplicates are expected (multi-leg offers match multiple `A`; overflow paging
overlaps sub-queries). Every offer carries a stable `id`, so **dedup happens
downstream** off the local dump — we never re-hit the API to re-slice.

### Running it

`research/dexie-offers/pipeline/crawl-dexie.ts` is resumable (checkpoints after every query; Ctrl-C
saves and exits) and self-paces against HTTP 429.

| Command | Use |
|---|---|
| `bun research/dexie-offers/pipeline/crawl-dexie.ts` | Fresh crawl / resume |
| `PATCH=1 bun research/dexie-offers/pipeline/crawl-dexie.ts` | Top up an existing dump, fetching only what's missing and appending |
| `FULL=1 bun research/dexie-offers/pipeline/crawl-dexie.ts` | Completeness pass: sub-query every overflow asset's `requested=B` over the *whole* universe (recovers partners the default newest-10k discovery misses) |

Coverage check (streaming, so it won't OOM on the multi-GB dump):

```sh
bun -e 'const s=new Set();let buf="";const d=new TextDecoder();for await(const c of Bun.file("generated/dexie-offers-full.jsonl").stream()){buf+=d.decode(c,{stream:true});let n;while((n=buf.indexOf("\n"))>=0){const l=buf.slice(0,n);buf=buf.slice(n+1);const i=l.indexOf("\"id\":\"");if(i>=0)s.add(l.slice(i+6,l.indexOf("\"",i+6)))}}console.log("unique:",s.size.toLocaleString())'
```

---

## Limitations & known gaps

We reached **84.7% (833,145 / 983,597)**. The progression while building the
crawler — 518k → 817k (fixing the `xch` seed + sub-split bugs) → 833k (the `FULL`
completeness pass, +15.6k) — shows steeply diminishing returns. The remaining
~150k gap is **structural**, not a crawler bug. It breaks down as:

1. **Genuine per-pair >10k overflow — impossible via the API (~80–100k, the bulk).**
   The cap is per `(offered, requested, status)` triple, and there is no further
   filter to split a single hot pair. The loss concentrates in stablecoin↔XCH
   flows, e.g. `ec25b77b→XCH` loses ~26.4k, `a8ff1d84→XCH` loses ~23.5k, XCH's own
   pairs lose ~12k. These oldest tails simply cannot be paged.

2. **Multi-leg offers don't sub-split.** **6.5%** of offers (53,933) request
   *multiple* assets, and `requested=B` does not match a multi-asset-requested
   offer. So for overflow assets, these can't be recovered by sub-splitting at
   all. (Separately, **4.3%** (35,481) are multi-leg on the *offered* side —
   mostly fine, since they match any of their offered legs.) _Figures from
   JSON-parsing the deduped set; an earlier quick regex scan over the raw dump
   mis-estimated these as 8.3% / 40.5% — see the note on parsing below._

3. **The asset universe is incomplete on the requested side.** ~**20,137**
   distinct requested-side assets (NFTs / delisted CATs) are absent from
   `/v1/assets` and `/v1/pairs` — they appear in 33,883 *captured* offers and an
   unknown number of *missed* ones. A long thin tail; expandable in principle but
   low yield.

### The bias that matters for charts

The missing data is **not random**: the per-pair cap always drops the **oldest**
offers of the **busiest** pairs. So **early-timeline points for major pairs
(anything ↔ XCH / stablecoins) undercount** and should be read as a floor.
Recent-period activity and overall shape are well-covered.

### Going beyond ~85%

The only route past the API ceiling is reconstructing history from the **Chia
blockchain** (offers settle on-chain). That's out of scope for now; the dump is as
complete as the public API allows.

---

## Preparing for analysis

### The analysis-ready dataset

`research/dexie-offers/pipeline/dedup-dexie.ts` turns the raw dump into the file analysis should use:

- **`generated/dexie-offers-dedup.jsonl`** — **833,145 unique offers**, **~2.9 GB**,
  one JSON object per line. **Deduped by `id`, nothing else dropped** — every field
  from the API is preserved verbatim.

Full per-record schema (19 fields). The ones analysis usually wants:

```jsonc
{
  "id": "F5pKKz…",                                // stable unique id (dedup key)
  "status": 4,                                    // always 4 (completed) in this dataset
  "date_completed": "2026-05-21T23:32:11.000Z",   // UTC ISO — settlement time, primary time axis (never null here)
  "date_found": "2026-05-21T23:30:34.795Z",       // UTC ISO — when the offer was first seen
  "price": 0.3024671052631579,                    // == requested.amount / offered.amount (verified 100% on single-leg; ambiguous for multi-leg — derive your own)
  "fees": 0.0005,
  "offered":  [{ "id": "bbb51b…", "code": "wUSDC", "name": "Ethereum warp.green USDC", "amount": 30.4 }], // amounts in human units, NOT mojos
  "requested":[{ "id": "xch",     "code": "XCH",   "name": "Chia",                      "amount": 9.195 }]
}
```

Also present on every record (kept, less commonly used in analysis): `offer` (the
bech32 offer blob), `involved_coins`, `mempool` (`{id, cost, fees, combined}`),
`trade_id`, `related_offers`, `date_pending`, `date_expiry`, `block_expiry`,
`spent_block_index`, `mod_version`, `known_taker`.

### Gotchas every analysis must respect

- **Stream it, don't slurp it.** At ~2.9 GB, `Bun.file().text()` will OOM (as the
  raw 3.9 GB dump does). Read line-by-line with a stream reader (see the
  coverage-check snippet above for the pattern).
- **Coverage is 84.7% and biased** — see [Limitations](#limitations--known-gaps).
  The oldest offers of the busiest pairs (anything ↔ XCH / stablecoins) are
  undercounted, so **early-timeline absolute counts/volumes for major pairs are
  floors, not exact.** Recent activity and overall shape are reliable. State this
  caveat on any historical chart.
- **Multi-leg.** `offered` and `requested` are arrays (4.3% / 6.5% have >1 leg).
  Iterate *all* legs for per-asset volume; decide explicitly how a multi-leg offer
  maps to a "pair."
- **~43% of legs have `code: undefined`** (360k leg appearances) — NFTs / unknown
  CATs with no ticker. Key on `id`, not `code`; treat missing codes as a distinct
  "unknown" bucket rather than dropping them silently.
- **`price` direction.** `price` = `requested.amount / offered.amount` (verified
  100% on single-leg offers). Mind the direction when building a series for a
  given pair — half the offers for a pair are the reverse direction, so normalize
  (e.g. invert one side) before combining, or you'll average a price with its
  reciprocal. Undefined/ambiguous for multi-leg offers.
- **Junk/spam prices.** Anyone can post an offer (e.g. 1 XCH for $0.32). Use the
  **median** (not mean) for price series and consider outlier trimming.
- **USD volume:** identify stablecoin legs by code — present ones are
  `wUSDC.b` (dominant), `USDSC`, `wUSDC`, `wUSDT`, and `TIBET-*-XCH` LP variants.
  Match deliberately; don't assume a single code.
- **Don't re-hit the API.** All slicing is done off the local dump.
- **Parse, don't regex.** Quick `grep`/`indexOf` scans over the JSONL misled us on
  leg structure once already (the multi-leg figures above). `JSON.parse` each line.

### Sub-agent briefing (paste this into any data-analysis sub-agent)

> You are analyzing settled trades from the Chia DEX aggregator dexie.space, for
> charts in `posts/offer-files-data.html`. **Read `research/dexie-offers/README.md` first** for full
> context. Use **`generated/dexie-offers-dedup.jsonl`** (833,145 unique completed
> offers, ~2.9 GB JSONL, deduped by `id`, full records). Key fields: `id`,
> `date_completed` (UTC ISO, primary time axis), `date_found`, `price`, `fees`,
> `offered[]`, `requested[]` (legs: `{id, code, name, amount}`, amounts in human
> units); `offer`/`involved_coins`/`mempool`/etc. are also present.
>
> Hard rules: (1) **stream the file line-by-line** with `bun` + a stream reader —
> never load it whole, never load the raw `dexie-offers-full.jsonl`. (2) Coverage
> is **84.7% and biased toward missing the oldest offers of the busiest pairs**
> (↔XCH/stablecoins) — treat early-timeline major-pair counts/volumes as floors
> and surface this caveat on any historical output. (3) `offered`/`requested` are
> **arrays** (multi-leg) — iterate all legs; key assets on `id` (≈43% of legs have
> no `code`). (4) Prices include **spam/junk** — use median, trim outliers. (5)
> Work **only off the local dump**; do not call the dexie API. (6) `JSON.parse`
> each line — do not regex the JSON. Report method and any filtering you apply.

## Substrate, tooling & workflow (read this to continue the work)

Everything is queried from a **DuckDB substrate**, `generated/offers.duckdb`
(gitignored). CLI binary: `./tools/duckdb` (also gitignored; v1.5.3 universal — re-fetch
from the DuckDB GitHub releases if missing). **Always query `-readonly`** so parallel
agents don't lock it: `./tools/duckdb -readonly generated/offers.duckdb -c "SELECT …"`.

**Tables** (build script → contents):
- `offers` / `legs` — `research/dexie-offers/pipeline/build-substrate.sql` from
  `generated/dexie-offers-dedup.jsonl`. `offers`=833,145 (one/offer, status=4 only);
  `legs`=1,812,373 (tidy: one row per offer×side×leg; `asset_id,code,name,amount,is_nft`).
- `coins` / `nft_meta` — `research/dexie-offers/pipeline/build-substrate-extra.sql` (recovers fields
  dropped from the base substrate). `coins`=exploded `involved_coins` (single-use; weak
  for wallet-linking). `nft_meta`=one row/NFT leg with `creator_id` (DID), `royalty_bps`,
  `collection_name`, `mint_height`.
- `token_meta` — `research/dexie-offers/pipeline/build-token-meta.sql` from `generated/dexie-assets.jsonl`
  (fetched by `crawl-assets.ts`). dexie's CAT registry: `code,name,description,is_nft,…`.
  **The `description` field is how tokens are categorized** (not by ticker).
- `reward_claims` — `research/dexie-offers/pipeline/build-rewards-substrate.sql` from
  `generated/dexie-rewards-claims.jsonl` (fetched by `crawl-rewards.ts`). 2,252,779
  liquidity-incentive claims (2025-08→2026-05). Carries **`maker_puzzle_hash`** (the
  only maker-address source we have), `offer_id`, `claimed_amount` (DBX), `date_claimed`.

**Crawlers / API** (all separate from the 2.9GB offers crawl):
`crawl-assets.ts` (CAT registry), `crawl-rewards.ts` (reward claims, resumable),
`status-counts.ts` (offers per lifecycle status), `25-cancel-cost.ts` (newest 10k
cancelled offers w/ mempool bundles). `/v1/offers/{id}` resolves a single offer (used
to verify pruning). Offers API clamps `page_size` to 100 / `page`≤100 (10k cap);
rewards/assets allow larger pages.

**Token taxonomy & mapping:** `research/dexie-offers/findings/token-taxonomy.md` (the 10 final
categories) → `research/dexie-offers/findings/asset-categories.csv` (committed asset→category map,
classified from descriptions) → `research/dexie-offers/analysis/15-categorize.sql` →
`research/dexie-offers/findings/data/15-category-shares.csv` (feeds the "what gets traded" chart).

**Charts → post:** `research/dexie-offers/charts/make-charts.ts` reads the finding CSVs (+ some
hardcoded series, cited in comments) → `generated/charts/*.svg`; then
`research/dexie-offers/charts/inline-charts.ts` injects each into `posts/offer-files-data.html`
between `<!--CHART:id--> … <!--/CHART:id-->` markers (idempotent — rerun after editing
charts). CSP-clean (presentation attributes only). Post has 24 charts.
**After any post edit, verify every narration `<mark name>` has a matching article
`id`** (a grep one-liner used throughout) and that it bundles
(`bun build ./posts/offer-files-data.html --outdir /tmp/x --target browser`).

## Analysis

Full write-up lives in **`research/dexie-offers/findings/`** (one file per thesis), seeded by
**`research/dexie-offers/findings/00-recon.md`**. Each finding is backed by a committed query
in `research/dexie-offers/analysis/NN-*.sql` and chart data in `research/dexie-offers/findings/data/`.
Headline results that shaped `posts/offer-files-data.html`:

1. **AMM takeover** (`01-amm.md`): since dexie began labeling fills (2025-04),
   **46% of settled offers were filled by the TibetSwap AMM**, trending to ~67% in
   2026 — a *floor* (only `tibet2` is labeled). AMM fills settle in ~35s vs ~3.9h
   for P2P.
2. **NFTs** (`02-nft.md`): **38% of offers involve an NFT**; NFT→XCH is the #1
   route (224,879). Sticky 0.1–0.2 XCH "floor" whose USD value collapsed ~5–8×.
   Top-10 collections = 54% of XCH volume (Chia Friends blue-chip; go4.me 2025 wave).
3. **Price oracle** (`03-price-oracle.md`): XCH/USD reconstructs cleanly from
   warp.green stablecoin trades (~$31→<$3), 1.8% spread — **but exclude `USDSC`**:
   it is the old **Stably USD**, a real peg that **broke after custodian Prime
   Trust's 2023 insolvency** (implied XCH ~$37 in 2022–23, then $160→$695 in
   2024–26 as it depegged; usage 804→13 offers/yr). Lesson: a stablecoin is only as
   good as its off-chain custodian — validate the peg against the data.
4. **Concentration** (`04-concentration.md`): 860 fungible CATs vs 288,945 NFTs;
   Gini ≈ 0.89 (a floor); game economies (Abandoned Land, go4me) = 7.4% of offers,
   on par with the stablecoin segment (7.8%, incl. the Chia-native stablecoin BYC).
5. **Microstructure** (`05-microstructure.md`): 81% zero-fee (fees ≈ a
   block-priority bid); bimodal fill times; v1→v2 format cliff in early 2023;
   settled junk <0.5% and falling (settlement filters posting-side spam).

Round-2/3 findings (also in `research/dexie-offers/findings/`):
6. **Participants** (`06-participants.md`): no maker address in the offers dump
   (data gap, not anonymity — Chia is public); coin graph barely links wallets.
7. **Royalties** (`07-royalties.md`): 100% of NFTs set a royalty (median 5%→10%);
   trustless offers *enforce* it (on-chain — a coin-structure inference).
8. **Expiry** (`08-expiry.md`), **On-chain cost** (`09-onchain-cost.md`),
   **AMM-tightening null** (`10-amm-tightening.md`), **USD-denominated/RWA**
   (`11-usd-denominated.md`), **Market-maker tightness/pick-off** (`12-tightness.md`).
21. **Liquidity Incentive Program** (`21-incentives.md`): see section above; the
   reward data is the source of the maker-identity and churn findings.

## Handoff — open threads & how to continue

Context ran out mid-investigation; pick up here.

**✅ RESOLVED 2026-05-24 — measure (3): offers' share of ACTUAL Chia compute.**
- **Source:** `https://api.coinset.org/get_block` (`block.transactions_info.cost` =
  a block's real CLVM cost). Path is 2 calls/block: `get_block_record_by_height`
  (height → header_hash) → `get_block` (hash → cost). Rate limits gentle (~74ms/call,
  no 429s on small bursts).
- **Method** (`research/dexie-offers/analysis/26-actual-blockspace.ts`): can't fetch all 525,728
  occupied blocks, so **sample** K=120 random heights/month, fetch real cost (0 for
  non-tx blocks — **68% of heights are non-transaction**), estimate month's total
  compute = mean(sample) × blocks, divide offer compute by it. Block costs cached in
  `generated/block-costs.jsonl` (6,600 so far). Heavy-tailed denominator → **per-year
  is robust, per-month too noisy to chart.**
- **‼️ Numerator double-count fixed.** `sum(mempool_cost)` counted each Combined-Swap
  bundle once *per offer in it* → overcounted **~1.78×** (307.8T → **173.2T** after
  dedup on `mempool.id`). This also corrected **measure (2)**: capacity peak ~1.0% →
  **~0.53%** (`18-blockspace-by-month.csv` regenerated from the deduped per-month
  numerator in `26-month-input.csv`). The 09-onchain-cost "307.75T total" is the old
  naive figure.
- **Result (post `chart-actual-compute`):** offers were **~6% of actual Chia compute
  2022–24, then ~40% (2025) / ~33% (2026), ~10.5% all-time.** The jump is **not** offer
  growth — offer compute held ~flat (36–63T/yr) while the chain's total compute
  **collapsed ~4×** (617T in 2024 → 158T in 2025) as other activity waned. So offer
  files became a dominant on-chain use by *attrition*, not expansion.
- **Still open:** measure (4) transaction-*count* share (would need per-block tx
  counts, not just cost); the cancellation uplift (×0.20) is one window applied flat;
  per-year denominator is a sample (tighten with larger K via the cache).

**Other open threads:**
- **Cancellation footprint is one recent window** (0.195× settled, `25-cancel-cost.ts`)
  applied flat across history; status=3 is pruned/10k-capped so a full history isn't
  retrievable from the API.
- **All-time reward value unvalued** (`22-reward-value.sql` only covers 2025-08→2026-05,
  the claims window; pre-Aug-2025 monthly claims aren't available).
- **Cancelled/expired estimate** (~6.5M, the "1 in 8 settles" chart) scales reward churn
  by DBX payout — a floor; could be firmed up with the measure-(4) work.
- **Maker identity** (`maker_puzzle_hash` in `reward_claims`) only covers reward-earning
  makers; full trader identity needs resolving `involved_coins`→puzzle-hashes on-chain.

**Repeated lesson (6 corrections this session):** within-data facts held; *absolute /
derived / externally-pinned* numbers repeatedly needed fixing (USDSC peg, BYC class,
"anonymous", block-rate, "settled≈half", cancel "~2×→0.195×"). **A number-by-number
fact-check pass over every absolute claim in the post is still outstanding** and
recommended before audio (`bun run generate posts/offer-files-data.html`).
