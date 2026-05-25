-- Load dexie reward claims (from crawl-rewards.ts) into offers.duckdb.
-- Dedup by id (claims grow at the page front during the crawl → possible dups).
CREATE OR REPLACE TABLE reward_claims AS
SELECT id, offer_id, status, claimed_amount, maker_puzzle_hash, target_puzzle_hash, date_claimed
FROM read_json('generated/dexie-rewards-claims.jsonl', format='newline_delimited',
  columns={ id:'VARCHAR', offer_id:'VARCHAR', status:'BIGINT', claimed_amount:'DOUBLE',
            maker_puzzle_hash:'VARCHAR', target_puzzle_hash:'VARCHAR', date_claimed:'TIMESTAMP' })
QUALIFY row_number() OVER (PARTITION BY id ORDER BY date_claimed) = 1;
COPY reward_claims TO 'generated/reward-claims.parquet' (FORMAT parquet);
