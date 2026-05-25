-- How much settlement volume flows through dexie's aggregator (Combined Swap)?
-- `mempool_combined IS TRUE` marks a settlement that combined multiple liquidity
-- sources (combined offers + the TibetSwap AMM) — i.e. a routed Combined Swap.
-- Run: ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/17-aggregator.sql
COPY (
  SELECT strftime(date_completed,'%Y-%m') AS month,
         count(*) AS offers,
         round(100.0*avg((mempool_combined IS TRUE)::int),1) AS pct_combined
  FROM offers GROUP BY 1 ORDER BY 1
) TO 'research/dexie-offers/findings/data/17-aggregator-by-month.csv' (HEADER, DELIMITER ',');
