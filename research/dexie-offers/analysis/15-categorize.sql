-- 15-categorize.sql — recompute per-category share of all offers from the
-- committed asset->category mapping (research/dexie-offers/findings/asset-categories.csv).
-- Run (read-only): ./tools/duckdb -readonly generated/offers.duckdb -f research/dexie-offers/analysis/15-categorize.sql
-- Exports research/dexie-offers/findings/data/15-category-shares.csv (feeds the post's "what gets traded" chart).
--
-- METHOD (same convention as 04-concentration Q6): an offer is counted ONCE per
-- DISTINCT category any of its legs touches, so columns OVERLAP and do NOT sum to
-- 100% (most offers also touch XCH — report that overlap explicitly). Per-leg:
--   * XCH leg            -> 'XCH'
--   * NFT leg (is_nft)   -> 'RWA' if nft_meta.collection_name in the curated RWA
--                            list, else 'NFT'
--   * CAT leg            -> its category from the mapping; default 'Unclassified'
-- The CAT mapping is description-driven (built in research/dexie-offers/findings/asset-categories.csv).
-- The RWA collection list is the curated real-estate + GPU set reused verbatim
-- from 13-breakdowns.sql.

-- ---------------------------------------------------------------------------
-- Per-offer x distinct-category membership, then share of all 833,145 offers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE asset_cat AS
  SELECT asset_id, category FROM read_csv('research/dexie-offers/findings/asset-categories.csv', header=true);

CREATE OR REPLACE TEMP TABLE rwa_collections AS
  SELECT * FROM (VALUES
    ('2405 Pollen Way'),('336 Sarava Ln'),('2428 Egret Dr'),('621 Martha Ave'),
    ('1050 44th Ave N'),('147 Coach Dr'),('421 Shelby St'),('1527 White Bluff Rd'),
    ('Pantheon 4090'),('FarmGPU 4090')
  ) AS t(collection_name);

-- One row per (offer, category) it touches.
CREATE OR REPLACE TEMP TABLE offer_category AS
WITH leg_cat AS (
  SELECT DISTINCT
    l.offer_id,
    CASE
      WHEN l.is_nft THEN
        CASE WHEN nm.collection_name IN (SELECT collection_name FROM rwa_collections)
             THEN 'RWA' ELSE 'NFT' END
      WHEN l.asset_id = 'xch' THEN 'XCH'
      ELSE coalesce(ac.category, 'Unclassified')
    END AS category
  FROM legs l
  LEFT JOIN asset_cat ac ON ac.asset_id = l.asset_id
  LEFT JOIN nft_meta nm  ON nm.offer_id = l.offer_id AND nm.asset_id = l.asset_id
)
SELECT DISTINCT offer_id, category FROM leg_cat;

-- Share of ALL 833,145 offers per category (overlapping; XCH ~76.5%).
SELECT category,
       count(DISTINCT offer_id) AS offers,
       round(100.0 * count(DISTINCT offer_id) / 833145, 2) AS pct_of_all_offers
FROM offer_category
GROUP BY category
ORDER BY offers DESC;

-- Export the same, sorted desc (this is the deliverable the chart reads).
COPY (
  SELECT category,
         count(DISTINCT offer_id) AS offers,
         round(100.0 * count(DISTINCT offer_id) / 833145, 2) AS pct_of_all_offers
  FROM offer_category
  GROUP BY category
  ORDER BY offers DESC
) TO 'research/dexie-offers/findings/data/15-category-shares.csv' (HEADER, DELIMITER ',');

-- ---------------------------------------------------------------------------
-- Audit: Unclassified share weighted by CAT offer activity (per-leg, not per-offer).
-- Confirms the mapping leaves only a small tail unclassified.
-- ---------------------------------------------------------------------------
WITH co AS (
  SELECT l.asset_id, count(DISTINCT l.offer_id) AS offers
  FROM legs l WHERE l.is_nft = false AND l.asset_id <> 'xch'
  GROUP BY l.asset_id
)
SELECT coalesce(ac.category,'Unclassified') AS category,
       count(*) AS tokens,
       sum(co.offers) AS cat_leg_offers,
       round(100.0 * sum(co.offers) / sum(sum(co.offers)) OVER (), 2) AS pct_cat_activity
FROM co LEFT JOIN asset_cat ac ON ac.asset_id = co.asset_id
GROUP BY 1 ORDER BY cat_leg_offers DESC;
