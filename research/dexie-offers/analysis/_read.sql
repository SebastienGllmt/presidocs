-- Robust explicit-column read of the dedup JSONL. Projects only analysis
-- fields (drops the bech32 `offer` blob, involved_coins, NFT/collection
-- nesting) so schema inference can't surprise us over the full 2.7GB.
CREATE OR REPLACE TEMP MACRO src() AS TABLE
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
