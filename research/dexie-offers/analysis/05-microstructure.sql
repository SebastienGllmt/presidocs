-- =====================================================================
-- T5 — Market microstructure deep dive (fees / timing / format / junk /
-- partial-fills / trade size) for posts/offer-files-data.html.
--
-- Run read-only so the other agents' connections aren't locked:
--   ./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/05-microstructure.sql"
-- or run individual blocks with -c "SELECT ...".
--
-- Companion script (related_offers, which is NOT in the substrate — it was
-- dropped when building offers.duckdb): research/dexie-offers/analysis/05-related-offers.ts
-- streams generated/dexie-offers-dedup.jsonl -> generated/related-offers.csv.
--
-- Coverage caveat (see research/dexie-offers/README.md): 84.7% of global, biased to
-- dropping the OLDEST offers of the BUSIEST pairs (anything <-> XCH/stablecoins).
-- date_found is dexie's first-seen, NOT offer-creation time, and can lag the
-- on-chain settlement (19,646 offers have date_completed < date_found).
-- All time-to-fill numbers are floors / first-seen-relative, not true age.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. mempool_combined: is the recon's "100%" real? (NO — it's an artifact)
--    combined is NEVER false; it is either TRUE (19.31%) or NULL (80.69%).
--    The recon read 100% because it only saw the non-null rows. combined is a
--    PRESENCE flag, not a true/false boolean.
-- ---------------------------------------------------------------------
SELECT mempool_combined, count(*) n,
       round(100.0*count(*)/sum(count(*)) over (),2) pct
FROM offers GROUP BY 1 ORDER BY 2 DESC;
-- total / has_cost / combined_true / combined_false (false is always 0):
SELECT count(*) total, count(mempool_cost) has_cost,
       sum(CASE WHEN mempool_combined IS TRUE  THEN 1 ELSE 0 END) combined_true,
       sum(CASE WHEN mempool_combined IS FALSE THEN 1 ELSE 0 END) combined_false
FROM offers;

-- What combined correlates with: ~100% single-pair, higher mempool cost,
-- mempool_fees median 1 mojo (vs 100000 when not combined) -> a settlement
-- BATCHING signal (the offer was settled combined into a larger spend bundle).
SELECT coalesce(mempool_combined,false) AS combined, count(*) n,
       round(avg(CASE WHEN is_single_pair THEN 1.0 ELSE 0 END)*100,1) pct_single_pair,
       round(avg(CASE WHEN fees>0 THEN 1.0 ELSE 0 END)*100,1) pct_nonzero_fee,
       round(median(mempool_cost),0) med_cost,
       round(median(mempool_fees),0) med_mempool_fees
FROM offers GROUP BY 1;

-- combined only appears from 2024 and rises (0% 2022/23 -> 49% 2026).
SELECT year(date_completed) yr, count(*) n,
       round(100.0*sum(CASE WHEN mempool_combined THEN 1 ELSE 0 END)/count(*),2) pct_combined,
       round(100.0*count(mempool_cost)/count(*),2) pct_has_mempool
FROM offers GROUP BY 1 ORDER BY 1;

-- Among 2025-04+ (where known_taker is recorded) combined is mostly TibetSwap:
-- combined=true is 81% tibet2; combined is the AMM batch-settlement footprint.
SELECT coalesce(mempool_combined,false) combined,
       coalesce(known_taker_source,'(none)') src, count(*) n
FROM offers WHERE date_completed >= '2025-04-01'
GROUP BY 1,2 ORDER BY 1,3 DESC;


-- ---------------------------------------------------------------------
-- 1. FEES
-- ---------------------------------------------------------------------
-- Headline distribution. 81.39% zero. Nonzero median 0.000187 XCH (tiny).
SELECT count(*) n,
       round(100.0*sum(CASE WHEN fees=0 THEN 1 ELSE 0 END)/count(*),2) pct_zero,
       round(100.0*sum(CASE WHEN fees>0 THEN 1 ELSE 0 END)/count(*),2) pct_nonzero,
       round(median(fees) FILTER (WHERE fees>0),8) med_nonzero,
       round(quantile_cont(fees,0.90) FILTER (WHERE fees>0),8) p90_nonzero,
       round(quantile_cont(fees,0.99) FILTER (WHERE fees>0),8) p99_nonzero,
       round(max(fees),6) maxfee
FROM offers;

-- Fee magnitude buckets (XCH).
SELECT CASE
    WHEN fees=0 THEN '0'
    WHEN fees < 0.000001 THEN 'a: <1e-6 (dust)'
    WHEN fees < 0.00001  THEN 'b: 1e-6..1e-5'
    WHEN fees < 0.0001   THEN 'c: 1e-5..1e-4'
    WHEN fees < 0.001    THEN 'd: 1e-4..1e-3'
    WHEN fees < 0.01     THEN 'e: 1e-3..1e-2'
    WHEN fees < 0.1      THEN 'f: 0.01..0.1'
    ELSE 'g: >=0.1' END bucket,
  count(*) n, round(100.0*count(*)/sum(count(*)) over (),3) pct
FROM offers GROUP BY 1 ORDER BY 1;

-- Fee-paying share over time (monthly). Rose from ~3-8% (2023) to 30-50%
-- peaks (2024-2025 congestion), settling ~15-22% in 2026.
SELECT strftime(date_completed,'%Y-%m') mo, count(*) n,
       round(100.0*sum(CASE WHEN fees>0 THEN 1 ELSE 0 END)/count(*),2) pct_nonzero,
       round(median(fees) FILTER (WHERE fees>0),8) med_nonzero_fee
FROM offers GROUP BY 1 ORDER BY 1;

-- WHO pays: by asset category. Fungible swaps pay (29%); NFT trades almost
-- never (2.4%). (cat: an offer "involves NFT" if any leg is_nft.)
CREATE OR REPLACE TEMP TABLE cat AS
SELECT o.id,
       bool_or(l.is_nft) has_nft,
       bool_or(l.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT')) has_stable
FROM offers o JOIN legs l ON o.id=l.offer_id GROUP BY 1;
SELECT CASE WHEN c.has_nft THEN 'NFT-involved'
            WHEN c.has_stable THEN 'stablecoin'
            ELSE 'fungible-only' END category,
       count(*) n,
       round(100.0*sum(CASE WHEN o.fees>0 THEN 1 ELSE 0 END)/count(*),2) pct_pays_fee
FROM offers o JOIN cat c ON o.id=c.id GROUP BY 1 ORDER BY 3 DESC;

-- WHO pays: by settle speed. The cleanest signal — fast fills pay, rests don't.
-- 42% of sub-minute fills pay a fee vs 0.68% of offers that sat >30 days.
SELECT CASE
    WHEN epoch(date_completed)-epoch(date_found) < 60      THEN 'a: <1min (instant)'
    WHEN epoch(date_completed)-epoch(date_found) < 3600    THEN 'b: <1hr'
    WHEN epoch(date_completed)-epoch(date_found) < 86400   THEN 'c: <1day'
    WHEN epoch(date_completed)-epoch(date_found) < 2592000 THEN 'd: <30day'
    ELSE 'e: >30day' END speed,
  count(*) n,
  round(100.0*sum(CASE WHEN fees>0 THEN 1 ELSE 0 END)/count(*),2) pct_pays_fee
FROM offers WHERE date_found IS NOT NULL AND date_completed>=date_found
GROUP BY 1 ORDER BY 1;


-- ---------------------------------------------------------------------
-- 2. TIME-TO-FILL  (date_found -> date_completed)
--    date_found is dexie's FIRST-SEEN, not creation; treat as a floor.
-- ---------------------------------------------------------------------
WITH t AS (SELECT epoch(date_completed)-epoch(date_found) secs
           FROM offers WHERE date_found IS NOT NULL AND date_completed>=date_found)
SELECT count(*) n,
       round(quantile_cont(secs,0.10),0) p10, round(quantile_cont(secs,0.25),0) p25,
       round(quantile_cont(secs,0.50),0) p50, round(quantile_cont(secs,0.75),0) p75,
       round(quantile_cont(secs,0.90),0) p90, round(quantile_cont(secs,0.99),0) p99
FROM t;

-- Bimodal distribution: spike at 10-60s (26%) = instant/AMM mode; long tail
-- with 14% sitting >30 days.
SELECT CASE
    WHEN secs<10     THEN 'a: <10s'      WHEN secs<60     THEN 'b: 10-60s'
    WHEN secs<600    THEN 'c: 1-10min'   WHEN secs<3600   THEN 'd: 10-60min'
    WHEN secs<86400  THEN 'e: 1-24hr'    WHEN secs<604800 THEN 'f: 1-7day'
    WHEN secs<2592000 THEN 'g: 7-30day'  ELSE 'h: >30day' END bucket,
  count(*) n, round(100.0*count(*)/sum(count(*)) over (),2) pct
FROM (SELECT epoch(date_completed)-epoch(date_found) secs
      FROM offers WHERE date_found IS NOT NULL AND date_completed>=date_found)
GROUP BY 1 ORDER BY 1;

-- Sanity: 19,646 offers have date_completed < date_found (first-seen lag).
SELECT sum(CASE WHEN date_found IS NULL THEN 1 ELSE 0 END) null_found,
       sum(CASE WHEN date_completed<date_found THEN 1 ELSE 0 END) completed_before_found
FROM offers;

-- The instant-fill mode is the AMM: among 2025-04+, 76% of <60s fills are
-- TibetSwap, vs 24% of >=60s rests.
WITH tt AS (SELECT epoch(date_completed)-epoch(date_found) secs,
                   coalesce(known_taker_source,'')='tibet2' is_tibet
            FROM offers WHERE date_found IS NOT NULL AND date_completed>=date_found
              AND date_completed>='2025-04-01')
SELECT CASE WHEN secs<60 THEN 'instant <60s' ELSE 'resting >=60s' END fillmode,
       count(*) n, round(100.0*sum(CASE WHEN is_tibet THEN 1 ELSE 0 END)/count(*),1) pct_tibet
FROM tt GROUP BY 1;

-- Time-to-fill by category: fungible fills in seconds (median 62s, 49% instant);
-- NFTs sit ~19.5h median (9% instant).
SELECT CASE WHEN c.has_nft THEN 'NFT' WHEN c.has_stable THEN 'stablecoin' ELSE 'fungible' END category,
       count(*) n,
       round(median(epoch(o.date_completed)-epoch(o.date_found)),0) med_secs,
       round(100.0*sum(CASE WHEN epoch(o.date_completed)-epoch(o.date_found)<60 THEN 1 ELSE 0 END)/count(*),1) pct_instant
FROM offers o JOIN cat c ON o.id=c.id
WHERE o.date_found IS NOT NULL AND o.date_completed>=o.date_found
GROUP BY 1 ORDER BY 3;


-- ---------------------------------------------------------------------
-- 3. FORMAT MIGRATION  (mod_version v1 -> v2)
--    Hard cliff: v2 goes 0% (Jan 2023) -> 89% (Mar 2023) -> ~100% by mid-2024.
--    Last v1 ever settled: 2023-08-23. (date axis = settlement, so old v1
--    offers settling late explain the small post-cliff tail.)
-- ---------------------------------------------------------------------
SELECT mod_version, count(*) n, round(100.0*count(*)/sum(count(*)) over(),2) pct
FROM offers GROUP BY 1 ORDER BY 1;
SELECT strftime(date_completed,'%Y-%m') mo, count(*) n,
       sum(CASE WHEN mod_version=1 THEN 1 ELSE 0 END) v1,
       sum(CASE WHEN mod_version=2 THEN 1 ELSE 0 END) v2,
       round(100.0*sum(CASE WHEN mod_version=2 THEN 1 ELSE 0 END)/count(*),1) pct_v2
FROM offers GROUP BY 1 ORDER BY 1;
SELECT max(date_completed) FILTER (WHERE mod_version=1) last_v1_settle FROM offers;


-- ---------------------------------------------------------------------
-- 4. JUNK / SPAM PRICE DETECTOR
--    Definition: single-pair offer whose direction-normalized price deviates
--    from its (pair, month) median by >10x or <1/10x. Only judge pairs with
--    >=20 monthly observations (NFTs are unique assets -> not judgeable).
--    KEY FINDING: spam is RARE in SETTLED data (0.47% at 10x). Junk prices are
--    a posting-side phenomenon; nobody accepts them, so they seldom settle.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE sp AS
SELECT o.id, o.date_completed,
       off.asset_id off_id, off.amount off_amt, off.code off_code,
       req.asset_id req_id, req.amount req_amt, req.code req_code
FROM offers o
JOIN legs off ON o.id=off.offer_id AND off.side='offered'
JOIN legs req ON o.id=req.offer_id AND req.side='requested'
WHERE o.is_single_pair AND off.amount>0 AND req.amount>0;

CREATE OR REPLACE TEMP TABLE norm AS
SELECT id, date_completed,
       CASE WHEN off_id<req_id THEN off_id ELSE req_id END a_lo,
       CASE WHEN off_id<req_id THEN req_id ELSE off_id END a_hi,
       CASE WHEN off_id<req_id THEN coalesce(req_code,'?')||'/'||coalesce(off_code,'?')
            ELSE coalesce(off_code,'?')||'/'||coalesce(req_code,'?') END pair_label,
       CASE WHEN off_id<req_id THEN req_amt/off_amt ELSE off_amt/req_amt END norm_price
FROM sp;

CREATE OR REPLACE TEMP TABLE pm AS
SELECT a_lo, a_hi, strftime(date_completed,'%Y-%m') mo, median(norm_price) med, count(*) cnt
FROM norm GROUP BY 1,2,3;

CREATE OR REPLACE TEMP TABLE judged AS
SELECT n.*, strftime(n.date_completed,'%Y-%m') mo, n.norm_price/m.med AS ratio,
       CASE WHEN n.norm_price>10*m.med OR n.norm_price<m.med/10 THEN 1 ELSE 0 END is_spam
FROM norm n JOIN pm m
  ON n.a_lo=m.a_lo AND n.a_hi=m.a_hi AND strftime(n.date_completed,'%Y-%m')=m.mo
WHERE m.cnt>=20;

-- Single-pair offers that even have a usable price (NFTs mostly don't):
SELECT count(*) single_pair_with_price FROM norm;

-- Threshold sensitivity (% of judged offers flagged):
SELECT count(*) judged,
       round(100.0*sum(CASE WHEN ratio>5    OR ratio<0.2   THEN 1 ELSE 0 END)/count(*),3) pct_5x,
       round(100.0*sum(CASE WHEN ratio>10   OR ratio<0.1   THEN 1 ELSE 0 END)/count(*),3) pct_10x,
       round(100.0*sum(CASE WHEN ratio>100  OR ratio<0.01  THEN 1 ELSE 0 END)/count(*),3) pct_100x,
       round(100.0*sum(CASE WHEN ratio>1000 OR ratio<0.001 THEN 1 ELSE 0 END)/count(*),4) pct_1000x
FROM judged;

-- Spam over time (declines: 1.0% 2022 -> 0.24% 2025).
SELECT year(date_completed) yr, count(*) judged, sum(is_spam) spam,
       round(100.0*sum(is_spam)/count(*),3) pct_spam
FROM judged GROUP BY 1 ORDER BY 1;

-- Which assets attract spam: low-cap meme/illiquid CATs, not liquid pairs.
SELECT any_value(pair_label) pair, count(*) judged, sum(is_spam) spam,
       round(100.0*sum(is_spam)/count(*),2) pct
FROM judged GROUP BY a_lo,a_hi HAVING sum(is_spam)>=20 ORDER BY spam DESC LIMIT 12;


-- ---------------------------------------------------------------------
-- 4b. PARTIAL FILLS / AGGREGATION  (related_offers + mempool_combined + multi-leg)
--    related_offers is an array of OTHER offer ids. Source CSV from
--    research/dexie-offers/analysis/05-related-offers.ts.
--    Findings: 15,307 offers (1.84%) carry a related_offers ref. EVERY
--    referenced id is OUTSIDE this status=4 set (0/17,482 match) -> they point
--    to non-completed sibling offers (partial-fill remainder / replacement).
--    related_offers offers are 100% single-pair, 0% combined, 2.8% pay a fee.
--    related_offers and mempool_combined are mutually exclusive aggregation
--    signals (combined = AMM batch settlement; related = partial-fill chains).
-- ---------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE rel AS
SELECT * FROM read_csv('generated/related-offers.csv', header=true);

-- How many referenced ids exist in our completed set? (0 -> all are siblings.)
SELECT count(*) total_refs,
       sum(CASE WHEN o.id IS NOT NULL THEN 1 ELSE 0 END) ref_in_dataset
FROM rel LEFT JOIN offers o ON rel.related_id=o.id;

-- rel_count distribution: 91% reference exactly 1 sibling.
SELECT rel_count, count(DISTINCT offer_id) n_offers
FROM rel GROUP BY 1 ORDER BY 1;

-- Characterize the offers that have related_offers vs baseline.
WITH r AS (SELECT DISTINCT offer_id FROM rel)
SELECT count(*) n_with_rel,
       round(avg(CASE WHEN is_single_pair THEN 1.0 ELSE 0 END)*100,1) pct_single,
       round(avg(CASE WHEN mempool_combined THEN 1.0 ELSE 0 END)*100,1) pct_combined,
       round(avg(CASE WHEN fees>0 THEN 1.0 ELSE 0 END)*100,1) pct_fee
FROM offers o JOIN r ON o.id=r.offer_id;


-- ---------------------------------------------------------------------
-- 5. TRADE SIZE DISTRIBUTION
--    Retail/micro market: median XCH-leg trade 0.2 XCH; median stablecoin
--    trade $11.42; p99 only ~20 XCH / ~$1000.
-- ---------------------------------------------------------------------
WITH xchval AS (
  SELECT CASE WHEN off.asset_id='xch' THEN off.amount
              WHEN req.asset_id='xch' THEN req.amount END xch_amt
  FROM offers o
  JOIN legs off ON o.id=off.offer_id AND off.side='offered'
  JOIN legs req ON o.id=req.offer_id AND req.side='requested'
  WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch'))
SELECT count(*) n,
       round(quantile_cont(xch_amt,0.10),4) p10, round(quantile_cont(xch_amt,0.25),4) p25,
       round(median(xch_amt),4) p50, round(quantile_cont(xch_amt,0.75),4) p75,
       round(quantile_cont(xch_amt,0.90),4) p90, round(quantile_cont(xch_amt,0.99),4) p99
FROM xchval WHERE xch_amt>0;

WITH usdval AS (
  SELECT CASE WHEN off.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT') THEN off.amount
              WHEN req.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT') THEN req.amount END usd_amt
  FROM offers o
  JOIN legs off ON o.id=off.offer_id AND off.side='offered'
  JOIN legs req ON o.id=req.offer_id AND req.side='requested'
  WHERE o.is_single_pair AND (off.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT')
                           OR req.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT')))
SELECT count(*) n,
       round(quantile_cont(usd_amt,0.10),2) p10, round(quantile_cont(usd_amt,0.25),2) p25,
       round(median(usd_amt),2) p50, round(quantile_cont(usd_amt,0.75),2) p75,
       round(quantile_cont(usd_amt,0.90),2) p90, round(quantile_cont(usd_amt,0.99),2) p99
FROM usdval WHERE usd_amt>0;
