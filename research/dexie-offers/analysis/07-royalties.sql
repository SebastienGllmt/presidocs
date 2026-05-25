-- ============================================================================
-- 07-royalties.sql — Thesis O2: Do Chia NFT creators actually get their royalties?
-- Read-only against generated/offers.duckdb. Every number in research/dexie-offers/findings/
-- 07-royalties.md traces to a query here. Run:
--   ./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/07-royalties.sql"
-- nft_meta: one row per NFT leg (360,302). royalty_bps in basis points (500=5%).
-- 100% of NFT legs carry royalty_bps (verified Q-COV). creator_id is a DID where
-- creator_is_did. coins = exploded involved_coins (single-use UTXO ids).
-- COVERAGE CAVEAT: dataset is 84.7% of global, biased to dropping the OLDEST
-- offers of the BUSIEST FUNGIBLE pairs. NFT legs are NOT pair-capped (each NFT is
-- its own asset_id), so royalty counts/medians are reliable; only the (already
-- not-used-here) FX series would be cap-exposed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Q-SCOPE — dataset scope for this thesis
-- ---------------------------------------------------------------------------
SELECT 'Q-SCOPE' q, count(*) nft_legs, count(distinct offer_id) distinct_offers,
       count(distinct asset_id) distinct_nfts, count(distinct collection_id) distinct_colls,
       count(distinct creator_id) distinct_creators
FROM nft_meta;

-- Q-COV — every NFT leg carries a royalty_bps + creator (no nulls)
SELECT 'Q-COV' q, count(*) total, count(royalty_bps) royalty_nn,
       count(creator_id) creator_nn, count(mint_height) mint_nn, count(collection_id) coll_nn
FROM nft_meta;

-- ===========================================================================
-- DIRECTION 1 — ROYALTIES AS SET
-- ===========================================================================

-- Q1a — royalty_bps distribution (trade-leg-weighted), top buckets
SELECT 'Q1a' q, royalty_bps, count(*) legs,
       round(100.0*count(*)/sum(count(*)) over (),2) pct_legs,
       count(distinct asset_id) nfts, count(distinct collection_id) colls
FROM nft_meta GROUP BY royalty_bps ORDER BY legs DESC LIMIT 25;

-- Q1b — bucketed distribution (legs / distinct NFTs / collections)
SELECT 'Q1b' q,
  CASE WHEN royalty_bps=0 THEN '0%'
       WHEN royalty_bps<=500 THEN '0-5%'
       WHEN royalty_bps<=1000 THEN '5-10%'
       WHEN royalty_bps<=2000 THEN '10-20%'
       WHEN royalty_bps<=5000 THEN '20-50%'
       ELSE '>50%' END bucket,
  count(*) legs, count(distinct asset_id) nfts, count(distinct collection_id) colls
FROM nft_meta GROUP BY bucket ORDER BY min(royalty_bps);

-- Q1c — SET (per distinct NFT, one royalty per asset) vs PAID/trade-weighted (per leg)
WITH per_nft AS (SELECT asset_id, any_value(royalty_bps) roy FROM nft_meta GROUP BY 1)
SELECT 'Q1c' q, 'by_distinct_nft' lvl, median(roy) med_bps, round(avg(roy),1) mean_bps,
       round(100.0*sum(CASE WHEN roy=0 THEN 1 ELSE 0 END)/count(*),2) pct_zero FROM per_nft
UNION ALL
SELECT 'Q1c', 'by_trade_leg', median(royalty_bps), round(avg(royalty_bps),1),
       round(100.0*sum(CASE WHEN royalty_bps=0 THEN 1 ELSE 0 END)/count(*),2) FROM nft_meta;

-- Q1d — are the high-royalty buckets (33%, 50%, 99%) real collections or junk?
SELECT 'Q1d' q, royalty_bps, collection_name, count(*) legs, count(distinct asset_id) nfts
FROM nft_meta WHERE royalty_bps IN (3300,5000,9900)
GROUP BY royalty_bps, collection_name ORDER BY legs DESC LIMIT 15;

-- Q1e — royalty trend by settlement YEAR (trade-weighted): median climbs 5%->10%
SELECT 'Q1e' q, year(date_completed) yr, count(*) legs, median(royalty_bps) med_bps,
       round(avg(royalty_bps),1) mean_bps,
       round(100.0*sum(CASE WHEN royalty_bps=0 THEN 1 ELSE 0 END)/count(*),1) pct_zero
FROM nft_meta GROUP BY yr ORDER BY yr;

-- Q1f — monthly royalty series (->CSV, 48 rows)
COPY (
  SELECT strftime(date_completed,'%Y-%m') ym, count(*) legs,
         median(royalty_bps) med_bps, round(avg(royalty_bps),1) mean_bps,
         round(100.0*sum(CASE WHEN royalty_bps=0 THEN 1 ELSE 0 END)/count(*),2) pct_zero_royalty
  FROM nft_meta GROUP BY ym ORDER BY ym
) TO 'research/dexie-offers/findings/data/07-royalties-monthly.csv' (HEADER, DELIMITER ',');

-- ===========================================================================
-- DIRECTION 3 — WHO ARE THE CREATORS (placed before D2 since D2 is the deep one)
-- ===========================================================================

-- Q3a — DID vs non-DID creators
SELECT 'Q3a' q, creator_is_did, count(*) legs, count(distinct creator_id) creators,
       count(distinct collection_id) colls,
       round(100.0*count(*)/sum(count(*)) over (),2) pct_legs
FROM nft_meta GROUP BY creator_is_did;

-- Q3b — creator concentration (top-N share of trade legs)
WITH c AS (SELECT creator_id, count(*) legs FROM nft_meta GROUP BY 1)
SELECT 'Q3b' q, count(*) total_creators, sum(legs) total_legs,
  (SELECT sum(legs) FROM (SELECT legs FROM c ORDER BY legs DESC LIMIT 10))  top10_legs,
  (SELECT sum(legs) FROM (SELECT legs FROM c ORDER BY legs DESC LIMIT 25))  top25_legs,
  (SELECT sum(legs) FROM (SELECT legs FROM c ORDER BY legs DESC LIMIT 100)) top100_legs
FROM c;

-- Q3c — top creators
SELECT 'Q3c' q, creator_id, creator_is_did, count(*) legs,
       count(distinct collection_id) colls, count(distinct asset_id) nfts,
       median(royalty_bps) med_bps
FROM nft_meta GROUP BY creator_id, creator_is_did ORDER BY legs DESC LIMIT 12;

-- ===========================================================================
-- DIRECTION 2 — ROYALTIES AS PAID (inference from involved_coins)
-- The cleanest available on-chain proxy: a settled NFT->XCH sale that pays a
-- royalty must create an EXTRA output coin (the creator's royalty coin) beyond
-- the two counterparties. coins = exploded involved_coins. We compare the coin
-- count of NFT->XCH sales WITH nonzero royalty vs WITH zero royalty.
-- *** This is an INFERENCE: involved_coins is a partial, general coin list (it
-- also contains change/fee coins and is incomplete — 90% of zero-royalty sales
-- expose only 1 coin), NOT a decoded royalty output. We cannot prove the extra
-- coin IS the royalty without decoding the offer spend bundle. We quantify the
-- correlation and its dose-response with royalty_bps. ***
-- All NFT->XCH sales here are P2P (NFT legs are never AMM/tibet2 fills).
-- ===========================================================================

-- Q2a — coin-count comparison: nonzero-royalty vs zero-royalty single-pair NFT->XCH sales
WITH sales AS (
  SELECT m.offer_id, m.royalty_bps, m.price
  FROM nft_meta m JOIN offers o ON o.id=m.offer_id
  WHERE m.side='offered' AND o.is_single_pair
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=m.offer_id AND l.side='requested' AND l.asset_id='xch')
),
cc AS (SELECT offer_id, count(*) n_coins FROM coins GROUP BY 1)
SELECT 'Q2a' q, (royalty_bps>0) has_royalty, count(*) sales,
       round(avg(cc.n_coins),3) avg_coins, median(cc.n_coins) med_coins,
       round(100.0*sum(CASE WHEN cc.n_coins>=3 THEN 1 ELSE 0 END)/count(*),1) pct_3plus_coins,
       round(100.0*sum(CASE WHEN cc.n_coins=1 THEN 1 ELSE 0 END)/count(*),1) pct_1coin
FROM sales JOIN cc USING(offer_id) GROUP BY has_royalty ORDER BY has_royalty;

-- Q2b — DOSE-RESPONSE: extra-coin rate rises monotonically with royalty rate,
-- while median sale price stays flat (the extra coin tracks the RATE, not size)
WITH sales AS (
  SELECT m.offer_id, m.royalty_bps, m.price
  FROM nft_meta m JOIN offers o ON o.id=m.offer_id
  WHERE m.side='offered' AND o.is_single_pair
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=m.offer_id AND l.side='requested' AND l.asset_id='xch')
),
cc AS (SELECT offer_id, count(*) n_coins FROM coins GROUP BY 1)
SELECT 'Q2b' q,
  CASE WHEN royalty_bps=0 THEN '0%' WHEN royalty_bps<=300 THEN '1-3%'
       WHEN royalty_bps<=700 THEN '4-7%' WHEN royalty_bps<=1500 THEN '8-15%'
       ELSE '>15%' END royalty_bucket,
  count(*) sales, round(avg(cc.n_coins),2) avg_coins,
  round(100.0*sum(CASE WHEN cc.n_coins>=3 THEN 1 ELSE 0 END)/count(*),1) pct_3plus_coins,
  round(median(price),3) med_sale_xch
FROM sales JOIN cc USING(offer_id) GROUP BY royalty_bucket ORDER BY min(royalty_bps);

-- Q2c — AMM control: confirm NFT->XCH sales are essentially all P2P (no tibet2)
WITH sales AS (
  SELECT m.offer_id, coalesce(o.known_taker_source,'')='tibet2' is_amm
  FROM nft_meta m JOIN offers o ON o.id=m.offer_id
  WHERE m.side='offered' AND o.is_single_pair
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=m.offer_id AND l.side='requested' AND l.asset_id='xch')
)
SELECT 'Q2c' q, is_amm, count(*) sales FROM sales GROUP BY is_amm;
