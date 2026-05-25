-- =====================================================================
-- 01-amm.sql — Thesis T1: AMM-vs-P2P reality of offer-file trading
-- =====================================================================
-- Run read-only (do not lock the DB for the other agents):
--   ./tools/duckdb -readonly generated/offers.duckdb -c "$(cat research/dexie-offers/analysis/01-amm.sql)"
-- or run a single block by copy/paste.
--
-- Key fact (from recon, re-verified in Q0): dexie records known_taker_source
-- ONLY for TibetSwap AMM fills ('tibet2') and ONLY since ~2025-04-02. So
-- tibet2 share is a FLOOR on automated market-making; other AMMs/bots are
-- unlabeled. NULL='tibet2' is NULL, so always coalesce(...,'') first.
-- amounts are in human units; price = requested.amount/offered.amount.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Q0. Baseline: confirm recon numbers. tibet2 is the only non-null source;
-- first fill 2025-04-02; 46.15% of post-Apr-2025 offers are tibet2.
-- ---------------------------------------------------------------------
SELECT count(*) AS n_since_apr2025,
       sum(CASE WHEN coalesce(known_taker_source,'')='tibet2' THEN 1 ELSE 0 END) AS n_tibet2,
       round(100.0*sum(CASE WHEN coalesce(known_taker_source,'')='tibet2' THEN 1 ELSE 0 END)/count(*),2) AS pct_tibet2
FROM offers WHERE date_completed >= '2025-04-01';

SELECT coalesce(known_taker_source,'(null)') AS src, count(*) AS n FROM offers GROUP BY 1 ORDER BY n DESC;
SELECT min(date_completed) AS first_tibet2 FROM offers WHERE coalesce(known_taker_source,'')='tibet2';

-- ---------------------------------------------------------------------
-- Q1. AMM share over time (monthly), since 2025-04. -> CHART 1
-- NOTE: 2025-04 is partial (data starts 2025-04-02) and 2026-05 is partial
-- (snapshot 2026-05-23). Read the interior months for the trend.
-- CSV: research/dexie-offers/findings/data/01-amm-monthly-share.csv
-- ---------------------------------------------------------------------
SELECT strftime(date_trunc('month', date_completed), '%Y-%m') AS month,
       count(*) AS n_offers,
       sum(CASE WHEN coalesce(known_taker_source,'')='tibet2' THEN 1 ELSE 0 END) AS n_tibet2,
       round(100.0*sum(CASE WHEN coalesce(known_taker_source,'')='tibet2' THEN 1 ELSE 0 END)/count(*),2) AS pct_tibet2
FROM offers WHERE date_completed >= '2025-04-01'
GROUP BY 1 ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q2. Confirm tibet2 fills are ~all fungible CAT<>XCH swaps:
--   (a) ZERO tibet2 fills involve an NFT (AMMs don't trade NFTs).
--   (b) EVERY tibet2 fill involves XCH (TibetSwap pools are CAT<>XCH).
--   (c) 98.2% are single-pair (1x1) simple swaps vs 91.6% of P2P.
-- ---------------------------------------------------------------------
WITH t AS (SELECT id FROM offers WHERE coalesce(known_taker_source,'')='tibet2')
SELECT (SELECT count(*) FROM t) AS n_tibet2,
       (SELECT count(DISTINCT offer_id) FROM legs WHERE is_nft AND offer_id IN (SELECT id FROM t)) AS n_tibet2_with_nft,
       (SELECT count(DISTINCT offer_id) FROM legs WHERE asset_id='xch' AND offer_id IN (SELECT id FROM t)) AS n_tibet2_with_xch;

SELECT coalesce(known_taker_source,'')='tibet2' AS is_amm, count(*) AS n,
       round(100.0*avg(CASE WHEN is_single_pair THEN 1 ELSE 0 END),2) AS pct_single_pair
FROM offers WHERE date_completed>='2025-04-01' GROUP BY 1;

-- Top CATs filled by the AMM (leg appearances; key on asset_id, keep no-code).
WITH t AS (SELECT id FROM offers WHERE coalesce(known_taker_source,'')='tibet2')
SELECT coalesce(l.code,'(no code)') AS code, l.asset_id, count(*) AS n_legs
FROM legs l JOIN t ON l.offer_id=t.id
WHERE l.asset_id <> 'xch'
GROUP BY 1,2 ORDER BY n_legs DESC LIMIT 25;

-- ---------------------------------------------------------------------
-- Q3. Apples-to-apples AMM vs P2P (post-Apr-2025). -> CHART 2
-- Time-to-fill (date_found->date_completed), sub-minute share, fees.
-- AMM: median 0.58 min, 70.7% sub-minute. P2P: median 235.9 min, 20.7%.
-- ---------------------------------------------------------------------
SELECT coalesce(known_taker_source,'')='tibet2' AS is_amm, count(*) AS n,
       round(median(date_diff('second', date_found, date_completed))/60.0,2) AS p50_ttf_min,
       round(quantile_cont(date_diff('second', date_found, date_completed), 0.9)/60.0,2) AS p90_ttf_min,
       round(100.0*avg(CASE WHEN date_diff('second',date_found,date_completed)<60  THEN 1 ELSE 0 END),2) AS pct_sub_minute,
       round(100.0*avg(CASE WHEN date_diff('second',date_found,date_completed)<300 THEN 1 ELSE 0 END),2) AS pct_sub_5min,
       round(100.0*avg(CASE WHEN fees=0 THEN 1 ELSE 0 END),2) AS pct_zero_fee
FROM offers WHERE date_completed>='2025-04-01' GROUP BY 1;

-- ---------------------------------------------------------------------
-- Q4. Trade-size distribution by the common XCH leg (single-pair, post-Apr).
-- AMM spans dust->large (p25 0.003, p95 9.06 XCH); P2P clusters (p25 0.1, p95 5).
-- ---------------------------------------------------------------------
WITH w AS (SELECT id, coalesce(known_taker_source,'')='tibet2' AS is_amm
           FROM offers WHERE date_completed>='2025-04-01' AND is_single_pair),
     xch_leg AS (SELECT l.offer_id, l.amount AS xch_amt FROM legs l JOIN w ON l.offer_id=w.id WHERE l.asset_id='xch')
SELECT w.is_amm, count(*) AS n,
       round(quantile_cont(x.xch_amt,0.25),3) AS p25_xch,
       round(median(x.xch_amt),3)             AS median_xch,
       round(quantile_cont(x.xch_amt,0.75),3) AS p75_xch,
       round(quantile_cont(x.xch_amt,0.95),3) AS p95_xch
FROM w JOIN xch_leg x ON w.id=x.offer_id GROUP BY 1 ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q5. Round-number / amount-precision fingerprint (single-pair XCH<>CAT,
-- post-Apr). -> CHART 3. Humans post round XCH amounts; AMMs emit
-- continuous pool-derived amounts.
--   pct_round_05      : XCH amount is a multiple of 0.05
--   pct_many_decimals : XCH amount has precision finer than 1e-3 (i.e.
--                       (amt*1e12) not divisible by 1e9) -> "continuous"
-- AMM: 14.7% round / 52.6% many-decimals. P2P: 48.8% round / 25.4%.
-- ---------------------------------------------------------------------
WITH w AS (SELECT id, coalesce(known_taker_source,'')='tibet2' AS is_amm
           FROM offers WHERE date_completed>='2025-04-01' AND is_single_pair),
     xleg AS (SELECT offer_id, amount AS xch_amt FROM legs WHERE asset_id='xch' AND offer_id IN (SELECT id FROM w))
SELECT w.is_amm, count(*) AS n,
       round(100.0*avg(CASE WHEN (x.xch_amt*100)::bigint % 5 = 0 AND x.xch_amt=round(x.xch_amt,2) THEN 1 ELSE 0 END),2) AS pct_round_05,
       round(100.0*avg(CASE WHEN x.xch_amt = round(x.xch_amt,0) THEN 1 ELSE 0 END),2) AS pct_whole,
       round(100.0*avg(CASE WHEN (x.xch_amt*1e12)::bigint % (1e9)::bigint <> 0 THEN 1 ELSE 0 END),2) AS pct_many_decimals
FROM w JOIN xleg x ON w.id=x.offer_id GROUP BY 1 ORDER BY 1;

-- ---------------------------------------------------------------------
-- Q6. INFERENCE (label as such): hidden automation in the UNLABELED
-- (non-tibet2) population. Among non-tibet single-pair XCH<>CAT offers,
-- how many carry the AMM/bot fingerprint (sub-minute fill AND continuous
-- amount)? 9,715 of 127,681 = 7.6%. Supports "tibet2 share is a FLOOR."
-- ---------------------------------------------------------------------
WITH w AS (SELECT id, date_found, date_completed FROM offers
           WHERE date_completed>='2025-04-01' AND is_single_pair AND coalesce(known_taker_source,'')<>'tibet2'),
     xleg AS (SELECT offer_id, amount AS xch_amt FROM legs WHERE asset_id='xch' AND offer_id IN (SELECT id FROM w))
SELECT count(*) AS n_nonamm_xchcat,
       sum(CASE WHEN date_diff('second',w.date_found,w.date_completed)<60 THEN 1 ELSE 0 END) AS n_submin,
       sum(CASE WHEN date_diff('second',w.date_found,w.date_completed)<60 AND (x.xch_amt*1e12)::bigint % (1e9)::bigint <> 0 THEN 1 ELSE 0 END) AS n_botlike,
       round(100.0*avg(CASE WHEN date_diff('second',w.date_found,w.date_completed)<60 AND (x.xch_amt*1e12)::bigint % (1e9)::bigint <> 0 THEN 1 ELSE 0 END),2) AS pct_botlike
FROM w JOIN xleg x ON w.id=x.offer_id;

-- ---------------------------------------------------------------------
-- Q7. TIBET-* LP-token trading. -> CHART 4
-- (a) 37,431 offers (4.49% of all) involve a TIBET-* LP token.
-- (b) Only 3,335 (8.9%) are tibet2-filled => LP tokens trade as a
--     P2P secondary market, NOT through the AMM taker path.
-- (c) Structure of LP offers (which asset kinds appear alongside the LP):
--     CAT+LP+XCH 23,761 = liquidity add/remove signature
--     LP+NFT     12,092 = LP used as currency to buy/sell NFTs (!)
--     LP+XCH      1,525 = pure LP<->XCH secondary swap
-- CSV: research/dexie-offers/findings/data/01-amm-lp-monthly.csv
-- ---------------------------------------------------------------------
WITH lp AS (SELECT DISTINCT offer_id FROM legs WHERE code LIKE 'TIBET-%')
SELECT (SELECT count(*) FROM offers) AS total_offers,
       (SELECT count(*) FROM lp) AS offers_with_lp,
       round(100.0*(SELECT count(*) FROM lp)/(SELECT count(*) FROM offers),2) AS pct_lp;

WITH lp AS (SELECT DISTINCT offer_id FROM legs WHERE code LIKE 'TIBET-%')
SELECT coalesce(o.known_taker_source,'(null)') AS src, count(*) AS n
FROM offers o JOIN lp ON o.id=lp.offer_id GROUP BY 1 ORDER BY n DESC;

WITH lp AS (SELECT DISTINCT offer_id FROM legs WHERE code LIKE 'TIBET-%'),
     nonlp AS (
       SELECT offer_id,
              list(DISTINCT CASE WHEN asset_id='xch' THEN 'XCH'
                                 WHEN code LIKE 'TIBET-%' THEN 'LP'
                                 WHEN is_nft THEN 'NFT' ELSE 'CAT' END) AS kinds
       FROM legs WHERE offer_id IN (SELECT offer_id FROM lp) GROUP BY 1)
SELECT array_to_string(list_sort(kinds),'+') AS structure, count(*) AS n
FROM nonlp GROUP BY 1 ORDER BY n DESC;

-- LP offers monthly (CSV export feeds chart 4).
WITH lp AS (SELECT DISTINCT offer_id FROM legs WHERE code LIKE 'TIBET-%')
SELECT strftime(date_trunc('month',date_completed),'%Y-%m') AS month, count(*) AS n_lp_offers
FROM offers o JOIN lp ON o.id=lp.offer_id
GROUP BY 1 ORDER BY 1;
