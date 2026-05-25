-- "What a trade actually costs": the three fee streams an offer can pay, in XCH.
-- (3) Blockchain/network fee = MEASURED (offers.fees).
-- (1) dexie service fee      = ESTIMATED 1% of the XCH amount on Combined Swaps
--      (mempool_combined IS TRUE) — dexie's documented 1%-on-XCH Combined Swap fee.
-- (2) NFT creator royalty    = ESTIMATED royalty_bps x XCH paid, single-pair NFT→XCH
--      sales (assumes the royalty is paid — O2 shows it largely is; a floor since it
--      excludes NFT bundles / NFT-for-CAT sales).
-- Run: ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/20-fees.sql
COPY (
  WITH xchleg AS (SELECT offer_id, sum(amount) AS xch_amt FROM legs WHERE asset_id='xch' GROUP BY 1),
  nft_sales AS (
    SELECT nm.royalty_bps, x.amount AS xch
    FROM offers o
    JOIN nft_meta nm ON nm.offer_id=o.id AND nm.side='offered'
    JOIN legs x ON x.offer_id=o.id AND x.side='requested' AND x.asset_id='xch'
    WHERE o.is_single_pair)
  SELECT 'NFT creator royalty' AS fee_type,
         round((SELECT sum(royalty_bps/10000.0*xch) FROM nft_sales),0) AS total_xch, 'estimated' AS kind
  UNION ALL SELECT 'dexie service fee (1% Combined Swap)',
         round((SELECT sum(0.01*x.xch_amt) FROM offers o JOIN xchleg x ON x.offer_id=o.id WHERE o.mempool_combined IS TRUE),0), 'estimated'
  UNION ALL SELECT 'Blockchain (network) fee',
         round((SELECT sum(fees) FROM offers),0), 'measured'
  ORDER BY total_xch DESC
) TO 'research/dexie-offers/findings/data/20-fee-streams.csv' (HEADER, DELIMITER ',');
