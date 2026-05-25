-- ============================================================================
-- 10-amm-tightening.sql  — Thesis S3: Does an active TibetSwap (AMM) pool TIGHTEN
-- a pair's price (lower within-period price dispersion)?
--
-- This is the rigorous redo of the test that finding 01 (T1) declined to publish
-- (its Caveat #5): a naive AMM-vs-P2P dispersion compare is confounded by the
-- pool price drifting across the months a CAT's tibet2 fills span. The fix is
-- PER-(pair, month) BINNING so we never compare across a drifting level.
--
-- Run read-only:
--   ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/10-amm-tightening.sql
--
-- METHOD / conventions (per project rules):
--   * Universe: single-pair (1x1) offers where one leg is XCH and the other is a
--     NON-NFT (fungible) CAT. Dispersion is only meaningful for fungible pairs
--     (an NFT "price" is per-unique-item). 380,600 offers / 416 CATs.
--   * Direction-normalized price:  p = cat_per_xch = CAT_amount / XCH_amount,
--     rebuilt from the two legs so both directions of the pair combine on one
--     canonical scale (CAT priced against XCH).  XCH amount/CAT amount both > 0.
--   * AMM label: coalesce(known_taker_source,'')='tibet2'  (the NULL trap).
--     tibet2 exists ONLY 2025-04+ (zero coverage before) -> the within-period
--     AMM-vs-P2P split is restricted to date_completed >= 2025-04-01.
--   * Dispersion metric: RELATIVE dispersion, robust to level drift:
--       rel_iqr = (Q75-Q25)/median   (primary)
--       rel_mad = median(|p-median|)/median   (robustness check, Q-A3)
--     MEDIAN/robust only, never mean.
--   * A (pair,month) cell needs a minimum sample to be meaningful; min n stated
--     per query (>=10 each side for the paired split; >=15/>=20 for cell tests).
--
-- COVERAGE CAVEAT (README.md): the per-pair 10k API cap drops the OLDEST
-- offers of the busiest pairs (CAT<->XCH especially) -> early-month sample DEPTH
-- is a floor. Dispersion is a within-month ratio of the offers we DO have, so the
-- level is unaffected; only the thinnest early cells are noisier.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Q0 — Base population sanity (fact). The fungible CAT<->XCH priced universe.
-- ----------------------------------------------------------------------------
WITH base AS (
  SELECT o.id, o.date_completed,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.code AS cat_code,
         c.amount / x.amount AS cat_per_xch
  FROM offers o
  JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0
)
SELECT 'Q0 base' AS q,
       count(*) AS n_offers,
       count(DISTINCT cat_id) AS n_cats,
       count(*) FILTER (WHERE is_tibet) AS n_tibet,
       count(*) FILTER (WHERE date_completed>='2025-04-01') AS n_post_apr,
       count(*) FILTER (WHERE is_tibet AND date_completed>='2025-04-01') AS n_tibet_post_apr
FROM base;


-- ----------------------------------------------------------------------------
-- Q1 — Cell inventory: how many (pair,month) cells exist at each min-n.
-- ----------------------------------------------------------------------------
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         c.asset_id AS cat_id, c.amount/x.amount AS p,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet
  FROM offers o
  JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0
),
cell AS (
  SELECT cat_id, mon, count(*) n, count(*) FILTER (WHERE is_tibet) n_tibet
  FROM base GROUP BY cat_id, mon
)
SELECT 'Q1 cells' AS q,
       count(*) AS n_cells,
       count(*) FILTER (WHERE n>=10) AS cells_ge10,
       count(*) FILTER (WHERE n>=20) AS cells_ge20,
       count(*) FILTER (WHERE mon>='2025-04-01') AS cells_post_apr,
       count(*) FILTER (WHERE mon>='2025-04-01' AND n>=20) AS cells_post_ge20
FROM cell;


-- ============================================================================
-- TEST A — WITHIN-CELL paired AMM-vs-P2P dispersion (THE primary instrument).
-- In the SAME (pair, month) compare rel-dispersion of tibet2 (AMM) fills vs the
-- P2P fills. Pair AND month are both held fixed -> CAT composition and price
-- level/drift cancel out completely. Requires >=10 fills of EACH side in a cell.
-- This is the design finding 01 said was needed and did not run.
-- ============================================================================

-- Q-A1 — monthly, rel_iqr, >=10 each side.
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
grp AS (
  SELECT cat_id, mon, is_tibet, count(*) n, median(p) med,
         quantile_cont(p,0.75)-quantile_cont(p,0.25) AS iqr
  FROM base GROUP BY cat_id, mon, is_tibet
),
rel AS ( SELECT *, iqr/nullif(med,0) AS rel_iqr FROM grp WHERE med>0 ),
paired AS (
  SELECT a.cat_id, a.mon, a.n n_amm, b.n n_p2p, a.rel_iqr amm_rel, b.rel_iqr p2p_rel
  FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.mon=b.mon
  WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=10 AND b.n>=10
)
SELECT 'Q-A1 within-cell monthly (>=10 each)' AS q,
       count(*) n_cells,
       round(median(amm_rel),4) med_amm_rel_iqr,
       round(median(p2p_rel),4) med_p2p_rel_iqr,
       round(median(amm_rel-p2p_rel),4) med_within_diff,
       count(*) FILTER (WHERE amm_rel<p2p_rel) amm_tighter,
       count(*) FILTER (WHERE amm_rel>p2p_rel) p2p_tighter
FROM paired;

-- Q-A2 — same but WEEKLY bins (less intra-period drift; both tighten, sign holds).
WITH base AS (
  SELECT date_trunc('week', o.date_completed) AS wk,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
grp AS (
  SELECT cat_id, wk, is_tibet, count(*) n, median(p) med,
         quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
  FROM base GROUP BY cat_id, wk, is_tibet
),
rel AS ( SELECT *, iqr/nullif(med,0) rel_iqr FROM grp WHERE med>0 ),
paired AS (
  SELECT a.rel_iqr amm, b.rel_iqr p2p FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.wk=b.wk
  WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=10 AND b.n>=10
)
SELECT 'Q-A2 within-cell WEEKLY (>=10 each)' AS q,
       count(*) n_cells, round(median(amm),4) med_amm, round(median(p2p),4) med_p2p,
       count(*) FILTER (WHERE amm<p2p) amm_tighter, count(*) FILTER (WHERE amm>p2p) p2p_tighter
FROM paired;

-- Q-A3 — ROBUSTNESS: rel_mad = MAD/median instead of IQR/median (monthly, >=10).
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
med AS ( SELECT cat_id,mon,is_tibet, median(p) med, count(*) n FROM base GROUP BY 1,2,3 ),
withmed AS ( SELECT b.*, m.med, m.n FROM base b JOIN med m USING(cat_id,mon,is_tibet) ),
grp AS ( SELECT cat_id,mon,is_tibet, any_value(n) n, any_value(med) med,
                median(abs(p-med)) mad FROM withmed GROUP BY 1,2,3 ),
rel AS ( SELECT *, mad/nullif(med,0) rel_mad FROM grp WHERE med>0 ),
paired AS ( SELECT a.rel_mad amm, b.rel_mad p2p FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.mon=b.mon
            WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=10 AND b.n>=10 )
SELECT 'Q-A3 within-cell MAD/median (>=10 each)' AS q,
       count(*) n_cells, round(median(amm),4) med_amm_mad, round(median(p2p),4) med_p2p_mad,
       count(*) FILTER (WHERE amm<p2p) amm_tighter, count(*) FILTER (WHERE amm>p2p) p2p_tighter
FROM paired;

-- Q-A4 — same restricted to HIGH-liquidity cells (>=50 each side). Effect strengthens.
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
grp AS ( SELECT cat_id, mon, is_tibet, count(*) n, median(p) med,
                quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr FROM base GROUP BY 1,2,3 ),
rel AS ( SELECT *, iqr/nullif(med,0) r FROM grp WHERE med>0 ),
paired AS ( SELECT a.r amm, b.r p2p FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.mon=b.mon
            WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=50 AND b.n>=50 )
SELECT 'Q-A4 within-cell monthly (>=50 each, liquid)' AS q,
       count(*) n_cells, round(median(amm),4) med_amm, round(median(p2p),4) med_p2p,
       count(*) FILTER (WHERE amm<p2p) amm_tighter, count(*) FILTER (WHERE amm>p2p) p2p_tighter
FROM paired;

-- Q-A5 — monthly TREND of the within-cell paired test  (CSV: 10-amm-tightening-within-cell-monthly.csv)
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
grp AS ( SELECT cat_id, mon, is_tibet, count(*) n, median(p) med,
                quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr FROM base GROUP BY 1,2,3 ),
rel AS ( SELECT *, iqr/nullif(med,0) r FROM grp WHERE med>0 ),
paired AS ( SELECT a.mon, a.r amm, b.r p2p FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.mon=b.mon
            WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=10 AND b.n>=10 )
SELECT 'Q-A5' AS q, strftime(mon,'%Y-%m') AS ym, count(*) n_cells,
       round(median(amm),4) med_amm_rel_iqr, round(median(p2p),4) med_p2p_rel_iqr,
       count(*) FILTER (WHERE amm<p2p) amm_tighter
FROM paired GROUP BY mon ORDER BY mon;


-- ============================================================================
-- TEST B — CROSS-PAIR cell-intensity (DEMONSTRATES THE CONFOUND; not a verdict).
-- Compare overall cell rel_iqr across AMM-share buckets. Looks like AMM helps,
-- but the "no-AMM" bucket is dominated by ONE peg-like CAT (MJO) with ~0
-- dispersion -> composition, not AMM. Kept to show WHY the cross-pair compare is
-- invalid and the within-cell paired test (Test A) is required.
-- ============================================================================

-- Q-B1 — rel_iqr by AMM-share bucket (post-Apr, cell n>=20).
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
cell AS (
  SELECT cat_id, mon, count(*) n,
         avg(CASE WHEN is_tibet THEN 1.0 ELSE 0 END) amm_share,
         median(p) med, quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
  FROM base GROUP BY cat_id, mon HAVING count(*)>=20 AND median(p)>0
),
b AS ( SELECT *, iqr/med rel_iqr,
         CASE WHEN amm_share<0.05 THEN '0_none(<5%)'
              WHEN amm_share<0.33 THEN '1_low(5-33%)'
              WHEN amm_share<0.66 THEN '2_mid(33-66%)'
              ELSE '3_high(>=66%)' END AS amm_bucket
       FROM cell )
SELECT 'Q-B1 cross-pair intensity (CONFOUNDED)' AS q,
       amm_bucket, count(*) n_cells, round(median(rel_iqr),4) med_rel_iqr, median(n) med_n
FROM b GROUP BY amm_bucket ORDER BY amm_bucket;

-- Q-B2 — what's IN the no-AMM bucket: one peg-like CAT (MJO) drives the 0 dispersion.
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.code code, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
cell AS (
  SELECT cat_id, any_value(code) code, mon, count(*) n,
         avg(CASE WHEN is_tibet THEN 1.0 ELSE 0 END) amm_share,
         median(p) med, quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
  FROM base GROUP BY cat_id, mon HAVING count(*)>=20 AND median(p)>0
)
SELECT 'Q-B2 no-AMM bucket composition' AS q, code, count(*) n_cells,
       round(median(iqr/med),4) rel_iqr
FROM cell WHERE amm_share<0.05 GROUP BY code ORDER BY n_cells DESC;


-- ============================================================================
-- TEST C — EVENT STUDY: pairs that TRANSITION from no-AMM to AMM. For each CAT,
-- find its first month with AMM activity (>=3 tibet2 fills); compare that CAT's
-- own rel_iqr in pre-AMM vs post-AMM months. Per-CAT paired -> composition
-- controlled. BUT must be read against the placebo (Test D): markets mature.
-- ============================================================================

-- Q-C1 — within-CAT pre vs post first-AMM month (CATs with >=2 cells each side).
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0
),
cell AS (
  SELECT cat_id, mon, count(*) n, count(*) FILTER (WHERE is_tibet) n_tibet,
         median(p) med, quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
  FROM base GROUP BY cat_id, mon HAVING count(*)>=15 AND median(p)>0
),
cellr AS ( SELECT *, iqr/med rel_iqr FROM cell ),
firstamm AS ( SELECT cat_id, min(mon) first_amm_mon FROM cellr WHERE n_tibet>=3 GROUP BY cat_id ),
tagged AS ( SELECT c.cat_id, c.rel_iqr, (c.mon>=f.first_amm_mon) is_post
            FROM cellr c JOIN firstamm f USING(cat_id) ),
perc AS (
  SELECT cat_id,
    median(rel_iqr) FILTER (WHERE NOT is_post) pre_rel,
    median(rel_iqr) FILTER (WHERE is_post) post_rel,
    count(*) FILTER (WHERE NOT is_post) n_pre,
    count(*) FILTER (WHERE is_post) n_post
  FROM tagged GROUP BY cat_id
)
SELECT 'Q-C1 event study (within-CAT, >=2 cells each side)' AS q,
       count(*) FILTER (WHERE n_pre>=2 AND n_post>=2) n_cats,
       round(median(pre_rel)  FILTER (WHERE n_pre>=2 AND n_post>=2),4) med_pre,
       round(median(post_rel) FILTER (WHERE n_pre>=2 AND n_post>=2),4) med_post,
       round(median(post_rel-pre_rel) FILTER (WHERE n_pre>=2 AND n_post>=2),4) med_within_diff,
       count(*) FILTER (WHERE n_pre>=2 AND n_post>=2 AND post_rel<pre_rel) tighter_after,
       count(*) FILTER (WHERE n_pre>=2 AND n_post>=2 AND post_rel>pre_rel) wider_after
FROM perc;


-- ============================================================================
-- TEST D — PLACEBO for the event study: CATs that NEVER get a tibet2 fill. Split
-- each such CAT's life at the median month and compare early vs late half. If
-- non-AMM CATs ALSO tighten, the Test-C drop is market maturation, NOT the AMM.
-- ============================================================================

-- Q-D1 — within-CAT early vs late half, non-AMM CATs only (>=4 cells).
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, c.amount/x.amount AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0
),
cell AS (
  SELECT cat_id, mon, count(*) n, count(*) FILTER (WHERE is_tibet) n_tibet,
         median(p) med, quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
  FROM base GROUP BY cat_id, mon HAVING count(*)>=15 AND median(p)>0
),
cellr AS ( SELECT *, iqr/med rel_iqr, row_number() OVER (PARTITION BY cat_id ORDER BY mon) rn,
                  count(*) OVER (PARTITION BY cat_id) tot FROM cell ),
neveramm AS ( SELECT cat_id FROM cellr GROUP BY cat_id HAVING sum(n_tibet)=0 AND count(*)>=4 ),
split AS ( SELECT c.cat_id, c.rel_iqr, (c.rn > c.tot/2.0) is_late
           FROM cellr c JOIN neveramm n USING(cat_id) ),
perc AS ( SELECT cat_id,
            median(rel_iqr) FILTER (WHERE NOT is_late) early_rel,
            median(rel_iqr) FILTER (WHERE is_late) late_rel
          FROM split GROUP BY cat_id )
SELECT 'Q-D1 PLACEBO non-AMM CATs early-vs-late' AS q,
       count(*) n_cats, round(median(early_rel),4) med_early, round(median(late_rel),4) med_late,
       round(median(late_rel-early_rel),4) med_diff,
       count(*) FILTER (WHERE late_rel<early_rel) tighter_late,
       count(*) FILTER (WHERE late_rel>early_rel) wider_late
FROM perc;


-- ============================================================================
-- TEST E — mechanism check: WHY are AMM fills not tighter? The AMM emits a
-- distinct continuous quote per trade (tracks every intra-period move), while
-- P2P clusters on repeated/round prices. Modal-price concentration per cell.
-- ============================================================================
WITH base AS (
  SELECT date_trunc('month', o.date_completed) AS mon,
         coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
         c.asset_id AS cat_id, round(c.amount/x.amount, 6) AS p
  FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
  JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
  WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
),
pc AS ( SELECT cat_id, mon, is_tibet, p, count(*) c FROM base GROUP BY 1,2,3,4 ),
modal AS ( SELECT cat_id, mon, is_tibet, max(c) modal_c, sum(c) tot,
                  count(DISTINCT p) n_distinct FROM pc GROUP BY 1,2,3 )
SELECT 'Q-E1 modal-price concentration' AS q, is_tibet,
       round(median(modal_c::double/tot),4) med_modal_share,
       round(median(n_distinct::double/tot),4) med_distinct_ratio
FROM modal WHERE tot>=20 GROUP BY is_tibet ORDER BY is_tibet;


-- ============================================================================
-- CSV EXPORTS
-- ============================================================================

-- CSV 1 — within-cell paired detail (one row per paired (pair,month) cell, monthly, >=10 each).
COPY (
  WITH base AS (
    SELECT date_trunc('month', o.date_completed) AS mon,
           coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
           c.asset_id AS cat_id, any_value(c.code) OVER (PARTITION BY c.asset_id) code,
           c.amount/x.amount AS p
    FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
    JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
    WHERE o.is_single_pair AND x.amount>0 AND c.amount>0 AND o.date_completed>='2025-04-01'
  ),
  grp AS ( SELECT cat_id, any_value(code) code, mon, is_tibet, count(*) n, median(p) med,
                  quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr FROM base GROUP BY cat_id,mon,is_tibet ),
  rel AS ( SELECT *, iqr/nullif(med,0) rel_iqr FROM grp WHERE med>0 )
  SELECT a.code, strftime(a.mon,'%Y-%m') AS ym, a.n AS n_amm, b.n AS n_p2p,
         round(a.rel_iqr,5) amm_rel_iqr, round(b.rel_iqr,5) p2p_rel_iqr,
         (a.rel_iqr<b.rel_iqr) AS amm_tighter
  FROM rel a JOIN rel b ON a.cat_id=b.cat_id AND a.mon=b.mon
  WHERE a.is_tibet AND NOT b.is_tibet AND a.n>=10 AND b.n>=10
  ORDER BY a.mon, a.code
) TO 'research/dexie-offers/findings/data/10-amm-tightening-within-cell-paired.csv' (HEADER, DELIMITER ',');

-- CSV 2 — event-study per-CAT pre/post detail (CATs with >=2 cells each side).
COPY (
  WITH base AS (
    SELECT date_trunc('month', o.date_completed) AS mon,
           coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
           c.asset_id AS cat_id, any_value(c.code) OVER (PARTITION BY c.asset_id) code,
           c.amount/x.amount AS p
    FROM offers o JOIN legs x ON x.offer_id=o.id AND x.asset_id='xch'
    JOIN legs c ON c.offer_id=o.id AND c.asset_id<>'xch' AND NOT c.is_nft
    WHERE o.is_single_pair AND x.amount>0 AND c.amount>0
  ),
  cell AS ( SELECT cat_id, any_value(code) code, mon, count(*) n, count(*) FILTER (WHERE is_tibet) n_tibet,
                   median(p) med, quantile_cont(p,0.75)-quantile_cont(p,0.25) iqr
            FROM base GROUP BY cat_id,mon HAVING count(*)>=15 AND median(p)>0 ),
  cellr AS ( SELECT *, iqr/med rel_iqr FROM cell ),
  firstamm AS ( SELECT cat_id, min(mon) first_amm_mon FROM cellr WHERE n_tibet>=3 GROUP BY cat_id ),
  tagged AS ( SELECT c.cat_id, c.code, c.rel_iqr, (c.mon>=f.first_amm_mon) is_post
              FROM cellr c JOIN firstamm f USING(cat_id) ),
  perc AS ( SELECT cat_id, any_value(code) code,
              median(rel_iqr) FILTER (WHERE NOT is_post) pre_rel,
              median(rel_iqr) FILTER (WHERE is_post) post_rel,
              count(*) FILTER (WHERE NOT is_post) n_pre,
              count(*) FILTER (WHERE is_post) n_post
            FROM tagged GROUP BY cat_id )
  SELECT code, n_pre, n_post, round(pre_rel,5) pre_rel_iqr, round(post_rel,5) post_rel_iqr,
         (post_rel<pre_rel) AS tighter_after
  FROM perc WHERE n_pre>=2 AND n_post>=2 ORDER BY (post_rel-pre_rel)
) TO 'research/dexie-offers/findings/data/10-amm-tightening-event-study.csv' (HEADER, DELIMITER ',');
