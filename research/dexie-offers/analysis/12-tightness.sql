-- ============================================================================
-- 12-tightness.sql  (Thesis T12: market-maker's-eye view — price tightness &
--                    pick-off speed of settled Chia offer-file trades)
--
-- The question this answers: "If I'm a market maker on Chia, how tight is this
-- market, and if I post a resting quote, how badly / how fast do I get picked
-- off?"
--
-- Run read-only so other agents aren't locked:
--   ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/12-tightness.sql
--
-- *** THE INFERENCE BOUNDARY (read first) ***
-- This dataset is SETTLED offers only. There is NO resting / cancelled order
-- book. We therefore CANNOT observe off-price offers that sat unfilled. We infer
-- tightness from (a) how concentrated SETTLED prices are around a rolling fair
-- price, and (b) the SPEED at which favorably-priced offers settle (the pick-off
-- signal) — NOT from watching cancellations.
--
-- REUSED MACHINERY (from 03-price-oracle.sql, T3):
--  - Price normalization: price = requested.amount / offered.amount, rebuilt from
--    the two legs so direction is explicit. For USD/XCH, invert when XCH is the
--    requested leg. Both directions land on one canonical USD-per-XCH scale.
--  - TRUSTED stablecoins ONLY: wUSDC.b, wUSDC, wUSDT (warp.green pegs). USDSC and
--    the TIBET-*USD*-XCH LP tokens are rejected (T3 Finding 1 — USDSC is a fake
--    peg at ~$500/XCH). For CAT pairs we use cat_per_xch (T10 normalization).
--
-- TAKER FAVORABILITY (the load-bearing new construct):
--   A taker accepts a maker's offer: the taker RECEIVES the maker's `offered` leg
--   and PAYS the maker's `requested` leg. A good deal for the taker = the maker
--   priced the offered asset CHEAP vs fair.
--   - maker offered XCH (maker is SELLING XCH): taker is BUYING XCH and wants
--     usd_per_xch LOW  => taker_fav = -(price - fair)/fair
--   - maker requested XCH (maker is BUYING XCH): taker is SELLING XCH and wants
--     usd_per_xch HIGH => taker_fav = +(price - fair)/fair
--   So taker_fav > 0 == the taker got a better-than-fair deal == the MAKER got
--   picked off. This is the MM-relevant axis.
--
-- TIME-TO-FILL (ttf): date_found -> date_completed in seconds. date_found is
-- dexie's first-seen, NOT creation (00-recon/T5 caveat), so ttf is a FLOOR on
-- true resting time. We drop the 67 (warp) rows with date_completed < date_found.
--
-- FAIR PRICE: two methods, both robust (median, never mean):
--   - DAILY fair: per-(pair,day) median. Simple; but a volatile day's intraday
--     drift inflates a fill's apparent deviation (handled where it matters).
--   - ROLLING fair: median of the 51 nearest-in-time trades (25 each side),
--     time-ordered. Drift-controlled; used for the headline pick-off curve.
-- All series trimmed to [0.2x, 5x] of the day's raw median to drop junk.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Q0. Universe & ttf coverage for the trusted warp XCH<->USD market.
-- ----------------------------------------------------------------------------
SELECT '--- Q0 warp XCH<->USD universe ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0)
SELECT count(*) AS n_trades,
       count(*) FILTER (WHERE o.date_completed >= o.date_found) AS n_valid_ttf,
       count(*) FILTER (WHERE o.date_completed <  o.date_found) AS n_negative_ttf,
       min(o.date_completed)::date AS first_day, max(o.date_completed)::date AS last_day
FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
  AND sc.code IN ('wUSDC.b','wUSDC','wUSDT');

-- ----------------------------------------------------------------------------
-- Q1. TIGHTNESS / EFFECTIVE SPREAD (warp XCH<->USD). |deviation| of each settled
--     price from the ROLLING fair (51-trade window). What % land within bands?
--     The median |dev| is the effective half-spread a taker faces.
-- ----------------------------------------------------------------------------
SELECT '--- Q1 effective spread: % within bands of rolling fair ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed AS ts, o.date_completed::date AS d,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount
                   ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT')),
     dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
     clean AS (SELECT b.* FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair),
     roll AS (SELECT *, median(p) OVER (ORDER BY ts ROWS BETWEEN 25 PRECEDING AND 25 FOLLOWING) AS fair FROM clean),
     dev AS (SELECT abs(p-fair)/fair AS absdev FROM roll WHERE fair>0)
SELECT count(*) AS n,
       round(100.0*avg(CASE WHEN absdev<=0.005 THEN 1 ELSE 0 END),1) AS pct_within_0p5,
       round(100.0*avg(CASE WHEN absdev<=0.01  THEN 1 ELSE 0 END),1) AS pct_within_1,
       round(100.0*avg(CASE WHEN absdev<=0.02  THEN 1 ELSE 0 END),1) AS pct_within_2,
       round(100.0*avg(CASE WHEN absdev<=0.05  THEN 1 ELSE 0 END),1) AS pct_within_5,
       round(100.0*median(absdev),3) AS median_absdev_pct,
       round(100.0*quantile_cont(absdev,0.75),3) AS p75_absdev_pct
FROM dev;

-- ----------------------------------------------------------------------------
-- Q2. TIGHTNESS OVER TIME (warp XCH<->USD), quarterly. Median |dev| from the
--     per-day fair + % within +-1%. Did the market tighten as bots/AMM grew?
--     (Daily fair here, so volatile days inflate absdev — read as upper bound.)
-- ----------------------------------------------------------------------------
SELECT '--- Q2 tightness over time (quarterly) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d,
              strftime(o.date_completed,'%Y')||'-Q'||ceil(month(o.date_completed)/3.0)::int AS q,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT')),
     dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
     dev AS (SELECT b.q, abs(b.p-dfair)/dfair AS absdev FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair)
SELECT q, count(*) AS n,
       round(100.0*median(absdev),3) AS med_absdev_pct,
       round(100.0*avg(CASE WHEN absdev<=0.01 THEN 1 ELSE 0 END),1) AS pct_within_1
FROM dev GROUP BY q ORDER BY q;

-- ----------------------------------------------------------------------------
-- Q3. *** THE HEADLINE: PICK-OFF CURVE *** (warp XCH<->USD).
--     Taker-favorability bucket (vs ROLLING fair) -> median time-to-fill +
--     sub-minute share. Hypothesis: more-favorable (cheaper-for-taker) offers
--     settle FAST (bots snap them); fairly/richly-priced ones sit.
-- ----------------------------------------------------------------------------
SELECT '--- Q3 pick-off curve: favorability bucket vs time-to-fill (rolling fair) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed AS ts, o.date_completed::date AS d,
              date_diff('second', o.date_found, o.date_completed) AS ttf,
              CASE WHEN off.asset_id='xch' THEN 'sell_xch' ELSE 'buy_xch' END AS maker_dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND o.date_completed>=o.date_found),
     dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
     clean AS (SELECT b.* FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair),
     roll AS (SELECT *, median(p) OVER (ORDER BY ts ROWS BETWEEN 25 PRECEDING AND 25 FOLLOWING) AS fair FROM clean),
     dev AS (SELECT *, CASE WHEN maker_dir='sell_xch' THEN -(p-fair)/fair ELSE (p-fair)/fair END AS taker_fav
             FROM roll WHERE fair>0)
SELECT
  CASE WHEN taker_fav < -0.05  THEN 'a: < -5% (very rich)'
       WHEN taker_fav < -0.02  THEN 'b: -5..-2%'
       WHEN taker_fav < -0.01  THEN 'c: -2..-1%'
       WHEN taker_fav < -0.002 THEN 'd: -1..-0.2%'
       WHEN taker_fav <= 0.002 THEN 'e: +-0.2% (fair)'
       WHEN taker_fav <= 0.01  THEN 'f: +0.2..1%'
       WHEN taker_fav <= 0.02  THEN 'g: +1..2%'
       WHEN taker_fav <= 0.05  THEN 'h: +2..5%'
       ELSE 'i: > +5% (very cheap)' END AS favorability,
  count(*) AS n, round(median(ttf),0) AS med_ttf_sec,
  round(100.0*avg(CASE WHEN ttf<60 THEN 1 ELSE 0 END),1) AS pct_submin
FROM dev GROUP BY 1 ORDER BY 1;

-- ----------------------------------------------------------------------------
-- Q4. Pick-off STRENGTH: Spearman rank correlation of taker_favorability vs ttf
--     (daily fair, full warp set). Negative = more-favorable fills faster.
-- ----------------------------------------------------------------------------
SELECT '--- Q4 Spearman(favorability, time-to-fill) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d, date_diff('second', o.date_found, o.date_completed) AS ttf,
              CASE WHEN off.asset_id='xch' THEN 'sell_xch' ELSE 'buy_xch' END AS maker_dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND o.date_completed>=o.date_found),
     dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
     dev AS (SELECT ttf, CASE WHEN maker_dir='sell_xch' THEN -(p-dfair)/dfair ELSE (p-dfair)/dfair END AS fav
             FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair),
     ranked AS (SELECT rank() OVER (ORDER BY fav) AS rf, rank() OVER (ORDER BY ttf) AS rt FROM dev)
SELECT round(corr(rf,rt),3) AS spearman_fav_ttf, count(*) AS n FROM ranked;

-- ----------------------------------------------------------------------------
-- Q5. WHO does the picking off — AMM vs other/P2P (warp XCH<->USD, 2025-04+,
--     where the taker is labelled). Median ttf + favorability profile of fills.
-- ----------------------------------------------------------------------------
SELECT '--- Q5 AMM vs other: pick-off agent (2025-04+) ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d, date_diff('second', o.date_found, o.date_completed) AS ttf,
              coalesce(o.known_taker_source,'')='tibet2' AS is_amm,
              CASE WHEN off.asset_id='xch' THEN 'sell_xch' ELSE 'buy_xch' END AS maker_dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND o.date_completed>=o.date_found
         AND o.date_completed>='2025-04-01'),
     dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
     dev AS (SELECT b.*, CASE WHEN maker_dir='sell_xch' THEN -(p-dfair)/dfair ELSE (p-dfair)/dfair END AS fav
             FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair)
SELECT CASE WHEN is_amm THEN 'AMM (tibet2)' ELSE 'other / P2P (unlabelled)' END AS taker,
       count(*) AS n, round(median(ttf),0) AS med_ttf_sec,
       round(median(fav)*100,2) AS med_fav_pct,
       round(100.0*avg(CASE WHEN fav>0.01 THEN 1 ELSE 0 END),1) AS pct_cheap_gt1pct,
       round(100.0*avg(CASE WHEN ttf<60 THEN 1 ELSE 0 END),1) AS pct_submin
FROM dev GROUP BY 1 ORDER BY 1;

-- ----------------------------------------------------------------------------
-- Q6. DEPTH / CAPACITY (warp XCH<->USD). Trades/day, USD volume/day, total.
--     What an MM could realistically clear. (USD assumes warp coins ~$1.)
-- ----------------------------------------------------------------------------
SELECT '--- Q6 depth: trades & USD volume per day ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.date_completed::date AS d,
              CASE WHEN off.asset_id='xch' THEN off.amount ELSE req.amount END AS xch_amt,
              CASE WHEN off.asset_id='xch' THEN req.amount ELSE off.amount END AS usd_amt
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('wUSDC.b','wUSDC','wUSDT')),
     daily AS (SELECT d, count(*) AS n, sum(usd_amt) AS usd_vol FROM base GROUP BY d)
SELECT 'all_days' AS scope, count(*) AS active_days,
       round(median(n),1) AS med_trades_day, round(quantile_cont(n,0.9),0) AS p90_trades_day,
       round(median(usd_vol),0) AS med_usd_vol_day, round(sum(usd_vol),0) AS total_usd_vol
FROM daily
UNION ALL
SELECT 'recent_2025-04+', count(*), round(median(n),1), round(quantile_cont(n,0.9),0),
       round(median(usd_vol),0), round(sum(usd_vol),0)
FROM daily WHERE d>='2025-04-01';

-- ----------------------------------------------------------------------------
-- Q7. GENERALIZATION: same pick-off curve on top liquid CAT<->XCH pairs (per-pair
--     daily fair, cat_per_xch normalization per T10). Confirms the pattern is not
--     stablecoin-specific. Top pairs by volume (all per-pair-cap floors).
-- ----------------------------------------------------------------------------
SELECT '--- Q7 pick-off curve on top liquid CAT<->XCH pairs ---' AS q;
WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
     req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
     base AS (
       SELECT o.id, sc.code, o.date_completed::date AS d,
              date_diff('second', o.date_found, o.date_completed) AS ttf,
              CASE WHEN off.asset_id='xch' THEN 'sell_xch' ELSE 'buy_xch' END AS maker_dir,
              CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS cat_per_xch
       FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
       JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0 AND NOT sc.is_nft
       WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
         AND sc.code IN ('SBX','DBX','BEPE','MBX','BYC','HOA','NIOC','🐈')
         AND o.date_completed>=o.date_found),
     dm AS (SELECT code, d, median(cat_per_xch) AS fair FROM base GROUP BY code,d),
     dev AS (SELECT b.*, CASE WHEN maker_dir='sell_xch' THEN -(cat_per_xch-fair)/fair ELSE (cat_per_xch-fair)/fair END AS taker_fav
             FROM base b JOIN dm USING(code,d) WHERE b.cat_per_xch BETWEEN 0.2*fair AND 5*fair AND fair>0)
SELECT
  CASE WHEN taker_fav < -0.05  THEN 'a: < -5% (very rich)'
       WHEN taker_fav < -0.02  THEN 'b: -5..-2%'
       WHEN taker_fav < -0.005 THEN 'c: -2..-0.5%'
       WHEN taker_fav <= 0.005 THEN 'd: +-0.5% (fair)'
       WHEN taker_fav <= 0.02  THEN 'e: +0.5..2%'
       WHEN taker_fav <= 0.05  THEN 'f: +2..5%'
       ELSE 'g: > +5% (very cheap)' END AS favorability,
  count(*) AS n, round(median(ttf),0) AS med_ttf_sec,
  round(100.0*avg(CASE WHEN ttf<60 THEN 1 ELSE 0 END),1) AS pct_submin
FROM dev GROUP BY 1 ORDER BY 1;

-- ============================================================================
-- CSV EXPORTS (to research/dexie-offers/findings/data/). Series with >30 rows only.
-- ============================================================================

-- E1. Weekly tightness + depth (warp XCH<->USD): median |dev| from daily fair,
--     trades/week, USD volume/week. >30 rows.
COPY (
  WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
       req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
       base AS (
         SELECT date_trunc('week', o.date_completed)::date AS week, o.date_completed::date AS d,
                CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p,
                CASE WHEN off.asset_id='xch' THEN req.amount ELSE off.amount END AS usd_amt
         FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
         JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
         WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
           AND sc.code IN ('wUSDC.b','wUSDC','wUSDT')),
       dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
       dev AS (SELECT b.*, abs(b.p-dfair)/dfair AS absdev FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair)
  SELECT week, count(*) AS n_trades,
         round(100.0*median(absdev),3) AS med_absdev_pct,
         round(100.0*avg(CASE WHEN absdev<=0.01 THEN 1 ELSE 0 END),1) AS pct_within_1pct,
         round(sum(usd_amt),0) AS usd_volume
  FROM dev GROUP BY week ORDER BY week
) TO 'research/dexie-offers/findings/data/12-tightness-weekly.csv' (HEADER, DELIMITER ',');

-- E2. The pick-off curve (warp XCH<->USD), the headline chart data. Fine
--     favorability bins -> n, median ttf, sub-minute share. (Rolling fair.)
COPY (
  WITH off AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='offered' AND leg_idx=0),
       req AS (SELECT offer_id, asset_id, amount FROM legs WHERE side='requested' AND leg_idx=0),
       base AS (
         SELECT o.date_completed AS ts, o.date_completed::date AS d,
                date_diff('second', o.date_found, o.date_completed) AS ttf,
                CASE WHEN off.asset_id='xch' THEN 'sell_xch' ELSE 'buy_xch' END AS maker_dir,
                CASE WHEN off.asset_id='xch' THEN req.amount/off.amount ELSE off.amount/req.amount END AS p
         FROM offers o JOIN off ON o.id=off.offer_id JOIN req ON o.id=req.offer_id
         JOIN legs sc ON sc.offer_id=o.id AND sc.asset_id<>'xch' AND sc.leg_idx=0
         WHERE o.is_single_pair AND (off.asset_id='xch' OR req.asset_id='xch')
           AND sc.code IN ('wUSDC.b','wUSDC','wUSDT') AND o.date_completed>=o.date_found),
       dm AS (SELECT d, median(p) AS dfair FROM base GROUP BY d),
       clean AS (SELECT b.* FROM base b JOIN dm USING(d) WHERE b.p BETWEEN 0.2*dfair AND 5*dfair),
       roll AS (SELECT *, median(p) OVER (ORDER BY ts ROWS BETWEEN 25 PRECEDING AND 25 FOLLOWING) AS fair FROM clean),
       dev AS (SELECT *, CASE WHEN maker_dir='sell_xch' THEN -(p-fair)/fair ELSE (p-fair)/fair END AS taker_fav
               FROM roll WHERE fair>0)
  SELECT CASE WHEN taker_fav < -0.05  THEN 'a_lt_-5'
              WHEN taker_fav < -0.02  THEN 'b_-5_-2'
              WHEN taker_fav < -0.01  THEN 'c_-2_-1'
              WHEN taker_fav < -0.002 THEN 'd_-1_-0.2'
              WHEN taker_fav <= 0.002 THEN 'e_fair'
              WHEN taker_fav <= 0.01  THEN 'f_+0.2_1'
              WHEN taker_fav <= 0.02  THEN 'g_+1_2'
              WHEN taker_fav <= 0.05  THEN 'h_+2_5'
              ELSE 'i_gt_+5' END AS fav_bucket,
         count(*) AS n, round(median(ttf),0) AS med_ttf_sec,
         round(100.0*avg(CASE WHEN ttf<60 THEN 1 ELSE 0 END),1) AS pct_submin
  FROM dev GROUP BY 1 ORDER BY 1
) TO 'research/dexie-offers/findings/data/12-tightness-pickoff-curve.csv' (HEADER, DELIMITER ',');
