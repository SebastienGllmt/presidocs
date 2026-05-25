-- ============================================================================
-- T2 — NFTs as a first-class use case for Chia offer files. Full lifecycle.
-- Run read-only against the prebuilt substrate (does not lock other agents):
--   ./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/02-nft.sql"
-- Collection metadata lives in a separate JSONL pass: 02-nft-collections.sql.
--
-- Conventions (per recon / dataset doc):
--   * NFT legs identified by legs.is_nft (≈99.8% carry collection metadata).
--   * Prices: price = requested.amount/offered.amount. For NFT->XCH single-pair
--     the NFT amount is 1, so price == XCH paid for the NFT. Use MEDIAN, trim junk.
--   * Coverage 84.7%, biased to dropping the OLDEST offers of the BUSIEST
--     fungible pairs. NFT->XCH (225k) is NOT pair-capped (each NFT is its own
--     asset_id, max 235 trades/NFT) so NFT counts/prices are reliable; the XCH/USD
--     FX series IS built from capped stablecoin pairs (floor on volume, fine for median).
-- ============================================================================

.print '== Q0: NFT involvement (verify recon 38.1%) =='
WITH nft_offers AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft)
SELECT (SELECT count(*) FROM offers) AS total_offers,
       (SELECT count(*) FROM nft_offers) AS nft_offers,
       round(100.0*(SELECT count(*) FROM nft_offers)/(SELECT count(*) FROM offers),2) AS nft_pct,
       (SELECT count(DISTINCT asset_id) FROM legs WHERE is_nft) AS distinct_nft_assets,
       (SELECT max(c) FROM (SELECT count(DISTINCT offer_id) c FROM legs WHERE is_nft GROUP BY asset_id)) AS max_trades_per_nft;

-- ============================================================
-- Q1: NFT trading over time — count & share by month (the 2022 boom + decline)
-- ============================================================
.print '== Q1: NFT offers and share by month =='
WITH nft_offers AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft)
SELECT strftime(date_completed,'%Y-%m') AS month,
       count(*) AS total_offers,
       count(*) FILTER (WHERE id IN (SELECT offer_id FROM nft_offers)) AS nft_offers,
       round(100.0*count(*) FILTER (WHERE id IN (SELECT offer_id FROM nft_offers))/count(*),1) AS nft_pct
FROM offers GROUP BY 1 ORDER BY 1;

-- ============================================================
-- Q2: NFT trade STRUCTURE — barter vs sold-for-fungible, and direction
-- ============================================================
.print '== Q2a: NFT trade structure (all NFT-involving offers) =='
WITH nft_offers AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft),
agg AS (
  SELECT l.offer_id,
    count(*) FILTER (WHERE l.is_nft AND l.side='offered')   AS nft_off,
    count(*) FILTER (WHERE l.is_nft AND l.side='requested') AS nft_req
  FROM legs l WHERE l.offer_id IN (SELECT offer_id FROM nft_offers) GROUP BY 1
)
SELECT CASE WHEN nft_off>0 AND nft_req>0 THEN 'NFT<->NFT barter'
            ELSE 'NFT<->fungible' END AS structure,
       count(*) AS offers
FROM agg GROUP BY 1 ORDER BY 2 DESC;

.print '== Q2b: fungible counterpart of single-pair NFT trades (top 20) =='
WITH sp AS (SELECT id FROM offers WHERE is_single_pair),
nft_sp AS (
  SELECT l.offer_id,
    max(CASE WHEN l.is_nft THEN l.side END) AS nft_side,
    max(CASE WHEN NOT l.is_nft THEN coalesce(l.code,l.asset_id) END) AS other_code
  FROM legs l JOIN sp ON sp.id=l.offer_id
  GROUP BY 1
  HAVING count(*) FILTER (WHERE is_nft)=1 AND count(*) FILTER (WHERE NOT is_nft)=1
)
SELECT other_code,
       count(*) AS offers,
       count(*) FILTER (WHERE nft_side='offered')   AS nft_sold_for_other,
       count(*) FILTER (WHERE nft_side='requested') AS nft_bought_with_other
FROM nft_sp GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

.print '== Q2c: NFT<->NFT barter — single-pair vs multi-leg =='
WITH nft_offers AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft),
agg AS (
  SELECT l.offer_id, o.is_single_pair,
    count(*) FILTER (WHERE l.is_nft AND l.side='offered')   AS nft_off,
    count(*) FILTER (WHERE l.is_nft AND l.side='requested') AS nft_req
  FROM legs l JOIN offers o ON o.id=l.offer_id
  WHERE l.offer_id IN (SELECT offer_id FROM nft_offers) GROUP BY 1,2
)
SELECT is_single_pair, count(*) AS barter_offers
FROM agg WHERE nft_off>0 AND nft_req>0 GROUP BY 1 ORDER BY 1;

-- ============================================================
-- Q3: NFT sale PRICE in XCH over time (single-pair NFT->XCH; the "floor" story)
--     med_xch = median XCH paid; combined with derived XCH/USD -> median USD.
-- ============================================================
.print '== Q3: NFT median sale price in XCH and USD by month =='
WITH nftxch AS (
  SELECT o.date_completed, o.price
  FROM offers o
  WHERE o.is_single_pair
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.side='offered' AND l.is_nft)
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.side='requested' AND l.asset_id='xch')
    AND o.price BETWEEN 0.005 AND 1000          -- trim junk/spam offers
),
nft_m AS (SELECT strftime(date_completed,'%Y-%m') mon, count(*) n,
                 median(price) med_xch,
                 quantile_cont(price,0.25) q25, quantile_cont(price,0.75) q75
          FROM nftxch GROUP BY 1),
-- Derived XCH/USD from single-pair XCH<->stablecoin offers, normalized to USD/XCH.
sp AS (
  SELECT o.date_completed, o.price,
    max(CASE WHEN l.asset_id='xch' THEN l.side END) AS xch_side,
    max(CASE WHEN l.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT') THEN l.side END) AS usd_side
  FROM offers o JOIN legs l ON l.offer_id=o.id WHERE o.is_single_pair
  GROUP BY 1,2 HAVING xch_side IS NOT NULL AND usd_side IS NOT NULL
),
fx AS (
  SELECT strftime(date_completed,'%Y-%m') mon,
         median(CASE WHEN xch_side='offered' THEN price ELSE 1.0/price END) usd_per_xch
  FROM sp WHERE price>0
    AND (CASE WHEN xch_side='offered' THEN price ELSE 1.0/price END) BETWEEN 0.1 AND 200
  GROUP BY 1)
SELECT nft_m.mon, nft_m.n,
       round(nft_m.med_xch,3) AS med_xch,
       round(nft_m.q25,3) AS q25_xch, round(nft_m.q75,3) AS q75_xch,
       round(fx.usd_per_xch,2) AS usd_per_xch,
       round(nft_m.med_xch*fx.usd_per_xch,2) AS med_usd
FROM nft_m JOIN fx USING(mon) ORDER BY mon;

-- ============================================================
-- Q4: game/meme token economy that trades NFTs (G4M cluster etc.)
-- ============================================================
.print '== Q4: NFT<->non-XCH fungible (game/meme token NFT trade, single-pair, top 15) =='
WITH sp AS (SELECT id FROM offers WHERE is_single_pair),
nft_sp AS (
  SELECT l.offer_id,
    max(CASE WHEN l.is_nft THEN l.side END) AS nft_side,
    max(CASE WHEN NOT l.is_nft THEN l.asset_id END) AS other_id,
    max(CASE WHEN NOT l.is_nft THEN coalesce(l.code,'(no code)') END) AS other_code
  FROM legs l JOIN sp ON sp.id=l.offer_id GROUP BY 1
  HAVING count(*) FILTER (WHERE is_nft)=1 AND count(*) FILTER (WHERE NOT is_nft)=1
)
SELECT other_code, count(*) offers
FROM nft_sp WHERE other_id<>'xch' GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

-- ============================================================
-- Q5: write long monthly NFT series to CSV (>30 rows)
-- ============================================================
.print '== Q5: writing monthly NFT count/share CSV =='
COPY (
  WITH nft_offers AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft)
  SELECT strftime(date_completed,'%Y-%m') AS month,
         count(*) AS total_offers,
         count(*) FILTER (WHERE id IN (SELECT offer_id FROM nft_offers)) AS nft_offers,
         round(100.0*count(*) FILTER (WHERE id IN (SELECT offer_id FROM nft_offers))/count(*),1) AS nft_pct
  FROM offers GROUP BY 1 ORDER BY 1
) TO 'research/dexie-offers/findings/data/02-nft-monthly-share.csv' (HEADER, DELIMITER ',');

.print '== Q5b: writing monthly NFT price (XCH + USD) CSV =='
COPY (
  WITH nftxch AS (
    SELECT o.date_completed, o.price FROM offers o
    WHERE o.is_single_pair
      AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.side='offered' AND l.is_nft)
      AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.side='requested' AND l.asset_id='xch')
      AND o.price BETWEEN 0.005 AND 1000),
  nft_m AS (SELECT strftime(date_completed,'%Y-%m') mon, count(*) n, median(price) med_xch,
                   quantile_cont(price,0.25) q25, quantile_cont(price,0.75) q75 FROM nftxch GROUP BY 1),
  sp AS (SELECT o.date_completed, o.price,
           max(CASE WHEN l.asset_id='xch' THEN l.side END) xch_side,
           max(CASE WHEN l.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT') THEN l.side END) usd_side
         FROM offers o JOIN legs l ON l.offer_id=o.id WHERE o.is_single_pair
         GROUP BY 1,2 HAVING xch_side IS NOT NULL AND usd_side IS NOT NULL),
  fx AS (SELECT strftime(date_completed,'%Y-%m') mon,
           median(CASE WHEN xch_side='offered' THEN price ELSE 1.0/price END) usd_per_xch
         FROM sp WHERE price>0 AND (CASE WHEN xch_side='offered' THEN price ELSE 1.0/price END) BETWEEN 0.1 AND 200
         GROUP BY 1)
  SELECT nft_m.mon AS month, nft_m.n AS n_sales,
         round(nft_m.med_xch,3) AS med_xch, round(nft_m.q25,3) q25_xch, round(nft_m.q75,3) q75_xch,
         round(fx.usd_per_xch,2) AS usd_per_xch, round(nft_m.med_xch*fx.usd_per_xch,2) AS med_usd
  FROM nft_m JOIN fx USING(mon) ORDER BY mon
) TO 'research/dexie-offers/findings/data/02-nft-price-monthly.csv' (HEADER, DELIMITER ',');
.print 'done.'
