-- =====================================================================
-- O5 — On-chain cost footprint of the offer-file market
-- All numbers in research/dexie-offers/findings/09-onchain-cost.md come from these queries.
-- Run read-only:  ./tools/duckdb -readonly generated/offers.duckdb -c "<query>"
-- Fields: offers.mempool_cost (CLVM program cost, unitless), mempool_fees (mojos),
--         mempool_combined (presence flag = AMM batch settlement), mod_version.
-- mempool_cost may be NULL (pre-2022-10 dexie did not record the mempool block).
-- =====================================================================

-- Q1. Overall coverage of mempool_cost / mempool_fees + date span.
SELECT
  count(*) AS total_offers,
  count(mempool_cost) AS has_cost,
  round(100.0*count(mempool_cost)/count(*),2) AS pct_has_cost,
  count(mempool_fees) AS has_fees,
  round(100.0*count(mempool_fees)/count(*),2) AS pct_has_fees,
  min(date_completed) FILTER (WHERE mempool_cost IS NOT NULL) AS first_cost_date,
  max(date_completed) FILTER (WHERE mempool_cost IS NOT NULL) AS last_cost_date
FROM offers;
-- => 777,712 / 833,145 = 93.35%; mempool_cost & mempool_fees identical coverage;
--    span 2022-10-20 .. 2026-05-23.

-- Q2. Coverage by month (locate the missing 6.65%). [CSV: 09-onchain-cost-coverage-by-month.csv]
SELECT strftime(date_completed,'%Y-%m') AS month,
  count(*) AS offers, count(mempool_cost) AS has_cost,
  round(100.0*count(mempool_cost)/count(*),1) AS pct
FROM offers GROUP BY 1 ORDER BY 1;
-- => 0% before 2022-10 (field not recorded), 48.9% in 2022-10, ~99% from 2022-11 on.
--    Missing rows are almost entirely pre-Oct-2022.

-- Q3. mempool_cost distribution (CLVM cost units).
SELECT count(*) AS n, min(mempool_cost) AS min,
  quantile_cont(mempool_cost,0.10) AS p10, quantile_cont(mempool_cost,0.25) AS p25,
  quantile_cont(mempool_cost,0.50) AS p50, quantile_cont(mempool_cost,0.75) AS p75,
  quantile_cont(mempool_cost,0.90) AS p90, quantile_cont(mempool_cost,0.99) AS p99,
  max(mempool_cost) AS max, round(avg(mempool_cost),0) AS mean
FROM offers WHERE mempool_cost IS NOT NULL;
-- => p50 185.2M, p90 702M, p99 3.81B, max 6.86B, mean 396M (heavy right tail).

-- Q4. Cost by trade-type category (NFT-involved / stablecoin / fungible-only).
WITH cat AS (
  SELECT o.id, o.mempool_cost,
    bool_or(l.is_nft) AS has_nft,
    bool_or(l.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT')) AS has_stable
  FROM offers o JOIN legs l ON l.offer_id=o.id
  WHERE o.mempool_cost IS NOT NULL GROUP BY 1,2
)
SELECT CASE WHEN has_nft THEN 'NFT-involved'
            WHEN has_stable THEN 'stablecoin'
            ELSE 'fungible-only' END AS category,
  count(*) AS n,
  cast(quantile_cont(mempool_cost,0.25) AS bigint) AS p25,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS p50_median,
  cast(quantile_cont(mempool_cost,0.75) AS bigint) AS p75,
  cast(quantile_cont(mempool_cost,0.90) AS bigint) AS p90
FROM cat GROUP BY 1 ORDER BY p50_median;
-- => stablecoin p50 174.6M, NFT p50 176.3M, fungible-only p50 220.8M.
--    NFT is NOT the most expensive at the median (refutes naive hypothesis);
--    stablecoin/fungible have heavier p90 tails (~1.08B) than NFT (357M).

-- Q5. Cost scales with leg count (the dominant structural driver).
SELECT (n_offered+n_requested) AS total_legs, count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median_cost,
  cast(quantile_cont(mempool_cost,0.90) AS bigint) AS p90
FROM offers WHERE mempool_cost IS NOT NULL
GROUP BY 1 ORDER BY 1;
-- => 2 legs 178.8M, 3 legs 306.3M, 4 legs 521M, 5 legs 640M, 6 legs 701M,
--    7 legs 943M ... 32 legs 4.83B. Roughly +130-200M CLVM per extra leg.

-- Q6. At equal leg count (single-pair, 2 legs), does an NFT cost more? No.
WITH c AS (
  SELECT o.id, o.mempool_cost, bool_or(l.is_nft) AS has_nft
  FROM offers o JOIN legs l ON l.offer_id=o.id
  WHERE o.mempool_cost IS NOT NULL AND o.is_single_pair GROUP BY 1,2
)
SELECT has_nft, count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median_cost
FROM c GROUP BY 1;
-- => NFT single-pair p50 173.9M vs non-NFT single-pair 203.7M.
--    NFT spends are CHEAPER than CAT swaps at equal structure; cost comes from
--    CAT puzzle layers, not NFT puzzles.

-- Q7. mempool_combined (AMM batch settlement) vs not.
SELECT coalesce(mempool_combined::varchar,'NULL') AS combined, count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median,
  cast(quantile_cont(mempool_cost,0.90) AS bigint) AS p90,
  cast(quantile_cont(mempool_cost,0.99) AS bigint) AS p99
FROM offers WHERE mempool_cost IS NOT NULL GROUP BY 1 ORDER BY median;
-- => combined=true (n=160,881): p50 232M, p90 2.17B, p99 5.09B.
--    NULL (n=616,831): p50 182M, p90 452M, p99 2.64B. Batch tail is far heavier.

-- Q8. mod_version v1 vs v2.
SELECT mod_version, count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median,
  cast(quantile_cont(mempool_cost,0.90) AS bigint) AS p90
FROM offers WHERE mempool_cost IS NOT NULL GROUP BY 1 ORDER BY 1;
-- => v1 (n=69,166) p50 178.5M; v2 (n=708,546) p50 186.7M. Format barely matters.

-- =====================================================================
-- COST vs FEE  (relate to T5 "fee = block-priority bid")
-- =====================================================================

-- Q9. The two fee fields are the same number: mempool_fees == fees * 1e12 (mojos).
SELECT count(*) AS n,
  count(*) FILTER (WHERE fees=0 AND mempool_fees=0) AS both_zero,
  count(*) FILTER (WHERE fees=0 AND mempool_fees>0) AS humanzero_mempoolpos,
  count(*) FILTER (WHERE fees>0 AND mempool_fees=0) AS humanpos_mempoolzero,
  count(*) FILTER (WHERE fees>0 AND mempool_fees>0) AS both_pos
FROM offers WHERE mempool_cost IS NOT NULL;
-- => 304,251 offers have fees=0 (human XCH) but mempool_fees>0: dust fees round
--    to 0 in the human field. So at mempool granularity only 42.1% pay nothing,
--    vs T5's 81% on the rounded human `fees` field. (Refines T5, not contradicts.)

-- Q10. Is mempool_fees proportional to mempool_cost? (fee-per-cost rationality)
SELECT count(*) FILTER (WHERE mempool_fees=0) AS zero_fee,
  count(*) FILTER (WHERE mempool_fees>0) AS pos_fee, count(*) AS total,
  round(100.0*count(*) FILTER (WHERE mempool_fees=0)/count(*),2) AS pct_zero,
  round(corr(mempool_cost,mempool_fees),4) AS corr_all
FROM offers WHERE mempool_cost IS NOT NULL;
-- => 42.13% zero mempool fee; Pearson corr(cost,fee) = 0.052 (essentially none).

SELECT count(*) AS n_feepayers,
  round(corr(mempool_cost, mempool_fees),3) AS pearson_cost_fee,
  quantile_cont(mempool_fees::double/mempool_cost,0.10) AS feepercost_p10,
  quantile_cont(mempool_fees::double/mempool_cost,0.50) AS feepercost_p50,
  quantile_cont(mempool_fees::double/mempool_cost,0.90) AS feepercost_p90
FROM offers WHERE mempool_cost IS NOT NULL AND mempool_fees > 0;
-- => among 450,094 fee-payers, corr 0.061; fee-per-cost-unit p50 0.67 mojo,
--    spanning p10 4.5e-6 to p90 7.1 (6 orders of magnitude). The fee is NOT a
--    cost-recovery price; it is a near-arbitrary priority bid. Confirms T5.

-- =====================================================================
-- AGGREGATE FOOTPRINT & THE AMM ERA
-- =====================================================================

-- Q11. Monthly total CLVM cost (block-space proxy) + % of Chia capacity.
--      max_block_cost_clvm = 11e9/block. DENOMINATOR FIX (2026-05-24): use the
--      month's ACTUAL block count from spent_block_index (max-min) instead of an
--      assumed block rate. (The earlier 1661 blocks/day / 52s-block assumption was
--      ~2.8x too low — empirically the chain runs ~4,620 blocks/day, matching
--      Chia's ~18.75s target — which had inflated every % by ~2.8x.)
--      [CSV: 18-blockspace-by-month.csv]
SELECT strftime(date_completed,'%Y-%m') AS month,
  count(mempool_cost) AS offers_with_cost,
  sum(mempool_cost) AS total_clvm_cost,
  (max(spent_block_index)-min(spent_block_index)) AS blocks_in_month,
  round(100.0*sum(mempool_cost)/((max(spent_block_index)-min(spent_block_index))*11e9),3) AS pct_blockspace
FROM offers WHERE mempool_cost IS NOT NULL AND spent_block_index IS NOT NULL
GROUP BY 1 HAVING count(*)>150 ORDER BY 1;
-- => Not a constant 3%: a monthly series ~0.2%–1.0% of theoretical block CAPACITY,
--    peaking 1.01% in 2025-07 (tracks volume). NB: capacity, not actual usage —
--    Chia blocks run far below full, so this is not offers' share of real traffic.

-- Q12. Did the AMM era change average cost/trade? (split at AMM-labeling 2025-04)
SELECT CASE WHEN date_completed < '2025-04-01' THEN 'pre-2025-04' ELSE '2025-04+' END AS era,
  count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median_cost,
  round(avg(mempool_cost),0) AS mean_cost
FROM offers WHERE mempool_cost IS NOT NULL GROUP BY 1 ORDER BY 1;
-- => pre p50 191.6M / mean 407M; post p50 176.9M / mean 382M. Essentially flat
--    (slight decrease). AMM dominance did not inflate per-trade cost.

-- Q13. TibetSwap vs non-Tibet cost, 2025-04+ (where taker is labelled).
SELECT coalesce(known_taker_source,'(none)')='tibet2' AS is_tibet, count(*) AS n,
  cast(quantile_cont(mempool_cost,0.50) AS bigint) AS median_cost,
  cast(quantile_cont(mempool_cost,0.90) AS bigint) AS p90
FROM offers WHERE mempool_cost IS NOT NULL AND date_completed>='2025-04-01'
GROUP BY 1;
-- => tibet p50 194.5M / p90 592M; non-tibet p50 171.9M / p90 638M. AMM fills are
--    a touch heavier at the median (the AMM coin spend rides along) but not
--    dramatically so; combined=true is where the heavy-tail batches live (Q7).
