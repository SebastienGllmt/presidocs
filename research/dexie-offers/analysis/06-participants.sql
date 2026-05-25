-- 06-participants.sql — Thesis O1: participants & concentration behind 833k offers.
-- Run read-only: ./tools/duckdb -readonly generated/offers.duckdb -c ".read research/dexie-offers/analysis/06-participants.sql"
-- The heavy coin-graph connected-component computation lives in
-- research/dexie-offers/analysis/06-participants.ts (union-find). The queries here (a) document
-- the graph inputs, and (b) compute every NON-graph number in the finding.
-- Snapshot 2026-05-23. Numbers >30 rows -> research/dexie-offers/findings/data/06-participants-*.csv.

-------------------------------------------------------------------------------
-- Q0. IDENTITY IS THE HARD LIMIT. Offers expose no maker address.
--   mempool.originator.puzzle_hash is NOT loaded into the substrate (it is in the
--   raw dump). Independently verified from generated/dexie-offers-dedup.jsonl:
--   0.66% of offers carry an originator puzzle_hash, and only 3 DISTINCT values
--   exist across the whole dataset. known_taker is only the TibetSwap AMM.
--   => Address-based user counting is impossible. (Fact, confirmed.)
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- Q1. COIN-GRAPH INPUTS. Coins are single-use, so two settled offers share a
--   coin_id only via a CHANGE-CHAIN. Multiplicity distribution of shared coins:
--   (a genuine change coin is spent exactly once => links at most 2 offers; any
--   coin shared by many offers is a structural artifact, not a wallet link).
-------------------------------------------------------------------------------
SELECT 'Q1_coin_multiplicity' AS q;
WITH co AS (SELECT coin_id, count(DISTINCT offer_id) AS k FROM coins GROUP BY coin_id)
SELECT
  CASE WHEN k=1 THEN '1 (single-use)' WHEN k=2 THEN '2 (change-chain)'
       WHEN k<=5 THEN '3-5' WHEN k<=10 THEN '6-10' WHEN k<=20 THEN '11-20'
       WHEN k<=50 THEN '21-50' WHEN k<=200 THEN '51-200' ELSE '200+ (hub/artifact)' END AS mult_bucket,
  count(*) AS n_coins, sum(k) AS total_offer_links, max(k) AS max_k
FROM co GROUP BY mult_bucket ORDER BY min(k);

-- Q1b. The change-chain reading validated: for coins shared by exactly 2 offers,
--   the two settlements are separated by a median ~5h gap (A settles -> change
--   funds B -> B settles later). Consistent with sequential single-wallet use.
SELECT 'Q1b_changechain_timing' AS q;
WITH pc AS (SELECT coin_id FROM coins GROUP BY coin_id HAVING count(DISTINCT offer_id)=2),
p AS (SELECT c.coin_id, c.date_completed,
        row_number() OVER (PARTITION BY c.coin_id ORDER BY c.date_completed) rn
      FROM coins c JOIN pc USING (coin_id))
SELECT count(DISTINCT a.coin_id) AS n_pair_coins,
       median(epoch(b.date_completed)-epoch(a.date_completed))/60.0 AS median_gap_min
FROM (SELECT * FROM p WHERE rn=1) a JOIN (SELECT * FROM p WHERE rn=2) b USING (coin_id);

-- NOTE: connected-component results (n_components, sizes, concentration, and the
-- MAX_MULT cap sensitivity sweep) are produced by 06-participants.ts and written
-- to 06-participants-component-dist.csv / -concentration.csv / -cap-sensitivity.csv.
-- Headline at strict cap=2 (pure change-chain): only 19,838 offers (2.38%) link to
-- ANYTHING; 9,846 components; largest component = 6 offers. Even at a generous
-- cap=50, only 15.67% link and the largest component is 226 offers.

-------------------------------------------------------------------------------
-- Q2. PROXY A — NFT creator population (creator_id DID). A creator DID can mint a
--   whole collection, so this counts *creators*, not collectors/traders.
-------------------------------------------------------------------------------
SELECT 'Q2_creator_population' AS q;
SELECT
  count(*) AS nft_legs,
  count(*) FILTER (WHERE creator_id IS NOT NULL) AS legs_with_creator,
  avg(CASE WHEN creator_is_did THEN 1.0 ELSE 0 END) AS frac_legs_did,   -- DID-adoption rate
  count(DISTINCT creator_id) AS distinct_creators,
  count(DISTINCT creator_id) FILTER (WHERE creator_is_did) AS distinct_did_creators,
  count(DISTINCT collection_id) AS distinct_collections,
  count(DISTINCT asset_id) AS distinct_nft_assets
FROM nft_meta;

-- Q2b. Creator concentration (top-N DIDs' share of NFT legs).
SELECT 'Q2b_creator_concentration' AS q;
WITH c AS (SELECT creator_id, count(*) n FROM nft_meta WHERE creator_id IS NOT NULL GROUP BY creator_id),
tot AS (SELECT sum(n) t FROM c)
SELECT 1 AS top_n, (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 1)) n,
       (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 1))*100.0/(SELECT t FROM tot) pct
UNION ALL SELECT 10, (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 10)),
       (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 10))*100.0/(SELECT t FROM tot)
UNION ALL SELECT 50, (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 50)),
       (SELECT sum(n) FROM (SELECT n FROM c ORDER BY n DESC LIMIT 50))*100.0/(SELECT t FROM tot)
ORDER BY top_n;

-------------------------------------------------------------------------------
-- Q3. PROXY B — the AMM as a single mega-participant. tibet2 is ONE contract that
--   is the counterparty to a huge share of all offers.
-------------------------------------------------------------------------------
SELECT 'Q3_amm_mega_participant' AS q;
SELECT
  count(*) FILTER (WHERE coalesce(known_taker_source,'')='tibet2') AS tibet2_offers,
  count(*) AS total_offers,
  count(*) FILTER (WHERE coalesce(known_taker_source,'')='tibet2')*100.0/count(*) AS pct_of_all,
  count(*) FILTER (WHERE coalesce(known_taker_source,'')='tibet2' AND date_completed>='2025-04-01')*100.0
    / nullif(count(*) FILTER (WHERE date_completed>='2025-04-01'),0) AS pct_since_apr25
FROM offers;

-------------------------------------------------------------------------------
-- Q4. PROXY C — bot-vs-human SHARE across time via the 01-amm fingerprint
--   (sub-minute fill AND continuous >1e-3 XCH amount) on single-pair XCH<->CAT.
--   Shows automation share BEFORE the tibet2 label existed (2023-24), so the
--   "few automated agents, not 833k humans" reading predates the AMM label.
-------------------------------------------------------------------------------
SELECT 'Q4_botshare_yearly' AS q;
WITH base AS (
  SELECT o.id, o.date_completed,
    (epoch(o.date_completed)-epoch(o.date_found))/60.0 AS ttf_min,
    coalesce(o.known_taker_source,'')='tibet2' AS is_tibet,
    (SELECT l.amount FROM legs l WHERE l.offer_id=o.id AND l.asset_id='xch' LIMIT 1) AS xch_amt
  FROM offers o
  WHERE o.is_single_pair
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.asset_id='xch')
    AND EXISTS (SELECT 1 FROM legs l WHERE l.offer_id=o.id AND l.asset_id<>'xch' AND NOT l.is_nft)
),
flagged AS (
  SELECT *, ((ttf_min<1.0) AND (abs(xch_amt*1000-round(xch_amt*1000))>1e-9)) AS botlike
  FROM base WHERE xch_amt IS NOT NULL
)
SELECT strftime(date_completed,'%Y') AS yr, count(*) n_xch_cat,
  sum(is_tibet::int) labeled_amm,
  sum((botlike AND NOT is_tibet)::int) unlabeled_botlike,
  sum(botlike::int) total_botlike,
  round(sum(botlike::int)*100.0/count(*),2) pct_botlike
FROM flagged GROUP BY yr ORDER BY yr;
