# Token taxonomy (working draft)

Goal: classify every traded asset into a category so the "what gets traded" chart
shows meaningful buckets + a small honest **Unclassified** remainder (instead of a
50% "Other" catch-all). Classification is **description-driven**, not name-guessed:
CAT descriptions live in `token_meta` (from `crawl-assets.ts`; 93% of CAT offer
activity has a description). NFT categories are collection-driven (`nft_meta`).

## Process
1. **Seed categories** (below) — the starting list.
2. **Sub-agent gap-analysis** — review the asset descriptions and propose any
   *additional* categories we're missing, plus renames/splits/merges → final list.
3. **Mapping file** — once categories are final, build a committed
   `asset → category` mapping (CATs keyed by `code`/`id` from descriptions; NFTs
   keyed by collection). The chart + queries read this mapping.

## Seed categories (v0 — to be refined by the sub-agent)

CAT-side (classified from `token_meta.description`):
- **Stablecoin** — USD-pegged units. e.g. wUSDC.b, wUSDC, wUSDT (warp.green
  bridged), BYC (Chia-native CDP). (USDSC = depegged, still a stablecoin.)
- **LP token** — AMM liquidity-pool receipts. e.g. TIBET-*.
- **Game token** — in-game currencies/resources/utility. e.g. FarmerVerse
  (FBX, FHW, THW, XFUEL, X-animals/resources), Abandoned Land (AL*), go4me (G4M),
  Chia Monster Tower (CMTG), Marmots.io (MIO).
- **Memecoin** — joke/meme/community-hype tokens. e.g. PEPE, WARP, Spacebucks,
  Moonbucks, MoJo, SPROUT, $CHIA.
- **Governance / platform** — protocol governance/utility. e.g. DBX (dexie).

NFT-side (classified from `nft_meta` collection):
- **NFT** — generic NFTs (PFP sets, art, game NFTs).
- **RWA** — tokenized real-world assets (real estate, GPUs). Subset of NFT.

Remainder:
- **Unclassified** — no description / genuinely unclear / the tiny long tail.

## Candidate additional categories (hypotheses for the sub-agent to confirm/reject)
- NFT-project utility tokens (e.g. Monkeyzoo, SpaceRatZ/CheeZe, NeckLords/NeckCoin)
- DeFi / protocol tokens (e.g. Inception Liquidity)
- Social / community tokens (e.g. TangGang: PP, MINUTES, LOVE)
- Commemorative / airdrop tokens (e.g. Chia Holiday 2021)
- "Currency" / general-purpose money (vs memecoin — may not be worth splitting)

_Sub-agent review output → `research/dexie-offers/findings/14-token-taxonomy-review.md`._

## FINAL categories (locked 2026-05-24)

After the gap-analysis review + author decisions. **10 reader-facing buckets.**

CAT-side (classified from `token_meta.description`):
1. **Stablecoin** — USD-pegged/formerly-pegged units (warp.green bridges, BYC, USDSC).
2. **Game-economy token** — in-game currency/resource/utility for a playable game
   (FarmerVerse, Abandoned Land, go4me, Chia Monster Tower, Marmots.io). *Largest CAT bucket (~18%).*
3. **NFT-project utility token** — CAT tied to a specific NFT collection (Monkeyzoo, SpaceRatZ/CheeZe…).
4. **Memecoin** — joke/hype/"fun-not-utility" tokens (PEPE, WARP, Spacebucks, Moonbucks, MoJo…). *~19%.*
5. **Social / community token** — Discord/community participation currency (chiefly TangGang: PP, MINUTES, LOVE).
6. **Protocol / platform / infra** — governance + DeFi + on-chain-service tokens (dexie DBX, Inception Liquidity…).
7. **LP token** — TibetSwap AMM liquidity receipts (`TIBET-` prefix; no description).

NFT-side (collection-driven, from `nft_meta`):
8. **RWA** — tokenized real-world assets (real estate, GPUs). Kept separate (small, ~0.3%, but distinct).
9. **NFT** — generic NFTs (PFP/art/game/collectibles).

Remainder:
10. **Unclassified** — no description and not code/collection-classifiable (~2–3% of offers).

Decisions vs the gap-analysis: **kept RWA separate** (agent undercounted it — the real-estate
collections live in `nft_meta`, ~2,540 offers, not just the 27 GPU offers it saw); **kept
Social/community separate** (not merged into Memecoin).

→ Next: build the committed `asset → category` mapping (`research/dexie-offers/findings/asset-categories.csv`).
