-- ============================================================================
-- 03-price-oracle.sql  (Thesis T3: completed offers as a price oracle)
--
-- Reconstruct XCH/USD from settled single-pair XCH<->stablecoin offers and
-- assess oracle quality. Run read-only so the other agents aren't locked:
--   ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/03-price-oracle.sql
--
-- Tables: offers (1 row/offer), legs (1 row/offer x side x leg).
--
-- NORMALIZATION (the load-bearing step):
--   price = requested.amount / offered.amount (verified == offers.price, 98.9% of
--   single-pair offers match exactly; rest are multi-decimal rounding / junk).
--   For a USD/XCH series, half the offers are the reverse direction:
--     - XCH offered  (selling XCH): USD/XCH = requested(USD)/offered(XCH)  -> use as-is
--     - XCH requested (buying  XCH): USD/XCH = offered(USD)/requested(XCH)  -> invert price
--   We rebuild from the two legs directly so direction is explicit.
--
-- STABLECOIN UNIVERSE: only the warp.green wrapped tokens are real ~$1 pegs in
-- this data (validated in Q2 below). USDSC is EXCLUDED -- it does not track USD
-- at all (median ~$500/XCH, ratio to wUSDC.b drifts 5x..200x; not a peg).
--   TRUSTED: wUSDC.b (fa4a18..), wUSDC (bbb51b..), wUSDT (634f9f..)
--   REJECTED: USDSC (6d95da..), and all TIBET-*USD*-XCH (LP tokens, not $1)
-- ============================================================================

-- Reusable building blocks are inlined per query (DuckDB CLI has no persistent
-- temp across statements when piped); the WITH header is repeated. Keep in sync.

-- ----------------------------------------------------------------------------
-- Q0. Stablecoin universe: every USD-coded asset, volume, span.
-- ----------------------------------------------------------------------------
SELECT '--- Q0 stablecoin universe ---' AS q;
SELECT code, asset_id, count(*) AS n_legs, count(DISTINCT offer_id) AS n_offers,
       min(date_completed)::date AS first_seen, max(date_completed)::date AS last_seen
FROM legs WHERE code ILIKE '%USD%'
GROUP BY code, asset_id ORDER BY n_legs DESC;

-- ----------------------------------------------------------------------------
-- Q1. Direction split for trusted XCH<->stablecoin single-pair offers.
--     (the 9998 values are the per-pair 10k API cap -> early tail truncated)
-- ----------------------------------------------------------------------------
SELECT '--- Q1 direction split (trusted coins) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0)
SELECT sc.code,
       CASE WHEN off.asset_id='xch' THEN 'sell_XCH' ELSE 'buy_XCH' END AS dir,
       count(*) AS n
FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
  AND sc.code IN ('wUSDC.b','wUSDC','wUSDT')
GROUP BY 1,2 ORDER BY 1,2;

-- ----------------------------------------------------------------------------
-- Q2. STABLECOIN VALIDATION. Same-month median USD/XCH per code. The warp coins
--     must agree with each other; USDSC must be flagged. (The verdict.)
-- ----------------------------------------------------------------------------
SELECT '--- Q2 stablecoin cross-check (monthly median USD/XCH) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     norm AS (
       SELECT sc.code, o.date_completed,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT','USDSC') AND p>0)
SELECT strftime(date_completed,'%Y-%m') AS mo,
       round(median(p) FILTER (WHERE code='wUSDC.b'),2) AS wUSDCb,
       round(median(p) FILTER (WHERE code='wUSDC'),2)   AS wUSDC,
       round(median(p) FILTER (WHERE code='wUSDT'),2)   AS wUSDT,
       round(median(p) FILTER (WHERE code='USDSC'),1)   AS USDSC_junk,
       count(*) FILTER (WHERE code<>'USDSC')            AS n_warp
FROM norm GROUP BY 1 ORDER BY 1;

-- ----------------------------------------------------------------------------
-- Q3. Junk / dispersion bounds for the trusted series (whole-period quantiles).
-- ----------------------------------------------------------------------------
SELECT '--- Q3 trusted-series distribution ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     norm AS (
       SELECT CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0)
SELECT count(*) AS n,
       round(quantile_cont(p,0.01),3) AS p01, round(quantile_cont(p,0.05),3) AS p05,
       round(quantile_cont(p,0.50),3) AS p50, round(quantile_cont(p,0.95),3) AS p95,
       round(quantile_cont(p,0.99),3) AS p99, round(max(p),1) AS mx
FROM norm;

-- ----------------------------------------------------------------------------
-- Q4. SPAM RATE. Adaptive per-day band: an offer is "spam/junk" if its price is
--     outside [0.2x, 5x] of the day's raw median (catches >5x mispriced offers).
--     Also report a tight [0.5x,2x] band to size honest dispersion.
-- ----------------------------------------------------------------------------
SELECT '--- Q4 spam rate (adaptive daily band) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
     dm AS (SELECT d, median(p) AS dmed FROM base GROUP BY d)
SELECT count(*) AS total,
       sum(CASE WHEN p<0.2*dmed OR p>5*dmed THEN 1 ELSE 0 END) AS spam_5x,
       round(100.0*sum(CASE WHEN p<0.2*dmed OR p>5*dmed THEN 1 ELSE 0 END)/count(*),2) AS spam_5x_pct,
       round(100.0*sum(CASE WHEN p<0.5*dmed OR p>2*dmed THEN 1 ELSE 0 END)/count(*),2) AS outside_2x_pct
FROM base JOIN dm USING(d);

-- ----------------------------------------------------------------------------
-- Q5. WEEKLY series (CSV export driver). Trimmed median + IQR + sample count.
--     Trim: keep prices in [0.2x,5x] of the week's raw median, then aggregate.
-- ----------------------------------------------------------------------------
SELECT '--- Q5 weekly series (preview) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT date_trunc('week', o.date_completed)::date AS wk,
              CASE WHEN off.asset_id='xch' THEN 'sell' ELSE 'buy' END AS dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
     wm AS (SELECT wk, median(p) AS wmed FROM base GROUP BY wk),
     trimmed AS (SELECT b.wk, b.dir, b.p FROM base b JOIN wm USING(wk)
                 WHERE b.p BETWEEN 0.2*wmed AND 5*wmed)
SELECT wk, count(*) AS n,
       round(median(p),3) AS usd_per_xch,
       round(quantile_cont(p,0.25),3) AS q25,
       round(quantile_cont(p,0.75),3) AS q75,
       round(median(p) FILTER (WHERE dir='sell'),3) AS sell_med,
       round(median(p) FILTER (WHERE dir='buy'),3)  AS buy_med,
       count(*) FILTER (WHERE dir='sell') AS n_sell,
       count(*) FILTER (WHERE dir='buy')  AS n_buy
FROM trimmed GROUP BY wk ORDER BY wk;

-- ----------------------------------------------------------------------------
-- Q6. BID/ASK SPREAD over time (monthly). sell_med = XCH-sellers' ask (USD they
--     want per XCH); buy_med = XCH-buyers' bid. Spread% = (sell-buy)/mid.
--     A negative or near-zero spread = healthy two-sided market.
-- ----------------------------------------------------------------------------
SELECT '--- Q6 monthly bid/ask spread ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT strftime(o.date_completed,'%Y-%m') AS mo,
              CASE WHEN off.asset_id='xch' THEN 'sell' ELSE 'buy' END AS dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
     mm AS (SELECT mo, median(p) AS mmed FROM base GROUP BY mo),
     t AS (SELECT b.* FROM base b JOIN mm USING(mo) WHERE b.p BETWEEN 0.2*mmed AND 5*mmed)
SELECT mo,
       count(*) FILTER (WHERE dir='sell') AS n_sell,
       count(*) FILTER (WHERE dir='buy')  AS n_buy,
       round(median(p) FILTER (WHERE dir='sell'),3) AS ask,
       round(median(p) FILTER (WHERE dir='buy'),3)  AS bid,
       round(100.0*(median(p) FILTER (WHERE dir='sell') - median(p) FILTER (WHERE dir='buy'))
             / median(p),2) AS spread_pct
FROM t GROUP BY mo HAVING n_sell>=5 AND n_buy>=5 ORDER BY mo;

-- ----------------------------------------------------------------------------
-- Q7. HOW MANY TRADES/DAY for a stable median? Daily relative dispersion
--     (IQR / median) bucketed by daily sample size. More trades -> tighter.
-- ----------------------------------------------------------------------------
SELECT '--- Q7 daily IQR/median vs daily sample size ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
     dm AS (SELECT d, median(p) AS dmed FROM base GROUP BY d),
     t AS (SELECT b.d, b.p FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dmed AND 5*dmed),
     daily AS (
       SELECT d, count(*) AS n,
              (quantile_cont(p,0.75)-quantile_cont(p,0.25))/median(p) AS rel_iqr
       FROM t GROUP BY d)
SELECT CASE WHEN n<3 THEN '1-2' WHEN n<6 THEN '3-5' WHEN n<11 THEN '6-10'
            WHEN n<21 THEN '11-20' WHEN n<51 THEN '21-50' ELSE '51+' END AS trades_per_day,
       count(*) AS n_days, round(avg(rel_iqr),3) AS mean_rel_iqr,
       round(median(rel_iqr),3) AS median_rel_iqr
FROM daily GROUP BY 1
ORDER BY CASE trades_per_day WHEN '1-2' THEN 1 WHEN '3-5' THEN 2 WHEN '6-10' THEN 3
         WHEN '11-20' THEN 4 WHEN '21-50' THEN 5 ELSE 6 END;

-- ----------------------------------------------------------------------------
-- Q8. DAILY series summary (coverage of days, recent stability). CSV-exported.
-- ----------------------------------------------------------------------------
SELECT '--- Q8 daily series coverage ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
     dm AS (SELECT d, median(p) AS dmed FROM base GROUP BY d),
     t AS (SELECT b.d, b.p FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dmed AND 5*dmed),
     daily AS (SELECT d, count(*) n FROM t GROUP BY d)
SELECT min(d) AS first_day, max(d) AS last_day, count(*) AS days_with_data,
       (max(d)-min(d)+1) AS calendar_days,
       round(avg(n),1) AS avg_trades_per_active_day,
       sum(CASE WHEN n>=5 THEN 1 ELSE 0 END) AS days_ge5_trades
FROM daily;

-- ----------------------------------------------------------------------------
-- Q9. TRIANGULATION consistency check. Implied XCH/USD via XCH<->BYC and
--     BYC<->USD, monthly, vs the direct series. BYC is the only CAT with a deep
--     BOTH-sided market (6,128 BYC<->USD offers; ~80% of all CAT<->USD volume).
--     implied = median(BYC per XCH) * median(USD per BYC).
--     (Interesting aside: BYC itself trades ~$1, so it's a near-1:1 bridge.)
-- ----------------------------------------------------------------------------
SELECT '--- Q9 triangulation via BYC (monthly, BYC available 2026 only) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     usd(id) AS (VALUES
       ('fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d'),
       ('bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e'),
       ('634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c')),
     byc(id) AS (VALUES ('ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac')),
     -- XCH<->BYC  (BYC per XCH)
     xbyc AS (
       SELECT strftime(o.date_completed,'%Y-%m') AS mo,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS byc_per_xch
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND (off.asset_id IN (SELECT id FROM byc) OR req.asset_id IN (SELECT id FROM byc))),
     -- BYC<->USD  (USD per BYC)
     busd AS (
       SELECT strftime(o.date_completed,'%Y-%m') AS mo,
              CASE WHEN off.asset_id IN (SELECT id FROM usd) THEN off.amount/req.amount ELSE req.amount/off.amount END AS usd_per_byc
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       WHERE o.is_single_pair AND (off.asset_id IN (SELECT id FROM usd) OR req.asset_id IN (SELECT id FROM usd))
         AND (off.asset_id IN (SELECT id FROM byc) OR req.asset_id IN (SELECT id FROM byc))),
     a AS (SELECT mo, median(byc_per_xch) AS bx, count(*) AS nx FROM xbyc WHERE byc_per_xch>0 GROUP BY mo),
     b AS (SELECT mo, median(usd_per_byc) AS ub, count(*) AS nu FROM busd WHERE usd_per_byc>0 GROUP BY mo)
SELECT a.mo, a.nx AS n_xch_byc, b.nu AS n_byc_usd,
       round(a.bx,3) AS byc_per_xch, round(b.ub,4) AS usd_per_byc,
       round(a.bx*b.ub,3) AS implied_usd_per_xch
FROM a JOIN b USING(mo) WHERE a.nx>=10 AND b.nu>=10 ORDER BY a.mo;

-- ============================================================================
-- CSV EXPORTS. Run this file with --no the COPY targets exist. To regenerate:
--   ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/03-price-oracle.sql
-- The COPYs write to research/dexie-offers/findings/data/.
-- ============================================================================

-- E1. DAILY XCH/USD series (trimmed median + IQR + dir split). >30 rows.
COPY (
  WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
       req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
       base AS (
         SELECT o.date_completed::date AS day,
                CASE WHEN off.asset_id='xch' THEN 'sell' ELSE 'buy' END AS dir,
                CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                     ELSE off.amount/req.amount END AS p
         FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
         JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
         WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
           AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
       dm AS (SELECT day, median(p) AS dmed FROM base GROUP BY day),
       t AS (SELECT b.* FROM base b JOIN dm USING(day) WHERE b.p BETWEEN 0.2*dmed AND 5*dmed)
  SELECT day, count(*) AS n_trades,
         round(median(p),4) AS usd_per_xch,
         round(quantile_cont(p,0.25),4) AS q25,
         round(quantile_cont(p,0.75),4) AS q75,
         count(*) FILTER (WHERE dir='sell') AS n_sell,
         count(*) FILTER (WHERE dir='buy') AS n_buy
  FROM t GROUP BY day ORDER BY day
) TO 'research/dexie-offers/findings/data/03-price-oracle-daily.csv' (HEADER, DELIMITER ',');

-- E2. WEEKLY XCH/USD series (trimmed median + IQR + ask/bid). >30 rows.
COPY (
  WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
       req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
       base AS (
         SELECT date_trunc('week', o.date_completed)::date AS week,
                CASE WHEN off.asset_id='xch' THEN 'sell' ELSE 'buy' END AS dir,
                CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                     ELSE off.amount/req.amount END AS p
         FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
         JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
         WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
           AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND p>0),
       wm AS (SELECT week, median(p) AS wmed FROM base GROUP BY week),
       t AS (SELECT b.* FROM base b JOIN wm USING(week) WHERE b.p BETWEEN 0.2*wmed AND 5*wmed)
  SELECT week, count(*) AS n_trades,
         round(median(p),4) AS usd_per_xch,
         round(quantile_cont(p,0.25),4) AS q25,
         round(quantile_cont(p,0.75),4) AS q75,
         round(median(p) FILTER (WHERE dir='sell'),4) AS ask_sell,
         round(median(p) FILTER (WHERE dir='buy'),4) AS bid_buy,
         count(*) FILTER (WHERE dir='sell') AS n_sell,
         count(*) FILTER (WHERE dir='buy') AS n_buy
  FROM t GROUP BY week ORDER BY week
) TO 'research/dexie-offers/findings/data/03-price-oracle-weekly.csv' (HEADER, DELIMITER ',');

-- E3. MONTHLY stablecoin validation table (warp coins vs USDSC).
COPY (
  WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
       req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
       norm AS (
         SELECT sc.code, o.date_completed,
                CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                     ELSE off.amount/req.amount END AS p
         FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
         JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
         WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
           AND sc.code IN ('wUSDC.b','wUSDC','wUSDT','USDSC') AND p>0)
  SELECT strftime(date_completed,'%Y-%m') AS month,
         round(median(p) FILTER (WHERE code='wUSDC.b'),3) AS wusdc_b,
         count(*) FILTER (WHERE code='wUSDC.b') AS n_wusdc_b,
         round(median(p) FILTER (WHERE code='wUSDC'),3) AS wusdc,
         count(*) FILTER (WHERE code='wUSDC') AS n_wusdc,
         round(median(p) FILTER (WHERE code='wUSDT'),3) AS wusdt,
         count(*) FILTER (WHERE code='wUSDT') AS n_wusdt,
         round(median(p) FILTER (WHERE code='USDSC'),3) AS usdsc_junk,
         count(*) FILTER (WHERE code='USDSC') AS n_usdsc
  FROM norm GROUP BY 1 ORDER BY 1
) TO 'research/dexie-offers/findings/data/03-price-oracle-stablecoin-validation.csv' (HEADER, DELIMITER ',');
