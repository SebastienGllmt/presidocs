-- ============================================================================
-- 11 — USD-DENOMINATED TRADING (thesis S4')
-- Do some traders price directly in USD stablecoins instead of XCH?
-- How much of the market, is it growing, and do USD-priced trades behave more
-- "rationally" than the XCH-anchored ones (sticky-XCH-floor / collapsing-USD, T2)?
--
-- Run read-only (safe alongside other agents):
--   ./tools/duckdb -readonly generated/offers.duckdb < research/dexie-offers/analysis/11-usd-denominated.sql
--
-- TRUSTED USD = warp.green only (per 03-price-oracle.md). USDSC + TIBET-* LP
-- "USD" tokens are EXCLUDED from all "USD" measures (USDSC is a fake $1 peg).
--   wUSDC.b  fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d
--   wUSDC    bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e
--   wUSDT    634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c
--   (USDSC  6d95dae356e32a71db5ddcb42224754a02524c615c5fc35f568c2af04774e589  -- REJECT)
-- ============================================================================

-- Reusable macro-ish: the trusted-USD asset id set is inlined per query below
-- (DuckDB CLI .read does not persist temp views across statements reliably here).

-- ----------------------------------------------------------------------------
-- Q0 — VOLUME CEILING: share of all offers that touch a trusted USD coin
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
usd_offers AS (SELECT DISTINCT l.offer_id FROM legs l JOIN usd u ON l.asset_id=u.aid)
SELECT 'Q0 volume ceiling' q,
  (SELECT count(*) FROM offers) total_offers,
  (SELECT count(*) FROM usd_offers) offers_with_trusted_usd,
  round(100.0*(SELECT count(*) FROM usd_offers)/(SELECT count(*) FROM offers),3) pct;

-- ----------------------------------------------------------------------------
-- Q1 — Single-pair USD offers split by counterpart type (NFT / CAT / XCH)
-- A single-pair offer is 1x1; "USD offer" = exactly one of its two legs is trusted-USD.
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.asset_id, l.is_nft,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
usd_sp AS (SELECT offer_id FROM sp_legs GROUP BY offer_id HAVING sum(is_usd::int)=1)
SELECT 'Q1 counterpart split' q,
  CASE WHEN s.is_nft THEN 'NFT' WHEN s.is_xch THEN 'XCH' ELSE 'CAT' END counter_type,
  count(*) offers
FROM sp_legs s JOIN usd_sp u ON s.offer_id=u.offer_id
WHERE NOT s.is_usd GROUP BY 2 ORDER BY 3 DESC;

-- ----------------------------------------------------------------------------
-- Q2 — Which assets ever get priced in USD (single-pair, top counterparts)
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.asset_id, l.code, l.is_nft,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
usd_sp AS (SELECT offer_id FROM sp_legs GROUP BY offer_id HAVING sum(is_usd::int)=1)
SELECT 'Q2 top USD counterparts' q,
  CASE WHEN s.is_nft THEN 'NFT (any)' WHEN s.is_xch THEN 'XCH' ELSE coalesce(s.code,'(no-code CAT)') END counterpart,
  count(*) offers
FROM sp_legs s JOIN usd_sp u ON s.offer_id=u.offer_id
WHERE NOT s.is_usd GROUP BY 2 ORDER BY 3 DESC LIMIT 20;

-- ----------------------------------------------------------------------------
-- Q3 — TREND: monthly USD-denominated single-pair offers by counterpart type
--   (CSV export: 11-usd-denominated-monthly.csv)
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.date_completed, l.asset_id, l.is_nft,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
usd_sp AS (SELECT offer_id, any_value(date_completed) dc FROM sp_legs GROUP BY offer_id HAVING sum(is_usd::int)=1),
typed AS (
  SELECT strftime(u.dc,'%Y-%m') ym,
    CASE WHEN s.is_nft THEN 'NFT' WHEN s.is_xch THEN 'XCH' ELSE 'CAT' END t
  FROM sp_legs s JOIN usd_sp u ON s.offer_id=u.offer_id WHERE NOT s.is_usd)
SELECT 'Q3 monthly trend' q, ym,
  sum((t='XCH')::int) xch_usd, sum((t='CAT')::int) cat_usd, sum((t='NFT')::int) nft_usd, count(*) total
FROM typed GROUP BY ym ORDER BY ym;

-- ----------------------------------------------------------------------------
-- Q4 — Is the CAT<->USD slice a genuine USD-priced volatile asset, or stable<->stable?
--   The CAT slice is ~96% BYC. Check BYC's USD value: if ~$1, it is itself a
--   stablecoin-like unit (so not "a trader pricing a volatile asset in USD").
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.asset_id, l.code, l.amount,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
byc AS (
  SELECT s_usd.amount / s_byc.amount usd_per_byc
  FROM sp_legs s_byc JOIN sp_legs s_usd ON s_byc.offer_id=s_usd.offer_id AND s_usd.is_usd
  WHERE s_byc.code='BYC')
SELECT 'Q4 BYC is ~$1' q, count(*) n,
  round(median(usd_per_byc),4) med_usd_per_byc,
  round(quantile(usd_per_byc,0.1),4) p10, round(quantile(usd_per_byc,0.9),4) p90
FROM byc WHERE usd_per_byc BETWEEN 0.01 AND 100;

-- ----------------------------------------------------------------------------
-- Q5 — NFT<->USD direction (sold for USD vs bought with USD) — note it inverts
--   vs NFT<->XCH (which is ~99% sell-side listings, per T2).
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.side, l.asset_id, l.is_nft,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
usd_sp AS (SELECT offer_id FROM sp_legs GROUP BY offer_id HAVING sum(is_usd::int)=1)
SELECT 'Q5 NFT-USD direction' q,
  CASE WHEN s.side='offered' THEN 'NFT sold for USD' ELSE 'NFT bought with USD' END dir, count(*) n
FROM sp_legs s JOIN usd_sp u ON s.offer_id=u.offer_id WHERE s.is_nft GROUP BY 2 ORDER BY 3 DESC;

-- ----------------------------------------------------------------------------
-- Q6 — WHICH NFT collections get priced in USD, and do they also trade in XCH?
--   (the USD-priced NFTs turn out to be RWA-style: tokenized real-estate
--    addresses + GPU hardware.)
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.asset_id, l.is_nft,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
classified AS (
  SELECT offer_id, max(is_usd::int) has_usd, max(is_xch::int) has_xch, max(is_nft::int) has_nft
  FROM sp_legs GROUP BY offer_id)
SELECT 'Q6 USD-priced NFT collections' q, coalesce(m.collection_name,'(none)') coll,
  sum(c.has_usd) usd_sales, sum(c.has_xch) xch_sales
FROM nft_meta m JOIN classified c ON m.offer_id=c.offer_id
WHERE c.has_nft=1 AND (c.has_usd=1 OR c.has_xch=1)
GROUP BY 2 HAVING sum(c.has_usd) >= 20 ORDER BY usd_sales DESC;

-- ----------------------------------------------------------------------------
-- Q7 — BEHAVIOR: dual-denominated NFT price stability.
--   For RWA collections traded in BOTH USD and XCH, compare the USD-direct median
--   price vs the XCH-implied-USD (median XCH * monthly XCH/USD oracle). If the
--   asset is rationally USD-priced, the USD line is flat while XCH rises as XCH falls.
--   Single-collection focus: 2405 Pollen Way (the cleanest dual case).
-- ----------------------------------------------------------------------------
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.side, l.asset_id, l.amount, l.is_nft, l.date_completed,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
np AS (
  SELECT strftime(s_nft.date_completed,'%Y-%m') ym,
    CASE WHEN s_o.is_usd THEN 'USD' ELSE 'XCH' END unit, s_o.amount px
  FROM nft_meta m
  JOIN sp_legs s_nft ON m.offer_id=s_nft.offer_id AND s_nft.is_nft
  JOIN sp_legs s_o ON m.offer_id=s_o.offer_id AND NOT s_o.is_nft AND (s_o.is_usd OR s_o.is_xch)
  WHERE m.collection_name='2405 Pollen Way')
SELECT 'Q7 2405 Pollen Way px' q, ym, unit, count(*) n, round(median(px),3) med
FROM np GROUP BY ym, unit ORDER BY ym, unit;

-- Q7b — same idea aggregated over all RWA collections, with XCH-implied-USD column
WITH usd AS (SELECT unnest([
  'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
  'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
  '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c']) aid),
sp_legs AS (
  SELECT l.offer_id, l.side, l.asset_id, l.amount, l.is_nft, l.date_completed,
    (l.asset_id IN (SELECT aid FROM usd)) is_usd, (l.asset_id='xch') is_xch
  FROM legs l JOIN offers o ON l.offer_id=o.id WHERE o.is_single_pair),
fx AS (
  SELECT strftime(x.date_completed,'%Y-%m') ym,
    median(CASE WHEN x.is_xch THEN u2.amount/x.amount END) usd_per_xch
  FROM sp_legs x JOIN sp_legs u2 ON x.offer_id=u2.offer_id AND u2.is_usd
  WHERE x.is_xch GROUP BY 1),
rwa AS (
  SELECT strftime(s_nft.date_completed,'%Y-%m') ym,
    CASE WHEN s_o.is_usd THEN s_o.amount END usd_px,
    CASE WHEN s_o.is_xch THEN s_o.amount END xch_px
  FROM nft_meta m
  JOIN sp_legs s_nft ON m.offer_id=s_nft.offer_id AND s_nft.is_nft
  JOIN sp_legs s_o ON m.offer_id=s_o.offer_id AND NOT s_o.is_nft AND (s_o.is_usd OR s_o.is_xch)
  WHERE m.collection_name IN ('2405 Pollen Way','336 Sarava Ln','2428 Egret Dr','621 Martha Ave',
    '1050 44th Ave N','147 Coach Dr','421 Shelby St','1527 White Bluff Rd','Pantheon 4090','FarmGPU 4090'))
SELECT 'Q7b RWA agg USD vs XCH-implied' q, r.ym,
  count(usd_px) n_usd, round(median(usd_px),2) med_usd_direct,
  count(xch_px) n_xch, round(median(xch_px),3) med_xch,
  round(median(xch_px)*any_value(fx.usd_per_xch),2) xch_implied_usd
FROM rwa r LEFT JOIN fx ON r.ym=fx.ym
GROUP BY r.ym ORDER BY r.ym;

-- ----------------------------------------------------------------------------
-- Q8 — STABLECOIN MIGRATION (bonus): USDSC (zombie) -> warp.green by month.
--   Counts every leg appearance of each (any offer, any side). Datable flight to
--   the credible peg when warp.green arrived 2024-05.  (CSV: 11-usd-denominated-stablecoin-migration.csv)
-- ----------------------------------------------------------------------------
WITH stbl AS (
  SELECT l.date_completed,
    CASE
      WHEN l.asset_id='6d95dae356e32a71db5ddcb42224754a02524c615c5fc35f568c2af04774e589' THEN 'USDSC'
      WHEN l.asset_id IN (
        'fa4a180ac326e67ea289b869e3448256f6af05721f7cf934cb9901baa6b7a99d',
        'bbb51b246fbec1da1305be31dcf17151ccd0b8231a1ec306d7ce9f5b8c742b9e',
        '634f9f0de1a6c39a2189948b8e61b6852fbf774f73b0e36e143e841c49a0798c') THEN 'warp'
      ELSE NULL END grp
  FROM legs l)
SELECT 'Q8 stablecoin migration' q, strftime(date_completed,'%Y-%m') ym,
  sum((grp='USDSC')::int) usdsc_legs, sum((grp='warp')::int) warp_legs
FROM stbl WHERE grp IS NOT NULL GROUP BY ym ORDER BY ym;

-- ============================================================================
-- CSV EXPORTS (run separately with COPY when refreshing data/ files)
-- ============================================================================
-- COPY ( <Q3 body> ) TO 'research/dexie-offers/findings/data/11-usd-denominated-monthly.csv' (HEADER);
-- COPY ( <Q8 body> ) TO 'research/dexie-offers/findings/data/11-usd-denominated-stablecoin-migration.csv' (HEADER);
