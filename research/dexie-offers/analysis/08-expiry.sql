-- 08-expiry.sql — Thesis O4: offer expiry as a sophistication/automation signal,
-- and how it sharpens the two-markets (fast-AMM vs slow-NFT) picture.
--
-- Substrate: generated/offers.duckdb (833,145 completed offers, snapshot 2026-05-23).
-- Run read-only:  ./tools/duckdb -readonly generated/offers.duckdb -c "<query>"
--
-- Caveats baked into interpretation (see research/dexie-offers/findings/08-expiry.md):
--   * 84.7% coverage, biased to dropping the oldest offers of the busiest pairs.
--   * date_found is dexie's FIRST-SEEN, not creation. Time-to-fill is first-seen->settled,
--     a floor on true resting time. Rows with date_completed < date_found excluded from TTF.
--   * known_taker_source ('tibet2') only recorded from 2025-04; tibet correlations
--     restricted to that era.
--   * date_expiry and block_expiry are MUTUALLY EXCLUSIVE in this data (0 offers have both).

------------------------------------------------------------------------
-- Q1. Overall coverage. date_expiry vs block_expiry vs neither (mutually exclusive).
------------------------------------------------------------------------
SELECT
  count(*) AS total,
  count(date_expiry)  AS has_date_expiry,
  count(block_expiry) AS has_block_expiry,
  sum(CASE WHEN date_expiry IS NOT NULL AND block_expiry IS NOT NULL THEN 1 ELSE 0 END) AS has_both,
  sum(CASE WHEN date_expiry IS NULL AND block_expiry IS NULL THEN 1 ELSE 0 END)         AS has_neither
FROM offers;
-- -> total 833145 | date 61524 (7.39%) | block 4804 (0.58%) | both 0 | neither 766817 (92.04%)

------------------------------------------------------------------------
-- Q2. date_expiry is a genuine forward-looking TTL (median ~1 day after settlement).
--     355 settled at/after stated expiry (clock/indexing edge cases). Only 1 far-future sentinel.
------------------------------------------------------------------------
SELECT
  count(*) AS n,
  median(epoch(date_expiry) - epoch(date_completed)) AS med_secs_to_expiry,  -- 86305 (~1 day)
  quantile_cont(epoch(date_expiry) - epoch(date_completed), 0.10) AS p10,    -- 866 s
  quantile_cont(epoch(date_expiry) - epoch(date_completed), 0.90) AS p90,    -- 604726 s (~7 d)
  sum(CASE WHEN date_expiry > date_completed THEN 1 ELSE 0 END) AS expiry_after_settle, -- 61169
  sum(CASE WHEN date_expiry > '2100-01-01' THEN 1 ELSE 0 END)   AS far_future_sentinels -- 1
FROM offers WHERE date_expiry IS NOT NULL;

-- block_expiry: block-height TTL; min 4,560,518 max 8,762,840; 100 settled past block_expiry.
SELECT count(*) n, min(block_expiry) min_be, max(block_expiry) max_be,
  sum(CASE WHEN block_expiry < spent_block_index THEN 1 ELSE 0 END) settled_after_block_expiry
FROM offers WHERE block_expiry IS NOT NULL;

------------------------------------------------------------------------
-- Q3. Coverage over time (monthly). Zero before 2023-09; first date_expiry 2023-09-26,
--     first block_expiry 2023-11-22. Slow ramp to ~5%, then a sharp NFT-driven spike to
--     43% in 2025-09, relaxing to ~16% by 2026-05.
--     Full series exported: research/dexie-offers/findings/data/08-expiry-coverage-by-month.csv
------------------------------------------------------------------------
SELECT
  strftime(date_completed, '%Y-%m') AS month,
  count(*) AS n,
  round(100.0*sum(CASE WHEN date_expiry  IS NOT NULL THEN 1 ELSE 0 END)/count(*),2) AS pct_date_expiry,
  round(100.0*sum(CASE WHEN block_expiry IS NOT NULL THEN 1 ELSE 0 END)/count(*),2) AS pct_block_expiry,
  round(100.0*sum(CASE WHEN date_expiry IS NOT NULL OR block_expiry IS NOT NULL THEN 1 ELSE 0 END)/count(*),2) AS pct_any
FROM offers GROUP BY 1 ORDER BY 1;

------------------------------------------------------------------------
-- Q4. Expiry-setting rate by segment. NOTE: aggregate is time-confounded (expiry only
--     existed from late 2023; NFT volume / the go4.me wave land in the high-expiry era).
--     Surprise vs naive thesis: NFT-involved set expiry MORE than fungible-only.
------------------------------------------------------------------------
WITH nft AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft),
o AS (
  SELECT off.*,
    (off.date_expiry IS NOT NULL OR off.block_expiry IS NOT NULL) AS has_expiry,
    (nft.offer_id IS NOT NULL) AS is_nft,
    (off.fees > 0) AS paid_fee
  FROM offers off LEFT JOIN nft ON nft.offer_id = off.id
)
SELECT 'NFT-involved'  AS segment, count(*) n, round(100.0*avg(has_expiry::int),2) pct_expiry FROM o WHERE is_nft
UNION ALL SELECT 'fungible-only', count(*), round(100.0*avg(has_expiry::int),2) FROM o WHERE NOT is_nft
UNION ALL SELECT 'single-pair',   count(*), round(100.0*avg(has_expiry::int),2) FROM o WHERE is_single_pair
UNION ALL SELECT 'multi-leg',     count(*), round(100.0*avg(has_expiry::int),2) FROM o WHERE NOT is_single_pair
UNION ALL SELECT 'fee-paying',    count(*), round(100.0*avg(has_expiry::int),2) FROM o WHERE paid_fee
UNION ALL SELECT 'zero-fee',      count(*), round(100.0*avg(has_expiry::int),2) FROM o WHERE NOT paid_fee
ORDER BY segment;
-- -> NFT 11.74% | fungible 5.64% | single-pair 8.72% | multi-leg 1.34% | fee-paying 7.83% | zero-fee 7.99%

------------------------------------------------------------------------
-- Q5. THE KEY TEST: tibet AMM vs non-tibet, in the labeled era (2025-04+).
--     The fast-AMM cluster does NOT set date_expiry (5.39%); the human/non-AMM side does (20.26%).
--     => expiry is the OPPOSITE of an AMM-bot signal. block_expiry ~equal (~1%) both sides.
------------------------------------------------------------------------
WITH o AS (
  SELECT *,
    coalesce(known_taker_source,'')='tibet2' AS is_tibet
  FROM offers WHERE date_completed >= '2025-04-01'
)
SELECT CASE WHEN is_tibet THEN 'tibet AMM' ELSE 'non-tibet' END AS taker,
  count(*) n,
  round(100.0*avg((date_expiry IS NOT NULL OR block_expiry IS NOT NULL)::int),2) pct_any_expiry,
  round(100.0*avg((date_expiry  IS NOT NULL)::int),2) pct_date_expiry,
  round(100.0*avg((block_expiry IS NOT NULL)::int),2) pct_block_expiry
FROM o GROUP BY is_tibet ORDER BY is_tibet;
-- -> non-tibet n=190918 any 21.17% date 20.26% block 0.92% ; tibet n=163603 any 6.44% date 5.39% block 1.06%

------------------------------------------------------------------------
-- Q6. What drove the 2025-08..11 date_expiry spike? NFT listings (47% of NFT offers),
--     concentrated in the go4.me / G4M ecosystem (TIBET-G4M-XCH + G4M legs). A tooling wave.
------------------------------------------------------------------------
WITH nft AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft),
o AS (
  SELECT off.*, (off.date_expiry IS NOT NULL) AS de, (nft.offer_id IS NOT NULL) AS is_nft
  FROM offers off LEFT JOIN nft ON nft.offer_id=off.id
  WHERE date_completed >= '2025-08-01' AND date_completed < '2025-12-01'
)
SELECT CASE WHEN is_nft THEN 'NFT' ELSE 'fungible' END cat,
  count(*) n, sum(de::int) with_date_expiry, round(100.0*avg(de::int),2) pct_date_expiry
FROM o GROUP BY 1 ORDER BY 1;
-- -> NFT 67932 / 47.21% ; fungible 60584 / 3.42%

-- Top asset codes among date_expiry offers in the spike window (G4M ecosystem dominant):
SELECT l.code, count(DISTINCT l.offer_id) n_offers
FROM legs l JOIN offers o ON o.id=l.offer_id
WHERE o.date_expiry IS NOT NULL AND o.date_completed>='2025-08-01' AND o.date_completed<'2025-12-01'
GROUP BY 1 ORDER BY 2 DESC LIMIT 15;

------------------------------------------------------------------------
-- Q7. Time-to-fill by expiry presence (exclude date_completed < date_found).
--     Median is faster WITH expiry, but sub-minute share is LOWER. The speedup comes
--     from truncating the long resting tail (>30d), NOT from being faster bots.
------------------------------------------------------------------------
WITH o AS (
  SELECT *,
    (date_expiry IS NOT NULL) AS has_date_exp,
    (block_expiry IS NOT NULL) AS has_block_exp,
    epoch(date_completed)-epoch(date_found) AS ttf
  FROM offers WHERE date_completed >= date_found
)
SELECT
  CASE WHEN has_block_exp THEN 'block_expiry' WHEN has_date_exp THEN 'date_expiry' ELSE 'no expiry' END grp,
  count(*) n, round(median(ttf),0) med_ttf_s,
  round(100.0*avg((ttf<60)::int),1) pct_sub_min,
  round(100.0*avg((ttf>2592000)::int),1) pct_over_30d
FROM o GROUP BY 1 ORDER BY med_ttf_s;
-- -> block 262s/25.8%/0.0% | date 770s/30.2%/1.2% | none 2824s/32.5%/15.6%

------------------------------------------------------------------------
-- Q8. CONTROLLED for category: expiry's effect is concentrated in NFTs.
--     Fungible: expiry barely moves median (71s vs 73s) or sub-min (46.6 vs 46.3).
--     NFT: expiry-setters fill MUCH faster (4574s vs 129695s), sub-min 7.9->17.5,
--          >30d tail 29.7->1.7. => expiry separates a tooled NFT sub-market from hand-listing.
------------------------------------------------------------------------
WITH nft AS (SELECT DISTINCT offer_id FROM legs WHERE is_nft),
o AS (
  SELECT off.*, (off.date_expiry IS NOT NULL OR off.block_expiry IS NOT NULL) AS has_expiry,
    (nft.offer_id IS NOT NULL) AS is_nft,
    epoch(date_completed)-epoch(date_found) AS ttf
  FROM offers off LEFT JOIN nft ON nft.offer_id=off.id
  WHERE date_completed >= date_found
)
SELECT CASE WHEN is_nft THEN 'NFT' ELSE 'fungible' END cat, has_expiry,
  count(*) n, round(median(ttf),0) med_ttf_s,
  round(100.0*avg((ttf<60)::int),1) pct_sub_min,
  round(100.0*avg((ttf>2592000)::int),1) pct_over_30d
FROM o GROUP BY 1,2 ORDER BY 1,2;

------------------------------------------------------------------------
-- Q9. How close to expiry did expiring offers actually settle?
--     Mostly with huge slack: median ~1 day of headroom left, only 3% settled in the last
--     10% of their window, 1.7% within 60s. Expiry is a safety TTL that usually goes unused.
------------------------------------------------------------------------
WITH o AS (
  SELECT *,
    epoch(date_expiry)-epoch(date_found)     AS life_s,
    epoch(date_completed)-epoch(date_found)  AS elapsed_s,
    epoch(date_expiry)-epoch(date_completed) AS slack_s
  FROM offers
  WHERE date_expiry IS NOT NULL AND date_completed >= date_found AND date_expiry > date_found
)
SELECT count(*) n,
  round(median(life_s/3600.0),2) med_life_hr,                       -- 27.57 hr
  round(median(slack_s),0) med_slack_s,                             -- 86305 s (~1 d)
  round(100.0*avg((elapsed_s::double/life_s > 0.9)::int),1)  pct_settled_last_10pct, -- 3.0
  round(100.0*avg((elapsed_s::double/life_s > 0.99)::int),1) pct_settled_last_1pct,  -- 0.9
  round(100.0*avg((slack_s < 60)::int),1)  pct_within_60s_of_expiry,   -- 1.7
  round(100.0*avg((slack_s < 600)::int),1) pct_within_10min_of_expiry  -- 6.6
FROM o;

-- Distribution of chosen expiry lifetimes (date_expiry - date_found): mode is 1-7 days.
WITH o AS (
  SELECT epoch(date_expiry)-epoch(date_found) AS life_s
  FROM offers WHERE date_expiry IS NOT NULL AND date_expiry > date_found AND date_completed >= date_found
)
SELECT CASE
    WHEN life_s < 600 THEN 'a <10 min' WHEN life_s < 3600 THEN 'b 10-60 min'
    WHEN life_s < 86400 THEN 'c 1-24 hr' WHEN life_s < 604800 THEN 'd 1-7 day'
    WHEN life_s < 2592000 THEN 'e 7-30 day' ELSE 'f >30 day' END bucket,
  count(*) n
FROM o GROUP BY 1 ORDER BY 1;
-- -> <10m 3032 | 10-60m 7479 | 1-24h 12431 | 1-7d 32347 | 7-30d 1926 | >30d 3481

------------------------------------------------------------------------
-- Q10 (CSV export). Monthly coverage series for the chart (53 rows > 30).
------------------------------------------------------------------------
COPY (
  SELECT strftime(date_completed, '%Y-%m') AS month, count(*) AS n,
    round(100.0*sum(CASE WHEN date_expiry  IS NOT NULL THEN 1 ELSE 0 END)/count(*),3) AS pct_date_expiry,
    round(100.0*sum(CASE WHEN block_expiry IS NOT NULL THEN 1 ELSE 0 END)/count(*),3) AS pct_block_expiry,
    round(100.0*sum(CASE WHEN date_expiry IS NOT NULL OR block_expiry IS NOT NULL THEN 1 ELSE 0 END)/count(*),3) AS pct_any_expiry
  FROM offers GROUP BY 1 ORDER BY 1
) TO 'research/dexie-offers/findings/data/08-expiry-coverage-by-month.csv' (HEADER, DELIMITER ',');
