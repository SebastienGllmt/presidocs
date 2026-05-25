-- 14-taxonomy.sql — gap analysis for the CAT/NFT category taxonomy.
-- Read-only exploration backing research/dexie-offers/findings/14-token-taxonomy-review.md.
-- Run with: ./tools/duckdb -readonly generated/offers.duckdb -f research/dexie-offers/analysis/14-taxonomy.sql
--
-- METHOD: work weighted by OFFER ACTIVITY (count DISTINCT offer_id per asset),
-- not raw token count. Descriptions in token_meta are the source of truth.
-- token_meta marks CATs with is_nft = NULL (NOT false); NFTs are is_nft = true.

-- ---------------------------------------------------------------------------
-- 0. Registry / coverage sanity
-- ---------------------------------------------------------------------------
SELECT is_nft, count(*) FROM token_meta GROUP BY is_nft;          -- 2101 nft, 912 cat(NULL)
-- traded CATs and total CAT offer activity (asset_id <> xch, is_nft=false)
WITH cat_offers AS (
  SELECT l.asset_id, count(DISTINCT l.offer_id) AS offers
  FROM legs l WHERE l.is_nft = false AND l.asset_id <> 'xch'
  GROUP BY l.asset_id
)
SELECT count(*) AS distinct_cats, sum(offers) AS sum_cat_legoffers FROM cat_offers; -- 860 / 814,291
-- offers involving >=1 CAT (dedup; the 814k double-counts CAT<->CAT)
SELECT count(DISTINCT offer_id) FROM legs WHERE is_nft=false AND asset_id<>'xch';   -- 595,148
SELECT count(DISTINCT offer_id) FROM legs WHERE asset_id='xch';                     -- 637,725 (76.5%)

-- ---------------------------------------------------------------------------
-- 1. Top traded CATs with descriptions (the read-the-descriptions core).
--    Cumulative reaches ~88% of CAT offer activity by rank 100, ~90% by 120.
-- ---------------------------------------------------------------------------
WITH cat_offers AS (
  SELECT l.asset_id, count(DISTINCT l.offer_id) AS offers
  FROM legs l WHERE l.is_nft=false AND l.asset_id<>'xch' GROUP BY l.asset_id
), ranked AS (
  SELECT asset_id, offers, sum(offers) OVER () AS tot,
    sum(offers) OVER (ORDER BY offers DESC) AS cum,
    row_number() OVER (ORDER BY offers DESC) AS rk
  FROM cat_offers
)
SELECT r.rk, t.code, t.name, r.offers, round(100.0*r.cum/r.tot,1) AS cum_pct,
       substr(t.description,1,200) AS desc
FROM ranked r LEFT JOIN token_meta t ON t.id=r.asset_id
ORDER BY r.offers DESC LIMIT 120;

-- ---------------------------------------------------------------------------
-- 2. No-description tail, weighted by offers — and how much of it is LP
--    (TIBET-* LPs carry no description but are trivially code-classifiable).
-- ---------------------------------------------------------------------------
WITH cat_offers AS (
  SELECT l.asset_id, count(DISTINCT l.offer_id) AS offers
  FROM legs l WHERE l.is_nft=false AND l.asset_id<>'xch' GROUP BY l.asset_id
)
SELECT
  CASE WHEN t.code LIKE 'TIBET-%' THEN 'LP_nodesc'
       WHEN t.description IS NULL OR t.description='' THEN 'other_nodesc'
       ELSE 'has_desc' END AS bucket,
  count(*) AS n_tokens, sum(c.offers) AS offers,
  round(100.0*sum(c.offers)/sum(sum(c.offers)) OVER (),2) AS pct_cat_activity
FROM cat_offers c LEFT JOIN token_meta t ON t.id=c.asset_id
GROUP BY 1 ORDER BY offers DESC;
-- => has_desc 92.8% | LP_nodesc 4.77% | other_nodesc 2.43%

-- biggest non-LP no-description tokens (the true Unclassified candidates)
WITH cat_offers AS (
  SELECT l.asset_id, count(DISTINCT l.offer_id) AS offers
  FROM legs l WHERE l.is_nft=false AND l.asset_id<>'xch' GROUP BY l.asset_id
)
SELECT coalesce(t.code,'(unregistered)') AS code, coalesce(t.name,'?') AS tname, c.offers
FROM cat_offers c LEFT JOIN token_meta t ON t.id=c.asset_id
WHERE (t.description IS NULL OR t.description='') AND coalesce(t.code,'') NOT LIKE 'TIBET-%'
ORDER BY c.offers DESC LIMIT 25;

-- ---------------------------------------------------------------------------
-- 3. Candidate-category aggregates (illustrative code-sets, NOT the final
--    mapping). Each is DISTINCT offer_id, % of all 833,145 offers.
-- ---------------------------------------------------------------------------
-- 3a. Stablecoin (USD-pegged + ETH unit warp; BYC = Chia-native CDP $-peg)
SELECT 'Stablecoin' cat, count(DISTINCT offer_id) offers, round(100.0*count(DISTINCT offer_id)/833145,1) pct_all
FROM legs WHERE is_nft=false AND code IN ('wUSDC.b','wUSDC','wUSDT','USDSC','BYC','wmilliETH');
-- 3b. LP token (TibetSwap AMM receipts) — code prefix, no desc needed
SELECT 'LP' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code LIKE 'TIBET-%';
-- 3c. Game-economy tokens (FarmerVerse + Abandoned Land + other game currencies/resources)
SELECT 'GameEconomy' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code IN
 ('FBX','FHW','THW','XFUEL','XHAY','XSEED','XCOW','XPIG','XSHEP','XCHIN','XMILK','XMEAT','XWOOL','XEGG','XFRUT','XWOOD',
  'ALWORK','ALTOOL','ALWOOD','ALFOOD','ALORE','ALGOLD','ALWEAP','ALExp',
  'CMTG','MIO','SHD','OXC','O2','POTT','XEG','ENIGMA');
-- 3d. NFT-project utility tokens (CAT tied to/earned by an NFT collection)
SELECT 'NFTutility' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code IN ('G4M','MZ','CHEEZE','NeckCoin','WAR','ZOMB','MOJO','GEN','DEGEN','MWIF');
-- 3e. Protocol / platform / infrastructure tokens (governance + DeFi + services)
SELECT 'Protocol' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code IN ('DBX','CRT','DIG','INCL1','NAME','GWT','NIOC','NIOG');
-- 3f. Memecoin (joke / hype / community-meme, incl. "currency" memes)
SELECT 'Memecoin' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code IN
 ('BEPE','SBX','MBX','MJO','GYATT','PEPE','$CHIA','🌱','WARP','KUT','🍕','DMT','CHUMP','🥔','LFG','BANANA','HonK','🍪','💎','GFY','¢ni','BBT','MIRROR','CHAD','HOA','C2R');
-- 3g. Social / community tokens (Discord-economy points; TangGang cluster)
SELECT 'Social' cat, count(DISTINCT offer_id), round(100.0*count(DISTINCT offer_id)/833145,1)
FROM legs WHERE is_nft=false AND code IN ('PP','MINUTES','❤️','GOLD','NINJA','ACID','MOG');

-- ---------------------------------------------------------------------------
-- 4. NFT side: collection-driven. RWA test (real estate / GPU / commodity).
-- ---------------------------------------------------------------------------
SELECT count(DISTINCT offer_id) offers_with_nft FROM nft_meta;                       -- 317,210
SELECT count(DISTINCT collection_name) FROM nft_meta WHERE collection_name IS NOT NULL; -- 1885
SELECT coalesce(collection_name,'(none)') coll, count(DISTINCT offer_id) offers
FROM nft_meta GROUP BY 1 ORDER BY offers DESC LIMIT 25;
-- RWA keyword scan — only FarmGPU 4090 (26) + "One-off real world asset issuance" (1)
-- are genuine RWA; "Gold/Golden/Miner*" are art themes, not tokenized assets.
SELECT collection_name, count(DISTINCT offer_id) offers
FROM nft_meta
WHERE lower(collection_name) SIMILAR TO '.*(gpu|estate|property|real |rwa|acre|deed|mining rig|solar|carbon|invoice|bond).*'
GROUP BY 1 ORDER BY offers DESC LIMIT 25;

-- ---------------------------------------------------------------------------
-- 5. Confirm AL* prefix is clean (all Abandoned Land, no false positives)
-- ---------------------------------------------------------------------------
SELECT DISTINCT code FROM legs WHERE is_nft=false AND code LIKE 'AL%';
-- ALGOLD ALORE ALTOOL ALWORK ALWEAP ALExp ALWOOD ALFOOD — all Abandoned Land. OK.
