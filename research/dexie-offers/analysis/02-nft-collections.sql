-- T2 (NFTs) — collection pass over the deduped JSONL.
-- The DuckDB substrate dropped NFT collection nesting to stay small; this is the
-- ONE allowed pass over generated/dexie-offers-dedup.jsonl to recover
-- offered[].collection / requested[].collection (and is_nft).
--
-- Run: ./tools/duckdb -c ".read research/dexie-offers/analysis/02-nft-collections.sql"
--   (no DB file needed; reads the JSONL directly, ~10s)
--
-- Strategy: project only id, date_completed, price, is_single_pair-ish info, and
-- the NFT legs' collection {id,name}. For NFT<->XCH single-pair sales we attach
-- the requested XCH amount so we can rank collections by XCH volume.

-- Collection STRUCT carries id + name (+ blocked/suspicious flags we keep for QA).
CREATE OR REPLACE TEMP MACRO coll_t() AS
  'STRUCT(id VARCHAR, "name" VARCHAR, blocked BOOLEAN, suspicious BOOLEAN)';

-- One streaming read, projecting the legs we need (with collection nesting).
CREATE OR REPLACE TEMP TABLE raw AS
SELECT id, date_completed, price,
       len(offered)  AS n_off,
       len(requested) AS n_req,
       offered, requested
FROM read_json(
  'generated/dexie-offers-dedup.jsonl',
  format='newline_delimited',
  columns={
    id:'VARCHAR', date_completed:'TIMESTAMP', price:'DOUBLE',
    offered:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN, collection STRUCT(id VARCHAR, "name" VARCHAR, blocked BOOLEAN, suspicious BOOLEAN))[]',
    requested:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN, collection STRUCT(id VARCHAR, "name" VARCHAR, blocked BOOLEAN, suspicious BOOLEAN))[]'
  }
);

-- Long/tidy NFT legs only, with collection attached.
CREATE OR REPLACE TEMP TABLE nft_legs AS
SELECT id AS offer_id, date_completed, price, n_off, n_req, 'offered' AS side,
       u.leg.collection.id AS coll_id, u.leg.collection.name AS coll_name,
       coalesce(u.leg.collection.blocked,false) AS blocked,
       coalesce(u.leg.collection.suspicious,false) AS suspicious
FROM raw, UNNEST(offered) AS u(leg)
WHERE coalesce(u.leg.is_nft,false)
UNION ALL
SELECT id, date_completed, price, n_off, n_req, 'requested',
       u.leg.collection.id, u.leg.collection.name,
       coalesce(u.leg.collection.blocked,false), coalesce(u.leg.collection.suspicious,false)
FROM raw, UNNEST(requested) AS u(leg)
WHERE coalesce(u.leg.is_nft,false);

-- Save the tidy NFT-leg table for the markdown's reproducible queries.
COPY nft_legs TO 'generated/nft_legs.parquet' (FORMAT parquet);

-- ============================================================
-- Q-C1: coverage of collection metadata
-- ============================================================
.print '== Q-C1: NFT-leg collection coverage =='
SELECT count(*) AS nft_legs,
       count(coll_id) AS with_coll_id,
       round(100.0*count(coll_id)/count(*),1) AS pct_with_coll,
       count(DISTINCT coll_id) AS distinct_collections
FROM nft_legs;

-- ============================================================
-- Q-C2: top collections by trade count (offers touching the collection)
-- ============================================================
.print '== Q-C2: top 25 collections by trade count =='
SELECT coalesce(coll_name,'(no collection metadata)') AS collection,
       count(DISTINCT offer_id) AS trades,
       count(DISTINCT offer_id) FILTER (WHERE blocked OR suspicious) AS flagged
FROM nft_legs
GROUP BY coll_id, coll_name
ORDER BY trades DESC
LIMIT 25;

-- ============================================================
-- Q-C3: top collections by XCH volume (single-pair NFT->XCH sales only).
-- price = requested.amount/offered.amount; for single NFT offered (amount 1)
-- and XCH requested, price == XCH paid. Trim junk to 0.005..1000 XCH.
-- ============================================================
.print '== Q-C3: top 25 collections by XCH volume (NFT->XCH single-pair sales) =='
WITH sales AS (
  -- NFT offered, exactly one leg each side, requested side is XCH.
  SELECT nl.offer_id, nl.coll_id, nl.coll_name, nl.price AS xch
  FROM nft_legs nl
  JOIN raw r ON r.id=nl.offer_id
  WHERE nl.side='offered' AND nl.n_off=1 AND nl.n_req=1
    AND r.requested[1].id='xch'
    AND nl.price BETWEEN 0.005 AND 1000
)
SELECT coalesce(coll_name,'(no collection metadata)') AS collection,
       count(*) AS sales,
       round(sum(xch),1) AS xch_volume,
       round(median(xch),3) AS median_xch
FROM sales
GROUP BY coll_id, coll_name
ORDER BY xch_volume DESC
LIMIT 25;

-- ============================================================
-- Q-C4: concentration — share of NFT->XCH sales & XCH volume held by top-N collections
-- ============================================================
.print '== Q-C4: concentration of NFT->XCH sales (top-N collection share) =='
WITH sales AS (
  SELECT nl.coll_id, nl.price AS xch
  FROM nft_legs nl JOIN raw r ON r.id=nl.offer_id
  WHERE nl.side='offered' AND nl.n_off=1 AND nl.n_req=1
    AND r.requested[1].id='xch' AND nl.price BETWEEN 0.005 AND 1000
    AND nl.coll_id IS NOT NULL
),
percoll AS (
  SELECT coll_id, count(*) AS s, sum(xch) AS v,
         row_number() OVER (ORDER BY count(*) DESC) AS rk_s,
         row_number() OVER (ORDER BY sum(xch)  DESC) AS rk_v
  FROM sales GROUP BY coll_id
),
tot AS (SELECT sum(s) AS S, sum(v) AS V, count(*) AS C FROM percoll)
SELECT 'top10'  AS bucket,
       round(100.0*(SELECT sum(s) FROM percoll WHERE rk_s<=10)/(SELECT S FROM tot),1) AS pct_sales,
       round(100.0*(SELECT sum(v) FROM percoll WHERE rk_v<=10)/(SELECT V FROM tot),1) AS pct_xch_vol
UNION ALL SELECT 'top25',
       round(100.0*(SELECT sum(s) FROM percoll WHERE rk_s<=25)/(SELECT S FROM tot),1),
       round(100.0*(SELECT sum(v) FROM percoll WHERE rk_v<=25)/(SELECT V FROM tot),1)
UNION ALL SELECT 'top100',
       round(100.0*(SELECT sum(s) FROM percoll WHERE rk_s<=100)/(SELECT S FROM tot),1),
       round(100.0*(SELECT sum(v) FROM percoll WHERE rk_v<=100)/(SELECT V FROM tot),1)
UNION ALL SELECT 'all_collections (count)',
       (SELECT C FROM tot)::DOUBLE, NULL;

-- ============================================================
-- Q-C5: collection lifecycle — monthly trade count for the top 8 collections
-- (export to CSV for the chart series)
-- ============================================================
.print '== Q-C5: writing collection lifecycle CSV (top 8 by trades) =='
COPY (
  WITH topc AS (
    SELECT coll_id, coll_name FROM (
      SELECT coll_id, coll_name, count(DISTINCT offer_id) t,
             row_number() OVER (ORDER BY count(DISTINCT offer_id) DESC) rk
      FROM nft_legs WHERE coll_id IS NOT NULL GROUP BY coll_id, coll_name
    ) WHERE rk<=8
  )
  SELECT strftime(nl.date_completed,'%Y-%m') AS month,
         tc.coll_name AS collection,
         count(DISTINCT nl.offer_id) AS trades
  FROM nft_legs nl JOIN topc tc USING(coll_id)
  GROUP BY 1,2 ORDER BY 2,1
) TO 'research/dexie-offers/findings/data/02-nft-collection-lifecycle.csv' (HEADER, DELIMITER ',');
.print 'wrote research/dexie-offers/findings/data/02-nft-collection-lifecycle.csv'
