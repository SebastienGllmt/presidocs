-- Round-2 substrate extension: recover two fields dropped from the base
-- substrate, for the participant-graph (O1) and royalty (O2) investigations.
-- One streaming pass over the deduped JSONL; adds two tables to offers.duckdb.
--
--   ./tools/duckdb generated/offers.duckdb < research/dexie-offers/pipeline/build-substrate-extra.sql
--
--   coins    — exploded `involved_coins`: one row per (offer, coin id). The coins
--              an offer consumes/produces on-chain (maker reserve + taker + change).
--              Use for a common-coin participant-clustering heuristic (O1). NOTE:
--              involved_coins mixes BOTH sides, so a shared coin links *participation*,
--              not necessarily a single maker identity — reason about this in O1.
--   nft_meta — one row per NFT leg, with creator + royalty (basis points) + mint
--              height + collection, recovered from offered[]/requested[].nft_data.
--              (T2's nft_legs.parquet had collection only; this adds royalty/creator.)

CREATE OR REPLACE TEMP TABLE _raw2 AS
SELECT id, date_completed, price, involved_coins, offered, requested
FROM read_json(
  'generated/dexie-offers-dedup.jsonl',
  format='newline_delimited',
  columns={
    id:'VARCHAR', date_completed:'TIMESTAMP', price:'DOUBLE',
    involved_coins:'VARCHAR[]',
    offered:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN, nft_data STRUCT(creator STRUCT(id VARCHAR, is_did BOOLEAN), royalty BIGINT, height BIGINT), collection STRUCT(id VARCHAR, "name" VARCHAR))[]',
    requested:'STRUCT(id VARCHAR, code VARCHAR, "name" VARCHAR, amount DOUBLE, is_nft BOOLEAN, nft_data STRUCT(creator STRUCT(id VARCHAR, is_did BOOLEAN), royalty BIGINT, height BIGINT), collection STRUCT(id VARCHAR, "name" VARCHAR))[]'
  }
);

CREATE OR REPLACE TABLE coins AS
SELECT id AS offer_id, date_completed, c AS coin_id
FROM _raw2, UNNEST(involved_coins) AS t(c)
WHERE c IS NOT NULL;

CREATE OR REPLACE TABLE nft_meta AS
SELECT id AS offer_id, date_completed, price, 'offered' AS side,
       u.leg.id AS asset_id, u.leg.code AS code,
       u.leg.nft_data.creator.id AS creator_id,
       coalesce(u.leg.nft_data.creator.is_did,false) AS creator_is_did,
       u.leg.nft_data.royalty AS royalty_bps,
       u.leg.nft_data.height AS mint_height,
       u.leg.collection.id AS collection_id, u.leg.collection.name AS collection_name
FROM _raw2, UNNEST(offered) AS u(leg)
WHERE coalesce(u.leg.is_nft,false)
UNION ALL
SELECT id AS offer_id, date_completed, price, 'requested' AS side,
       u.leg.id AS asset_id, u.leg.code AS code,
       u.leg.nft_data.creator.id AS creator_id,
       coalesce(u.leg.nft_data.creator.is_did,false) AS creator_is_did,
       u.leg.nft_data.royalty AS royalty_bps,
       u.leg.nft_data.height AS mint_height,
       u.leg.collection.id AS collection_id, u.leg.collection.name AS collection_name
FROM _raw2, UNNEST(requested) AS u(leg)
WHERE coalesce(u.leg.is_nft,false);

DROP TABLE _raw2;

COPY coins    TO 'generated/coins.parquet'    (FORMAT parquet);
COPY nft_meta TO 'generated/nft-meta.parquet' (FORMAT parquet);
