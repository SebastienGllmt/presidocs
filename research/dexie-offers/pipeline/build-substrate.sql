-- Build the analysis substrate from the deduped dexie dump.
--   Input : generated/dexie-offers-dedup.jsonl  (833,145 unique completed offers)
--   Output: generated/offers.duckdb             (offers + legs tables)
--           generated/offers.parquet, generated/legs.parquet (portable exports)
--
-- Run:  ./tools/duckdb generated/offers.duckdb < research/dexie-offers/pipeline/build-substrate.sql
--
-- Design: one streaming pass reads the JSONL into _raw (projecting only the
-- analysis fields, dropping the bech32 `offer` blob + NFT/collection nesting so
-- schema inference is stable over the full 2.7GB). `offers` is one row per
-- offer; `legs` is the long/tidy explosion (one row per offer x side x leg) —
-- the shape every per-asset / per-pair group-by wants.

CREATE OR REPLACE TABLE _raw AS
SELECT * FROM read_json(
  'generated/dexie-offers-dedup.jsonl',
  format='newline_delimited',
  columns={
    id:'VARCHAR', status:'BIGINT',
    date_found:'TIMESTAMP', date_completed:'TIMESTAMP',
    date_pending:'TIMESTAMP', date_expiry:'TIMESTAMP',
    block_expiry:'BIGINT', spent_block_index:'BIGINT',
    price:'DOUBLE', fees:'DOUBLE', mod_version:'BIGINT', trade_id:'VARCHAR',
    offered:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN)[]',
    requested:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN)[]',
    mempool:'STRUCT(id VARCHAR, "cost" BIGINT, fees BIGINT, combined BOOLEAN)',
    known_taker:'STRUCT("name" VARCHAR, "source" VARCHAR)'
  }
);

-- One row per offer. Leg counts let analyses filter single- vs multi-leg
-- without re-touching the arrays.
CREATE OR REPLACE TABLE offers AS
SELECT
  id, status,
  date_found, date_completed, date_pending, date_expiry,
  block_expiry, spent_block_index,
  price, fees, mod_version, trade_id,
  known_taker.name   AS known_taker_name,
  known_taker.source AS known_taker_source,
  mempool.cost       AS mempool_cost,
  mempool.fees       AS mempool_fees,
  mempool.combined   AS mempool_combined,
  len(offered)       AS n_offered,
  len(requested)     AS n_requested,
  (len(offered)=1 AND len(requested)=1) AS is_single_pair
FROM _raw;

-- Long/tidy legs. `side` distinguishes the give vs. get leg; `leg_idx` is the
-- position within that side's array. asset_id is the dedup-safe key (≈43% of
-- legs have NULL code — keep them as a distinct bucket, never drop).
CREATE OR REPLACE TABLE legs AS
SELECT id AS offer_id, date_completed, 'offered'  AS side,
       u.idx-1 AS leg_idx, u.leg.id AS asset_id, u.leg.code AS code,
       u.leg.name AS name, u.leg.amount AS amount, coalesce(u.leg.is_nft,false) AS is_nft
FROM _raw, UNNEST(offered) WITH ORDINALITY AS u(leg, idx)
UNION ALL
SELECT id AS offer_id, date_completed, 'requested' AS side,
       u.idx-1 AS leg_idx, u.leg.id AS asset_id, u.leg.code AS code,
       u.leg.name AS name, u.leg.amount AS amount, coalesce(u.leg.is_nft,false) AS is_nft
FROM _raw, UNNEST(requested) WITH ORDINALITY AS u(leg, idx);

DROP TABLE _raw;

-- Portable exports (gitignored alongside the .duckdb; cheap to regenerate).
COPY offers TO 'generated/offers.parquet' (FORMAT parquet);
COPY legs   TO 'generated/legs.parquet'   (FORMAT parquet);
