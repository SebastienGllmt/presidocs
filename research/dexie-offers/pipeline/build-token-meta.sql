-- Load the dexie asset registry (from crawl-assets.ts) into a `token_meta` table
-- so tokens can be classified by their real `description`, not by ticker/name.
--   bun research/dexie-offers/pipeline/crawl-assets.ts            # refresh generated/dexie-assets.jsonl
--   ./tools/duckdb generated/offers.duckdb < research/dexie-offers/pipeline/build-token-meta.sql
CREATE OR REPLACE TABLE token_meta AS
SELECT id, code, name, description, is_nft, denom, website, did, supply,
       current_avg_price, floor_price
FROM read_json('generated/dexie-assets.jsonl', format='newline_delimited',
  columns={
    id:'VARCHAR', code:'VARCHAR', name:'VARCHAR', description:'VARCHAR',
    is_nft:'BOOLEAN', denom:'BIGINT', website:'VARCHAR', did:'VARCHAR',
    supply:'BIGINT', current_avg_price:'DOUBLE', floor_price:'DOUBLE'
  });
COPY token_meta TO 'generated/token-meta.parquet' (FORMAT parquet);
