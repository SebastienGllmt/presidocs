-- Value the DBX liquidity rewards in XCH and USD, per month, using prices
-- reconstructed from offer flow: DBX→XCH (median XCH/DBX on single-pair DBX↔XCH
-- offers) and XCH→USD (the price oracle, warp.green stablecoins). Avoids pinning a
-- single current DBX price. Window = claims coverage (2025-08 → 2026-05).
-- Run: ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/22-reward-value.sql
COPY (
  WITH sp AS (SELECT id, date_completed FROM offers WHERE is_single_pair),
  xleg AS (SELECT offer_id, amount FROM legs WHERE asset_id='xch'),
  dleg AS (SELECT offer_id, amount FROM legs WHERE code='DBX'),
  sleg AS (SELECT offer_id, amount FROM legs WHERE code IN ('wUSDC.b','wUSDC','wUSDT')),
  dbx_m AS (SELECT strftime(sp.date_completed,'%Y-%m') mo, median(x.amount/d.amount) xch_per_dbx
    FROM sp JOIN xleg x ON x.offer_id=sp.id JOIN dleg d ON d.offer_id=sp.id
    WHERE x.amount/d.amount BETWEEN 0.0001 AND 1 GROUP BY 1),
  usd_m AS (SELECT strftime(sp.date_completed,'%Y-%m') mo, median(s.amount/x.amount) usd_per_xch
    FROM sp JOIN xleg x ON x.offer_id=sp.id JOIN sleg s ON s.offer_id=sp.id
    WHERE s.amount/x.amount BETWEEN 0.01 AND 100 GROUP BY 1),
  rew AS (SELECT strftime(date_claimed,'%Y-%m') mo, sum(claimed_amount) dbx FROM reward_claims GROUP BY 1)
  SELECT r.mo, round(r.dbx,0) AS dbx_claimed,
    round(d.xch_per_dbx,5) AS xch_per_dbx, round(u.usd_per_xch,2) AS usd_per_xch,
    round(r.dbx*d.xch_per_dbx,0) AS xch_value,
    round(r.dbx*d.xch_per_dbx*u.usd_per_xch,0) AS usd_value
  FROM rew r LEFT JOIN dbx_m d USING(mo) LEFT JOIN usd_m u USING(mo) ORDER BY r.mo
) TO 'research/dexie-offers/findings/data/22-reward-value.csv' (HEADER, DELIMITER ',');
