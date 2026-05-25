-- 04-concentration.sql  (Thesis T4: asset concentration + game/meme economies)
-- Run read-only so the other agents aren't locked:
--   ./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/04-concentration.sql"
-- Snapshot: 833,145 completed offers, 2022-01-14 .. 2026-05-23.
--
-- CAVEAT carried by every fungible-concentration number below: the dexie API
-- caps each (offered,requested,status) pair at the newest 10k records, which
-- truncates the BUSIEST fungible pairs (↔XCH, ↔stablecoins) on their OLDEST
-- tail. So measured trade counts/volumes for hot fungibles are FLOORS and
-- concentration *among fungibles* is UNDERSTATED (the hottest heads are clipped).
-- NFT assets are each their own per-pair slice, so the NFT universe count and
-- NFT→XCH counts are essentially uncapped.
--
-- Asset bucketing: key on asset_id, never code (20% of legs have no code, 99.6%
-- of those are NFTs). 'xch' is the native hub. is_nft flags NFTs.

-- =====================================================================
-- Q1. Asset universe sizes (how big is the long tail, structurally)
-- =====================================================================
SELECT
  count(DISTINCT asset_id)                                              AS distinct_assets_all,
  count(DISTINCT asset_id) FILTER (WHERE is_nft)                        AS distinct_nft,
  count(DISTINCT asset_id) FILTER (WHERE NOT is_nft AND asset_id<>'xch')AS distinct_fungible,
  count(DISTINCT asset_id) FILTER (WHERE code IS NOT NULL)              AS distinct_with_code
FROM legs;
-- -> 289,806 total | 288,945 NFT | 860 fungible CAT | 745 with a ticker

-- =====================================================================
-- Q2. Top-30 fungible (non-XCH, non-NFT) assets by distinct offers touched
-- =====================================================================
SELECT code, any_value(name) AS name, asset_id,
       count(DISTINCT offer_id) AS offers,
       count(*)                 AS leg_appearances
FROM legs
WHERE asset_id<>'xch' AND NOT is_nft
GROUP BY code, asset_id
ORDER BY offers DESC
LIMIT 30;
-- FBX 38,482 | ALWORK 31,601 | wUSDC.b 27,649 | SBX 22,671 | USDSC 20,923 ...
-- (FLOORS; busiest ↔XCH/stablecoin pairs clipped at 10k each)

-- =====================================================================
-- Q3. Concentration of fungible trading: top-N share + dead tail
-- =====================================================================
WITH fung AS (
  SELECT asset_id, count(DISTINCT offer_id) AS offers
  FROM legs WHERE asset_id<>'xch' AND NOT is_nft
  GROUP BY asset_id
),
tot AS (SELECT sum(offers) total, count(*) n FROM fung),
ranked AS (SELECT *, row_number() OVER (ORDER BY offers DESC) rnk FROM fung)
SELECT
  (SELECT n     FROM tot) AS distinct_fungible_assets,
  (SELECT total FROM tot) AS total_offer_appearances,
  (SELECT sum(offers) FROM ranked WHERE rnk<=10)::DOUBLE/(SELECT total FROM tot) AS top10_share,
  (SELECT sum(offers) FROM ranked WHERE rnk<=25)::DOUBLE/(SELECT total FROM tot) AS top25_share,
  (SELECT sum(offers) FROM ranked WHERE rnk<=50)::DOUBLE/(SELECT total FROM tot) AS top50_share,
  (SELECT count(*) FROM fung WHERE offers<=5) AS assets_le5_trades,
  (SELECT count(*) FROM fung WHERE offers=1)  AS assets_1_trade;
-- 860 assets | 814,291 appearances | top10 29.2% | top25 56.5% | top50 74.2%
-- | 176 assets traded <=5x | 84 traded exactly once.  Note: top-N share is a
-- LOWER bound — clipping the heads understates true concentration.

-- =====================================================================
-- Q4. Gini coefficient of fungible trade counts
-- =====================================================================
WITH fung AS (
  SELECT asset_id, count(DISTINCT offer_id) offers
  FROM legs WHERE asset_id<>'xch' AND NOT is_nft GROUP BY asset_id
),
o AS (SELECT offers, row_number() OVER (ORDER BY offers ASC) i FROM fung),
n AS (SELECT count(*) n, sum(offers) s FROM fung)
SELECT (2.0*sum(o.i*o.offers))/((SELECT n FROM n)*(SELECT s FROM n))
       - ((SELECT n FROM n)+1.0)/(SELECT n FROM n) AS gini
FROM o;
-- -> 0.891 (extreme inequality; a floor — head-clipping flattens it)

-- =====================================================================
-- Q5. Lorenz curve points (cumulative share of trades vs share of assets)
--     Exported to data/04-concentration-lorenz.csv
-- =====================================================================
WITH fung AS (SELECT asset_id, count(DISTINCT offer_id) offers FROM legs WHERE asset_id<>'xch' AND NOT is_nft GROUP BY asset_id),
r AS (SELECT offers, row_number() OVER (ORDER BY offers ASC) i, count(*) OVER () n, sum(offers) OVER () tot FROM fung),
c AS (SELECT i, 1.0*i/n frac_assets, sum(offers) OVER (ORDER BY i)::DOUBLE/tot cum_share FROM r)
SELECT round(frac_assets,2) AS asset_pct, round(min(cum_share),4) AS cum_trade_share
FROM c WHERE round(frac_assets,2) IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,0.95,1.00)
GROUP BY round(frac_assets,2) ORDER BY asset_pct;
-- bottom 80% of assets = 5.6% of trades; top 5% = 73% of trades.

-- =====================================================================
-- Q6. Category buckets — share of offers (an offer is counted in EVERY
--     category it touches, so columns overlap and do not sum to 100%).
-- =====================================================================
WITH cat AS (
  SELECT DISTINCT offer_id,
    CASE
      WHEN is_nft THEN 'NFT'
      WHEN asset_id='xch' THEN 'XCH'
      WHEN code IN ('wUSDC.b','USDSC','wUSDC','wUSDT','USDS','BYC') THEN 'stablecoin'
      WHEN code LIKE 'TIBET-%' THEN 'TIBET_LP'
      WHEN code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp','G4M') THEN 'game_cat'
      WHEN code IN ('🐈','BEPE','GYATT') THEN 'meme_cat'
      WHEN code IS NULL THEN 'unknown_nocode'
      ELSE 'other_cat'
    END AS bucket
  FROM legs
)
SELECT bucket, count(DISTINCT offer_id) offers,
       round(100.0*count(DISTINCT offer_id)/833145,2) AS pct_of_all_offers
FROM cat GROUP BY bucket ORDER BY offers DESC;
-- (BYC = Bytecash, a Chia-native CDP dollar stablecoin, counted as stablecoin.)
-- XCH 76.5% | other_cat 50.3% | NFT 38.1% | stablecoin 7.8% | game_cat 7.4%
-- | meme_cat 4.7% | TIBET_LP 4.5% | unknown_nocode 0.2%

-- =====================================================================
-- Q7. Category mix over time (offers per month per bucket; deduped per offer)
--     Exported to data/04-concentration-category-by-month.csv
-- =====================================================================
WITH cat AS (
  SELECT DISTINCT offer_id, strftime(date_completed,'%Y-%m') AS month,
    CASE
      WHEN is_nft THEN 'NFT'
      WHEN asset_id='xch' THEN 'XCH'
      WHEN code IN ('wUSDC.b','USDSC','wUSDC','wUSDT','USDS','BYC') THEN 'stablecoin'
      WHEN code LIKE 'TIBET-%' THEN 'TIBET_LP'
      WHEN code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp','G4M') THEN 'game_cat'
      WHEN code IN ('🐈','BEPE','GYATT') THEN 'meme_cat'
      WHEN code IS NULL THEN 'unknown_nocode'
      ELSE 'other_cat'
    END AS bucket
  FROM legs
)
SELECT month, bucket, count(DISTINCT offer_id) offers
FROM cat GROUP BY month, bucket ORDER BY month, bucket;

-- =====================================================================
-- Q8. GAME ECONOMY — what the Abandoned Land (AL*) + go4me (G4M) cluster
--     trades against. 'self' = within the same game-cat cluster.
-- =====================================================================
WITH game AS (
  SELECT DISTINCT offer_id FROM legs
  WHERE code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp','G4M','TIBET-G4M-XCH')
),
counter AS (
  SELECT l.offer_id,
    CASE WHEN l.asset_id='xch' THEN 'XCH'
         WHEN l.code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp') THEN 'AbandonedLand_resource'
         WHEN l.code IN ('G4M','TIBET-G4M-XCH') THEN 'go4me'
         WHEN l.is_nft THEN 'NFT'
         WHEN l.code LIKE 'TIBET-AL%' THEN 'AbandonedLand_LP'
         ELSE coalesce(l.code,'other_cat') END AS bucket
  FROM legs l JOIN game g USING(offer_id)
)
SELECT bucket, count(*) leg_appearances, count(DISTINCT offer_id) offers
FROM counter GROUP BY bucket ORDER BY leg_appearances DESC LIMIT 20;
-- AbandonedLand_resource 394,843 legs / 47,418 offers (mostly self-trading) |
-- NFT 26,031 | go4me 26,579 | XCH only 8,564. -> self-contained in-game economy.

-- =====================================================================
-- Q9. Identify the games via legs.name (proof these are real projects)
-- =====================================================================
SELECT DISTINCT code, name FROM legs
WHERE code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp','G4M','TIBET-G4M-XCH')
ORDER BY code;
-- ALxxx -> "Abandoned Land - Work/Tool/Wood/Food/Ore/Gold/Weapon"; G4M -> "go4me"

-- =====================================================================
-- Q10. Game economy timeline (monthly offers; two non-overlapping bursts)
--      Exported to data/04-concentration-game-timeline.csv
-- =====================================================================
WITH al AS (SELECT DISTINCT offer_id FROM legs WHERE code IN ('ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp')),
g  AS (SELECT DISTINCT offer_id FROM legs WHERE code IN ('G4M','TIBET-G4M-XCH')),
fv AS (SELECT DISTINCT offer_id FROM legs WHERE code IN
  ('FBX','FHW','THW','XFUEL','XHAY','XSEED','XCOW','XPIG','XSHEP','XCHIN','XMILK','XMEAT','XWOOL','XEGG'))
SELECT strftime(date_completed,'%Y-%m') AS month,
  count(DISTINCT CASE WHEN o.id IN (SELECT offer_id FROM fv) THEN o.id END) AS farmerverse_offers,
  count(DISTINCT CASE WHEN o.id IN (SELECT offer_id FROM al) THEN o.id END) AS abandoned_land_offers,
  count(DISTINCT CASE WHEN o.id IN (SELECT offer_id FROM g)  THEN o.id END) AS go4me_offers
FROM offers o
WHERE o.id IN (SELECT offer_id FROM al UNION SELECT offer_id FROM g UNION SELECT offer_id FROM fv)
GROUP BY month ORDER BY month;
-- Abandoned Land: peak 2022-10..2023-04 (~7k/mo), long decline. go4me: born
-- 2025-08, peak 2025-09 (11,390), dead by 2026. Both burst-then-die.

-- =====================================================================
-- Q11. Asset lifecycle — span (last_trade - first_trade) per fungible asset
--      Exported to data/04-concentration-lifecycle.csv (the bucket table)
-- =====================================================================
WITH fung AS (
  SELECT asset_id, count(DISTINCT offer_id) offers,
    date_diff('day', min(date_completed), max(date_completed)) AS span_days
  FROM legs WHERE asset_id<>'xch' AND NOT is_nft GROUP BY asset_id
)
SELECT
  CASE WHEN span_days=0 THEN '0_single_day'
       WHEN span_days<=7  THEN '1-7d'
       WHEN span_days<=30 THEN '8-30d'
       WHEN span_days<=90 THEN '31-90d'
       WHEN span_days<=365 THEN '91-365d'
       ELSE '>365d' END AS lifespan_bucket,
  count(*) AS n_assets, median(offers) AS median_offers
FROM fung GROUP BY 1 ORDER BY min(span_days);
-- median fungible span = 322 d; median 50.5 offers. 403 assets live >365d
-- (the survivors), but 188 assets (<=30d span) burst then die.
