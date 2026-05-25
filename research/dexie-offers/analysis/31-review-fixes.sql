-- Review-pass fixes & additions (research/dexie-offers/findings/30-review.md).
-- (B1) NFT USD line: recompute with WARP-ONLY FX (USDSC/depegged excluded), null
--      before warp coins exist (2024-05) — fixes the contaminated chart-nft-price.
-- (B2/B3) total volume, USD volume (warp era), trade-size + depth figures.

-- warp.green XCH/USD per month (the trusted oracle, matching T3)
CREATE OR REPLACE TEMP TABLE fx AS
WITH sp AS (SELECT id, date_completed FROM offers WHERE is_single_pair),
o AS (SELECT offer_id, code c, amount FROM legs WHERE side='offered'),
r AS (SELECT offer_id, code c, amount FROM legs WHERE side='requested'),
u AS (SELECT sp.date_completed dc,
        CASE WHEN o.c='XCH' THEN r.amount/o.amount ELSE o.amount/r.amount END AS xu
      FROM sp JOIN o ON o.offer_id=sp.id JOIN r ON r.offer_id=sp.id
      WHERE (o.c='XCH' AND r.c IN ('wUSDC.b','wUSDC','wUSDT'))
         OR (r.c='XCH' AND o.c IN ('wUSDC.b','wUSDC','wUSDT')))
SELECT strftime(dc,'%Y-%m') AS m, median(xu) AS xch_usd
FROM u WHERE xu BETWEEN 0.01 AND 100 GROUP BY 1;

-- (B1) rebuild NFT price monthly: med XCH (pure, unaffected) + warp-only USD
COPY (
  WITH nft AS (
    SELECT strftime(o.date_completed,'%Y-%m') AS month, x.amount AS xch
    FROM offers o JOIN nft_meta nm ON nm.offer_id=o.id AND nm.side='offered'
    JOIN legs x ON x.offer_id=o.id AND x.side='requested' AND x.asset_id='xch'
    WHERE o.is_single_pair AND x.amount BETWEEN 0.005 AND 1000),
  m AS (SELECT month, count(*) n_sales, median(xch) med_xch FROM nft GROUP BY 1)
  SELECT m.month, m.n_sales, round(m.med_xch,3) AS med_xch,
    round(fx.xch_usd,3) AS usd_per_xch,
    CASE WHEN fx.xch_usd IS NULL THEN NULL ELSE round(m.med_xch*fx.xch_usd,3) END AS med_usd
  FROM m LEFT JOIN fx ON fx.m=m.month ORDER BY m.month
) TO 'research/dexie-offers/findings/data/02-nft-price-monthly.csv' (HEADER, DELIMITER ',');

-- (B2) volume: total XCH changed hands; warp-era USD value of XCH volume
SELECT 'total_xch_volume_alltime' k, round(sum(amount),0) v FROM legs WHERE asset_id='xch'
UNION ALL
SELECT 'usd_volume_warp_era_millions',
  round((SELECT sum(mv.xchvol*fx.xch_usd) FROM
    (SELECT strftime(date_completed,'%Y-%m') m, sum(amount) xchvol FROM legs WHERE asset_id='xch' GROUP BY 1) mv
    JOIN fx ON fx.m=mv.m)/1e6,1);

-- (B2) trade-size distribution (XCH leg) + USD via stablecoin legs
SELECT 'xch_trade_p50' k, round(quantile_cont(amount,0.5),3) v FROM legs WHERE asset_id='xch'
UNION ALL SELECT 'xch_trade_p99', round(quantile_cont(amount,0.99),2) FROM legs WHERE asset_id='xch'
UNION ALL SELECT 'xch_trade_p999', round(quantile_cont(amount,0.999),1) FROM legs WHERE asset_id='xch'
UNION ALL SELECT 'xch_trade_max', round(max(amount),0) FROM legs WHERE asset_id='xch';
