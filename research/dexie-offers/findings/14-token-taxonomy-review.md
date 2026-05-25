# Token taxonomy — gap-analysis review (FINAL category list)

Reviews the seed list in `token-taxonomy.md` against the real descriptions. All
numbers from `research/dexie-offers/analysis/14-taxonomy.sql` (read-only DuckDB), **weighted by
offer activity** (`count DISTINCT offer_id`), descriptions as source of truth.

**Scope read:** the top ~120 CATs by offer activity cover **~90%** of all CAT
offer activity (cumulative); I read every description down to rank ~100 (~88%) and
skimmed the rest. CAT-side denominators: 860 traded CATs, **595,148 offers involve
≥1 CAT**, **637,725 (76.5%) involve XCH** (the hub — every non-trivial category
overlaps heavily with XCH, since most offers are CAT↔XCH). NFT side: 317,210
offers involve an NFT across 1,885 collections.

> **Share convention.** Percentages below are share of **all 833,145 offers** and
> are **illustrative** code-set aggregates for sizing, *not* the final mapping
> (which the next step builds). They are **not mutually exclusive** at the offer
> level (a single offer can have a CAT leg + an XCH leg; CAT↔CAT offers count in
> two CAT buckets). Treat them as "this category touches ~X% of all offers."

---

## FINAL category list

### CAT-side (classified from `token_meta.description`)

| Category | One-line definition | Example tokens (code — name) | ~Share of all offers |
|---|---|---|---|
| **Stablecoin** | A unit pegged (or formerly pegged) to an off-chain asset — USD bridges, the Chia-native CDP dollar, and bridged ETH units. | wUSDC.b — Base warp USDC; wUSDC — Eth warp USDC; BYC — Bytecash (CDP $-peg); USDSC — Stably USDS Classic (depegged); wmilliETH — warp ETH | **~7.9%** |
| **Game-economy token** | In-game currency / resource / utility for a playable game on Chia. The single biggest CAT bucket. | FBX — Farmer Bucks; ALWORK/ALORE/ALGOLD — Abandoned Land; XFUEL, FHW, THW; CMTG — CMT Gold; MIO — Marmots.io | **~17.9%** |
| **NFT-project utility token** | A CAT minted by / earned from / redeemable against a specific NFT collection (not itself a game). | G4M — go4me; MZ — Monkeyzoo; CHEEZE — SpaceRatZ; NeckCoin; WAR — WarBear; ZOMB | **~5.2%** |
| **Memecoin** | Joke / hype / "fun-not-utility" tokens, including general-purpose "currency" memes. | BEPE; SBX — Spacebucks; MBX — Moonbucks; MJO — MoJo•JoJo; PEPE; 🌱 SPROUT; HOA; C2R | **~19.3%** |
| **Social / community token** | Discord/community "points" tokens — proof-of-participation currency inside a social group (chiefly the TangGang economy). | PP — PeelPoint; MINUTES — TangTalk; ❤️ LOVE; NINJA; GOLD (Tang Bears) | **~2%** |
| **Protocol / platform / infra token** | Governance + DeFi + on-chain-service / infrastructure tokens (governance folded in here). | DBX — dexie bucks; CRT — Circuit; DIG — DIG Network; INCL1 — Inception Liquidity; NAME — Namesdao; GWT — Green Wallet | **~5.8%** |
| **LP token** | TibetSwap AMM liquidity-pool receipts (no description, classified by `TIBET-…` code prefix). | TIBET-G4M-XCH; TIBET-FBX-XCH; TIBET-🪄⚡️-XCH; TIBET-HOA-XCH | **~4.5%** |

### NFT-side (classified from `nft_meta` collection)

| Category | One-line definition | Examples | ~Share of all offers |
|---|---|---|---|
| **NFT** | Generic NFTs — PFP sets, art, game NFTs, collectibles. | go4.me PFPs; ChiaPhunks; Chia Friends; CHIA MONSTER TOWER WARRIOR; DataLayer Minions | **~38%** (NFT-involved offers) |
| ~~**RWA**~~ | *(dropped — see below)* tokenized real-world assets. | FarmGPU 4090 (26 offers) | **<0.01%** |

### Remainder

| Category | Definition | ~Share of all offers |
|---|---|---|
| **Unclassified** | No description AND not code-classifiable: the small non-LP no-desc tail + truly ambiguous tokens. | **~2–3%** (see estimate below) |

**Final count: 7 CAT buckets + NFT + Unclassified = 9 reader-facing buckets** (RWA
dropped/folded into NFT). Tractable for a chart.

---

## Accept / reject verdict on each candidate-additional category

- **NFT-project utility tokens — ACCEPT (new).** A real, distinct cluster worth
  ~5.2%. Descriptions explicitly tie the CAT to an NFT collection, not a game:
  G4M "claim your free go4.me PFP and earn royalties" (13,427 offers), MZ "native
  token of the Monkeyzoo NFT project… yield $MZ just by holding an NFT" (12,624),
  CHEEZE "utility token… @ SpaceRatZNFT" (4,255), NeckCoin (3,823), ZOMB
  "Zombie/Horror Graphic Art NFT… CAT2 token to generate interest in our NFT
  artists" (1,391). Distinct from game-economy because there's no playable game —
  the value driver is an NFT collection.

- **DeFi / protocol tokens — ACCEPT, but MERGED into "Protocol / platform / infra".**
  Real but thin individually: INCL1 "Inception Liquidity L1" (3,735), CRT "Circuit
  Token" (3,586, no-desc but Circuit is a known Chia CDP/DeFi protocol), DIG
  Network (2,029), NAME "Namesdao .xch Name Service" (965), GWT "Ecosystem of
  products for Chia network" (1,562). Too small to stand alone and conceptually
  adjacent to governance — fold governance + DeFi + infra into one **Protocol /
  platform** bucket (~5.8%).

- **Social / community tokens — ACCEPT (new), borderline-keep.** The TangGang
  Discord economy is a genuine, self-describing cluster: PP "currency within the
  TangGang community on the Chia Discord economy" (4,141), MINUTES "TangTalk…
  proof-of-use" (2,982), ❤️ LOVE / NINJA / GOLD (Tang Bears). ~2% combined.
  Distinct from memecoin (these are explicitly *participation currency in a named
  community*, not jokes) and from game (no game). Kept as its own small bucket; a
  defensible alternative is to merge it into Memecoin if 9 buckets is too many.

- **Commemorative / airdrop tokens — REJECT as its own bucket.** Candidate was
  CH21 "Chia Holiday 2021" (10,032 offers — large!) and DEGEN (redemption/airdrop).
  But "commemorative" is an *origin*, not a *function*, and it cross-cuts every
  other bucket (CH21 trades like a memecoin/collectible; DEGEN is an NFT-redemption
  token). Splitting it would steal volume from cleaner buckets. CH21 → Memecoin
  (collectible-meme), DEGEN → NFT-utility. Do not create the bucket.

- **"Currency" / general-purpose money vs Memecoin — REJECT the split.** Tokens
  like SBX "the galactic monetary standard," MBX Moonbucks, ¢NI "first memecoin
  index" all *self-describe as money* yet are unmistakably meme/hype tokens with no
  backing. There is no Chia CAT that is a serious non-meme general-purpose currency
  outside the Stablecoin bucket. Folding "currency" into Memecoin keeps the line
  clean: **pegged → Stablecoin; everything else aspirational → Memecoin.**

### Others discovered

- **Game-economy is its own thing and is the largest CAT bucket (~17.9%).** Seed
  called it "Game token"; confirmed and renamed **Game-economy token**. Two huge
  self-contained economies dominate: FarmerVerse (FBX + ~15 X-resource/animal
  tokens, ~77k offers) and Abandoned Land (AL* resource set, ~48k offers), plus CMT
  Gold, Marmots.io, Oxygen Hunters, Chia Dungeon (SHD), Proof-of-Treasure (POTT).
  Descriptions are explicit ("Main currency used in FarmerVerse," "Currency for
  Abandoned Land"). This is the headline finding — a real game economy runs on
  offer files.

---

## Recommended splits / merges (summary)

- **MERGE** Governance → into **Protocol / platform / infra** (governance alone was
  basically just DBX; DeFi + infra round it out).
- **MERGE** "currency" → into **Memecoin** (no real non-meme currency exists here).
- **MERGE** commemorative/airdrop → into the functional bucket each token belongs to.
- **KEEP SEPARATE** Game-economy vs NFT-utility (different value drivers: playable
  game vs NFT collection) — do *not* collapse into one "utility" mega-bucket; that
  would hide the single most interesting finding (the game economy).
- **DROP** RWA as a top-level bucket → fold into NFT. RWA is essentially absent:
  the only genuine tokenized-real-asset collections are FarmGPU 4090 (26 offers)
  and "One-off real world asset issuance" (1 offer). Keep an "RWA: negligible"
  footnote rather than a chart slice. (Gold/Golden/Miner* collections are art
  themes, not tokenized commodities.)

---

## Edge cases & ambiguous tokens (honest uncertainty)

- **HOA (16,764) / C2R (17,279)** — high-volume but slippery. HOA "spread awareness
  of HOA COIN" reads as a pure memecoin; C2R "CAT 2 RESERVE TOKEN… improve CAT2
  trading… purchase offers opened" is a market-making/reserve gimmick. Both → Memecoin
  (best fit), but flag: their volume is large enough that a misclass moves the chart
  a percentage point.
- **NIOC / NIOG (NioCoin/NioGold, ~17k combined)** — "Proof of Time & Luck consensus…
  airdrops." Reads as a protocol/mining-experiment token, placed in Protocol, but
  could be argued as memecoin. Borderline.
- **BYC (Bytecash, 20,325)** — placed in **Stablecoin** (it's a dollar-pegged CDP
  unit) but it's *also* a DeFi protocol token. Pegged-unit function wins.
- **CRT (3,586), ASON (1,653), KALI (1,411), ALExp (1,192)** — no description.
  CRT=Circuit (DeFi, classifiable externally), ALExp=Abandoned Land (game, by code
  family). ASON/KALI genuinely unknown → Unclassified.
- **Tang Bears art tokens (GOLD/NINJA/ACID, ~3.4k)** share boilerplate "Tang Bears
  by Alfonso" descriptions — could be Social or NFT-utility; placed in Social as
  part of the TangGang economy. Low-confidence.
- **TIBET-* with zero description (4.77% of CAT activity)** — *not* Unclassified:
  the `TIBET-` code prefix is a deterministic LP classifier. Important so the LP
  bucket isn't lost to the no-desc tail.

## Unclassified estimate

No-description CATs are **7.2%** of CAT offer activity, but **4.77pp of that is LP
tokens** (code-classifiable) and a further chunk is code-family-classifiable
(ALExp→game, CRT→protocol). The **truly unclassifiable** non-LP, non-recoverable
no-desc tail is **~2.4% of CAT offer activity**. Scaled against *all* offers, and
adding a small allowance for genuinely ambiguous described tokens we'd punt on,
**Unclassified ≈ 2–3% of all 833,145 offers.** Small, as desired. (Pure-NFT-only
offers — no CAT, no XCH — are 9,489; those go to NFT, not Unclassified.)

---

## What changed from the seed list

1. **Added** *NFT-project utility token* (accepted candidate, ~5.2%).
2. **Added** *Social / community token* (accepted candidate, ~2%, borderline-keep).
3. **Renamed** "Game token" → **Game-economy token**; confirmed it's the **largest**
   CAT bucket (~17.9%), not a minor one.
4. **Merged** "Governance / platform" into a broader **Protocol / platform / infra**
   bucket that also absorbs the DeFi-token candidate.
5. **Rejected** the *commemorative/airdrop* candidate (it's an origin, not a
   function; cross-cuts other buckets).
6. **Rejected** the *memecoin-vs-currency* split (no real non-meme currency exists;
   pegged units already live in Stablecoin).
7. **Dropped** RWA as a top-level bucket → folded into NFT (essentially zero volume:
   27 offers total). Keep as a footnote.
8. Stablecoin/LP confirmed as-is (LP classified by `TIBET-` prefix, not description).

**Net:** seed's 5 CAT + 2 NFT + Unclassified → final **7 CAT + 1 NFT + Unclassified
= 9 reader-facing buckets**.
