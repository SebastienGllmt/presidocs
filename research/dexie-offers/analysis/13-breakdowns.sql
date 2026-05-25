-- Round-3 drill-downs: "what's actually IN each bucket?" for the regrouped post.
-- Run: ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/13-breakdowns.sql
-- Exports the charted series to research/dexie-offers/findings/data/13-*.csv (read by make-charts.ts).

-- (1) "Other fungible CATs" — what's in the big 50.7% bucket (excl XCH, NFTs,
--     stablecoins, TibetSwap LP, the AL*/G4M game cluster, and the named memes).
COPY (
  WITH ex AS (
    SELECT offer_id, code, name FROM legs
    WHERE code IS NOT NULL AND NOT is_nft
      AND code NOT IN ('XCH','wUSDC.b','USDSC','wUSDC','wUSDT','BYC',
        'ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','G4M',
        'BEPE','GYATT','PUSSY')
      AND code NOT LIKE 'TIBET-%' AND code <> '🐈')
  SELECT code, any_value(name) AS name, count(DISTINCT offer_id) AS offers
  FROM ex GROUP BY code ORDER BY offers DESC LIMIT 20
) TO 'research/dexie-offers/findings/data/13-other-cats.csv' (HEADER, DELIMITER ',');

-- (2) Stablecoins — offers per code (for the pie). USDSC = old Stably USD; its peg
--     broke after custodian Prime Trust's 2023 insolvency (see 03-price-oracle.md).
COPY (
  WITH s AS (SELECT DISTINCT offer_id, code FROM legs
             WHERE code IN ('wUSDC.b','USDSC','wUSDC','wUSDT','BYC') OR code ILIKE 'TIBET-%USD%')
  SELECT CASE WHEN code LIKE 'TIBET-%' THEN 'TIBET LP (USD)' ELSE code END AS code,
         count(DISTINCT offer_id) AS offers
  FROM s GROUP BY 1 ORDER BY offers DESC
) TO 'research/dexie-offers/findings/data/13-stablecoins.csv' (HEADER, DELIMITER ',');

-- (3) RWAs — the curated real-estate + GPU collections actually traded.
COPY (
  SELECT collection_name, count(DISTINCT offer_id) AS offers,
         count(DISTINCT asset_id) AS distinct_nfts
  FROM nft_meta
  WHERE collection_name IN ('2405 Pollen Way','336 Sarava Ln','2428 Egret Dr',
    '621 Martha Ave','1050 44th Ave N','147 Coach Dr','421 Shelby St',
    '1527 White Bluff Rd','Pantheon 4090','FarmGPU 4090')
  GROUP BY 1 ORDER BY offers DESC
) TO 'research/dexie-offers/findings/data/13-rwas.csv' (HEADER, DELIMITER ',');

-- (4) NFT collections — top 12 by trade legs (for the bar).
COPY (
  SELECT collection_name, count(*) AS trade_legs, count(DISTINCT asset_id) AS distinct_nfts
  FROM nft_meta WHERE collection_name IS NOT NULL
  GROUP BY 1 ORDER BY trade_legs DESC LIMIT 12
) TO 'research/dexie-offers/findings/data/13-nft-collections.csv' (HEADER, DELIMITER ',');
