# 30 — Editorial + data-integrity review (pre-publication pass)

Reviewer pass over `posts/offer-files-data.html` against `research/dexie-offers/README.md`,
`research/dexie-offers/findings/*.md`, the committed `research/dexie-offers/analysis/*.sql`, and live spot-checks
against `generated/offers.duckdb`. **No files were edited.** Everything is ranked by
impact. Section/chart `id`s cited so fixes are easy to locate.

**Verdict up front:** the post is in strong shape — the post-correction figures
(USDSC "depegged", BYC stablecoin, maker-identity "data gap", ~4,620 blocks/day,
`mempool_cost` 173T / ~0.5% capacity / ~10% actual compute) all propagated correctly
into the post; no stray "307T", "~1%", "fake", or "anonymous" survives. The headline
numbers reproduce against the data. There is **one real data-integrity bug** (the NFT
USD-value chart is built on the very stablecoin the post tells readers to reject) and
a cluster of smaller inconsistencies/coverage gaps. **Not yet publication-ready** —
fix the NFT-USD chart (B1) and decide on the USD-volume gap (A1) first; the rest are
polish. See Section C.

---

## A. Coverage gaps (prioritized)

### A1 — How much money actually moved? (No USD/XCH total volume anywhere). **SEVERITY: HIGH**
- **Business question (every persona):** A market maker, an investor judging
  ecosystem health, and a competitor to dexie all immediately ask "how big is this
  market in dollars?" The post gives counts (833k trades), a median trade (~$11), and
  a fee total (~1.08M XCH of volume is mentioned *once*, only in the fees figcaption,
  `chart-fees`), but **never states total settled volume in USD**, nor a volume time
  series in dollars. A reader cannot size the opportunity.
- **Can our data answer it?** *Partially, and better than the post implies.* We have a
  validated XCH/USD oracle (2024-05→) and ~1.08M XCH of measured XCH-leg volume. A
  rough all-time USD volume (and a per-year USD series for 2024+) is computable. The
  honest limit: pre-2024-05 USD is unreliable (no trusted stablecoin — see B1), and
  CAT/CAT and NFT-token volumes are hard to value. But an order-of-magnitude "the
  whole market has cleared on the order of $X" is within reach and is the single most
  conspicuous omission.
- **Fix:** add one sentence/stat with all-time XCH volume (~1.08M XCH already
  computed) and a dollar figure for the 2024+ period where the oracle is trustworthy,
  with the floor caveat. Even "~$Xm all-time, dominated by the 2024-25 period" closes
  the gap.

### A2 — "Could I fill a large order?" — depth / order-size distribution. **SEVERITY: MED-HIGH**
- **Business question (MM, large trader):** The post says depth is "thin" and quotes
  "~$800/day median volume on the liquid pair" (`mm-heading` stat grid), but never
  shows the *size distribution of trades* in dollars or the largest fillable clip. A
  whale cannot tell whether a $50k order is fillable.
- **Can our data answer it?** *Yes.* `legs.amount` gives per-trade size; the XCH-leg
  size quantiles already exist in 01-amm.md (p95 ~9 XCH AMM / ~5 XCH P2P). A "trade
  size distribution / p95 / max clip" stat is a cheap add and directly answers the MM
  question the whole Part III is framed around.
- **Note:** the "~$800/day median volume" is a strong, decision-relevant number that
  is *buried* in a stat grid; it deserves more prominence for the MM persona.

### A3 — Is the ecosystem growing or dying? (trajectory is left ambiguous). **SEVERITY: MED**
- **Business question (investor, project deciding to launch):** The volume chart
  (`chart-volume`) shows flat-to-noisy 20-40k trades/month; the *actual-compute* chart
  frames offers as a rising share only *because the rest of the chain collapsed ~4x*
  (`chart-actual-compute`, `plumb-actual`). Net read: the chain is shrinking and offer
  files are "the last thing standing," which is a bearish signal a launching project
  needs spelled out. The post leans into "messier and more alive" framing in the
  conclusion (`takeaways-body`) but the data (collapsing chain, NFT share down to
  6-17% in 2026, go4.me bust, games dead) points to *contraction*. The post never
  resolves "alive" vs "the chain emptied out."
- **Can our data answer it?** *Yes — it already has the pieces*; this is a
  framing/synthesis gap, not a data gap. A trader/investor would want one honest
  paragraph: total chain activity is falling, offer volume is flat, NFTs are cooling,
  and the growth is concentrated in AMM/stablecoin flow. Currently the bearish read is
  scattered and the conclusion is upbeat.

### A4 — MM expected PnL / competition: APR is shown but net-of-pickoff economics aren't. **SEVERITY: MED**
- **Business question (MM):** The post says spreads are tight, stale quotes get picked
  off, *but* dexie pays 16-31% APR (`mm-incentive`), and the subsidy shrank ~5x in USD
  terms. What it does **not** give is the punchline a MM needs: *is liquidity provision
  net-profitable here, after pick-off losses and against the top-100-take-86%
  competition?* The ingredients are all present (APR, concentration, pick-off, the
  $355/mo-and-falling subsidy) but never combined into a verdict.
- **Can our data answer it?** *Partially.* Pick-off *losses* aren't directly
  measurable (settled-only, no cancelled-quote book — flagged correctly in 12). But the
  post could at least say "the subsidy is now ~$355/mo split across a field where the
  top 100 take 86% — for all but a few dozen pros, the incentive no longer covers
  pick-off." This is the most decision-relevant synthesis for the MM persona and it's
  left implicit.

### A5 — Tooling/competitor view: dexie's own take rate and dependence on TibetSwap. **SEVERITY: LOW-MED**
- **Business question (competitor to dexie):** How much does dexie *earn* (service
  fees ~2,860 XCH all-time per `21`/`20-fees`), and how dependent is the whole market
  on one AMM (TibetSwap) and one routing feature (Combined Swap)? The post has all of
  this (59% of TibetSwap fills are Combined Swaps; ~half of all offers are Combined
  Swaps) but never frames the **single-point-of-dependence / concentration risk** a
  competitor or risk-conscious project would want. Minor; the facts are present, the
  framing isn't.

### A6 — NFT creator: which collections/royalty levels actually sustain resale. **SEVERITY: LOW**
- **Business question (NFT project deciding to launch):** The post proves royalties are
  honored (`chart-royalties`) and that most collections are mint-spike-then-decay
  (finding 02 Chart 5D), but doesn't give a launching creator the practical read:
  resale is thin, near-zero-price, and XCH-denominated (so USD royalty income
  collapsed with XCH). Partially covered by the sticky-floor section; could be one
  explicit sentence. Data fully supports it.

---

## B. Inconsistencies, contradictions & likely errors

### B1 — **NFT USD-value chart is built on USDSC, the coin the post tells readers to reject.** **SEVERITY: HIGH (data-integrity)**
- **Where:** `chart-nft-price` (the red "Median USD value" line) and its prose
  `nft-price` ("from ~$7-9 in 2022-24 to ~$1-2.50 in 2025-26"); narration `chart-nft-price`
  ("the dollar value of that floor quietly collapsed"). Source: `research/dexie-offers/analysis/02-nft.sql`
  lines 101 & 159 — the FX denominator is `l.code IN ('wUSDC.b','USDSC','wUSDC','wUSDT')`,
  spanning **all** months.
- **The contradiction:** finding `03-price-oracle.md` and `11-usd-denominated.md`, and
  the post itself (`oracle-usdsc`, `stable-body`, the stablecoin table), state that
  **USDSC is depegged and must be excluded**, and that **"there is no trustworthy
  XCH/USD oracle from this data before warp.green coins existed (2024-05-22)."** Yet the
  NFT-USD line plots dollar values back to **2022-06**, where the *only* available
  stablecoin is USDSC.
- **Verified against the data (live query):**
  | Month | USDSC implied XCH/USD | warp implied | n_warp |
  |---|---|---|---|
  | 2022-07 | $43.7 | — | 0 |
  | 2023-06 | $33.6 | — | 0 |
  | **2024-01** | **$77.9** | — | 0 |
  | 2024-08 | $1000.0 | $15.3 | 231 |
  So the 2022-24 portion of the NFT-USD line is 100% USDSC. The 2024-01 point implies
  XCH ≈ $78 (real XCH was ~$30) — visibly contaminated. 02-nft.md's own table shows
  `2024-01 | XCH/USD 78.00`, an obvious depeg artifact.
- **Why it half-works and is still wrong:** USDSC was roughly on-peg in 2022 (so the
  2022 dollar values are coincidentally plausible), but it drifts badly from late-2023
  on. The headline "$7-9 in 2022-24" leans on the contaminated middle period.
- **Which is right:** the warp-only oracle (and the post's own rule). The NFT-USD
  series should either (a) only show USD value from 2024-05 onward (warp coins), or
  (b) be explicitly caveated that pre-2024-05 USD is USDSC-derived and unreliable —
  but option (b) is awkward given the post elsewhere brands USDSC junk. Cleanest fix:
  recompute `med_usd` using warp-only FX (NULL before 2024-05), or drop the pre-2024-05
  USD line and keep only the XCH line there.
- **Severity HIGH** because it's a load-bearing visual ("collapsing dollar value" is a
  named insight) that directly contradicts a rule the post states three times.

### B2 — Memecoin/game shares: post (27%/20%) contradict findings 04 (4.7%/7.4%) and the taxonomy review's own estimates (19%/18%). **SEVERITY: MED**
- **Where:** post `traded-heading` prose + `chart-categories` + the category table
  (Memecoin 27%, Game-economy 20%, Stablecoin 8%). Narration `tokens`/`chart-categories`.
- **The conflict:**
  - `04-concentration.md` Finding 3 (the "corrected 2026-05-24" table): **meme_cat
    4.7%, game_cat 7.4%, stablecoin 7.8%** — explicitly using a *conservative* meme set
    (only emoji-cat/BEPE/GYATT) and a narrow game set (AL*+G4M).
  - `14-token-taxonomy-review.md` estimates: **Memecoin ~19.3%, Game ~17.9%.**
  - The committed `asset-categories.csv` → `15-categorize.sql` → `15-category-shares.csv`
    produces **Memecoin 27.46%, Game 19.52%, Stablecoin 8.13%** (the post's numbers).
- **Which is right:** I re-ran `15-categorize.sql`'s logic against the live data; the
  post's 27%/20%/8% **reproduce exactly** from the committed mapping. The 27% memecoin
  is driven by SBX (22.7k), BEPE (18.8k), MBX (17.7k), HOA (16.8k), 🐈 (11.7k), MJO
  (11.5k), CH21 (10.0k), GYATT, PEPE, $CHIA, 🌱, etc. — a *broad* memecoin set, which is
  defensible per the taxonomy review's own "everything aspirational → Memecoin" rule.
  **So the post is correct; finding 04 is stale** (it never adopted the final broad
  taxonomy and still shows the old conservative numbers).
- **Tension to surface for the reader:** "memecoins are the biggest token category
  (27%)" vs "game economies (20%)" vs the AMM/NFT framings can read as three different
  "what this market is." The post mostly handles this well via overlapping-denominator
  language ("counted in every category it touches, bars sum past 100%"), but the
  *narration* ("memecoins are the single biggest token category") states it flatly
  without the overlap caveat the prose carries. Low-risk but worth a beat.
- **Action:** no post change needed for correctness, but **update `04-concentration.md`
  Finding 3** so the findings corpus doesn't contradict the published chart (a future
  reader/auditor will trip on 4.7% vs 27%). Optionally add one narration clause noting
  these are overlapping shares.

### B3 — "Top 100 take 86%" (prose/narration) vs chart shows 85.7%; "~1 in 5" vs "46%" for the AMM. **SEVERITY: LOW**
- `mm-incentive`/`chart-mm-rewards`: figcaption + narration say "top 100 took 86%";
  chart label is **85.7%**. Rounding, fine, but the narration also says "the top
  hundred take eighty-six percent" — consistent enough.
- `who-body` and narration `who-body` describe the AMM as "~1 in 5 of all offers (46%
  of recent ones)" / "one bot is a fifth of all trades." The 46% is *since 2025-04*
  (354k offers); "~1 in 5 of all offers" is the all-time figure (163,603/833,145 =
  19.6%). Both are stated, but a careless reader could conflate them. The phrasing is
  technically correct; consider tightening. **Verified:** 163,603 tibet2 fills / 833,145
  = 19.6% all-time ✓; 46.2% since 2025-04 ✓.

### B4 — "One offer every five blocks" overstates by ~35%. **SEVERITY: LOW**
- **Where:** `plumb-throughput` ("roughly one offer every five Chia blocks") and
  narration `chart-throughput` ("roughly one offer every five blocks").
- **Check:** peak ~69 s/trade (verified: 2025-08, 38,945 offers → 66-69 s/trade
  depending on 30 vs 31-day month ✓) ÷ ~18.7 s/block (the corrected ~4,620 blocks/day)
  = **~3.7 blocks per offer**, not 5. The "block every ~19 seconds" in the same
  sentence is right; the division is loose. Suggest "every ~4 blocks" or "every 3-4
  blocks."

### B5 — NFT share stated as 38.1% (317,210) in prose but the category chart/CSV shows 37.77% (314,675). **SEVERITY: LOW**
- **Where:** `nft-body` & `02-nft.md` use **38.07% / 317,210** (legs.is_nft, verified
  live: 317,210, 38.07% ✓). The `chart-categories` / `15-category-shares.csv` NFT slice
  is **37.77% / 314,675** because `15-categorize.sql` splits ~2,540 offers into the
  separate **RWA** bucket (NFT 314,675 + RWA 2,540 ≈ 317,215 ≈ the 317,210 total).
- **Which is right:** both — they're the same NFTs minus the RWA carve-out. But the
  post shows NFTs as "38%" in the category chart label *and* "38.1%" in prose while the
  underlying chart datum is 37.77%. Harmless rounding, but if an auditor sums the
  chart's NFT+RWA they'll get 38.1% — worth a one-line note that RWA is carved out of
  NFT. **Not an error, just a reconciliation footgun.**

### B6 — Lifecycle: "833,145" (analyzed) vs "~985k settled" (outcomes chart) — is the distinction clear? **SEVERITY: LOW (mostly handled)**
- The post is *mostly* careful: `chart-outcomes` and its figcaption say settled ≈ 985k
  (all-time, dexie's status=4 count), while the analysis set is the **833,145** we
  actually crawled (84.7% of 985k). The dataset section states this. **Verified:**
  833,145 in DB ✓; 985,102 is dexie's reported status=4 count (dataset doc). The one
  place to watch: the outcomes chart says "Settled (filled) ~985k … measured" while the
  report body repeatedly says 833,145 — a reader may wonder why "measured settled" is
  985k but the analysis is 833k. The caveat covers it, but a half-sentence ("we
  analyze 833k of the ~985k settled — 84.7%") right on the outcomes figure would
  remove all doubt. The "~1 in 8 settles" arithmetic checks out (985k/(6.5M+985k+600k)
  ≈ 1 in 8.2 ✓).

### B7 — Narration says "out of 860 fungible tokens, top 5% carry nearly three-quarters"; chart/prose say 73%. Consistent, but "860" vs the Lorenz "top 5% ≈ 43 assets carry 73%". **SEVERITY: NONE (verified consistent)**
- `conc-heading` narration + `chart-lorenz` + prose all agree: 860 CATs, top 5% ≈ 73%,
  bottom 80% < 6% (5.64%), Gini 0.89. Matches `04-concentration.md` exactly. No issue.

### B8 — Stablecoin pie percentages use a different denominator than the 8% category share. **SEVERITY: NONE (verified, but could confuse)**
- `chart-stablecoins` shows wUSDC.b 38.4%, USDSC 29.1%, BYC 28.2% — these are shares of
  *stablecoin-leg appearances* (denominator ~71,973), **not** of the 8.13% stablecoin
  category (67,728 offers). **Verified:** per-code offer counts (27,649 / 20,923 /
  20,325 / 1,720 / 291 / 1,065 LP) reproduce the pie exactly. Internally consistent;
  just two different denominators on the same topic. No fix needed.

---

## Numbers independently re-derived against `generated/offers.duckdb` (all HELD unless noted)
- Total offers **833,145** ✓; total legs 1,812,373 ✓
- XCH share **76.5%** ✓ (chart says 77%/76.5% — rounding ok)
- Median trade **0.2 XCH** ✓ (single-pair and all-XCH-leg both 0.2)
- NFT involvement **38.07% / 317,210** ✓; single-pair NFT/XCH route 227,225 (sell-side
  224,879 per finding 02) ✓
- AMM share since 2025-04 **46.2%** (354,075 offers) ✓
- Stablecoin per-code counts (27,649 / 20,923 / 20,325 / 1,720 / 291) ✓
- Memecoin **27.46%**, Game **19.52%**, Stablecoin **8.13%** from committed mapping ✓
  (these are the post's numbers; they reproduce — see B2 re: stale finding 04)
- Network fees total **129.7 XCH** ✓ (~130); zero-fee **81.4%** ✓
- Distinct NFT creators **891** ✓; reward-maker addresses **12,712** ✓
- Peak throughput **66-69 s/trade** (2025-08, 38,945 offers) ✓ ("69s" claim holds)
- USDSC vs warp XCH/USD divergence (B1) — USDSC reads $43.7→$1000, warp ~$15-27 ✓
- "1 in 8 settles" arithmetic ✓; "one offer every 5 blocks" → actually ~3.7 (B4)
- AMM-vs-P2P dispersion 0.149 vs 0.127 (AMM not tighter) ✓ matches finding 10
- All 64 narration `<mark name>` have matching article `id`s ✓ (no orphans)

## Stale-correction sweep (the 6 known mid-flight fixes) — all CLEAN in the post
- No "307T" / "307.75T" in the post (only legit "307" in SVG path coords) ✓
- No "capacity ~1%" — post uses **~0.53% / ~0.64%** capacity and **~6%→~35%, ~10%
  all-time** actual compute (`chart-blockspace`, `chart-actual-compute`) ✓
- No "fake" peg — USDSC consistently "depegged / custodian failed" ✓
- No "anonymous" — maker identity framed as "data gap, not anonymity; Chia is public"
  (`who-body`) ✓
- BYC consistently a **stablecoin** (Chia-native CDP, ~$0.98) ✓
- Block rate ~4,620/day reflected in `chart-blockspace` figcaption ✓
- *Findings-doc relics (not in post, but flag for corpus hygiene):* `11-usd-denominated.md`
  still calls USDSC a "fake $1 peg"; `04-concentration.md` Finding 3 still shows the
  pre-taxonomy 4.7%/7.4% category numbers (see B2); `09-onchain-cost.md` Finding 6
  retains the superseded 307.75T/~1% values (marked SUPERSEDED, so acceptable).

---

## C. Overall assessment

**Publication-readiness: NOT YET — one HIGH data bug to fix, one HIGH gap to decide,
then it's ready.** The post is unusually rigorous: caveats are honest and pervasive,
the corrections all landed, and every headline number I re-queried reproduced. The
problems are concentrated and fixable.

**Top fixes, in priority order:**
1. **B1 (HIGH, data integrity):** The NFT USD-value line uses USDSC pre-2024-05 — the
   exact coin the post brands unusable. Recompute `med_usd` warp-only (NULL before
   2024-05) or truncate the USD line to the trustworthy window. This is the only true
   *bug* and it undercuts a named insight.
2. **A1 (HIGH, gap):** Add total USD volume (and/or a 2024+ USD volume series). The
   most glaring "I can't decide without this" omission for every persona.
3. **A3 + A4 (MED, synthesis):** Resolve "alive vs. the chain emptied out" honestly,
   and give the MM a one-line net-economics verdict (subsidy now ~$355/mo, top-100
   take 86%). The data is already in hand; this is framing.
4. **B2 (MED, corpus consistency):** Update `04-concentration.md` to the final 27%/20%
   taxonomy so the findings don't contradict the published chart; optionally add the
   "overlapping shares" caveat to the narration.
5. **B4 + B5 + B6 (LOW, polish):** "every ~4 blocks" not five; one line noting RWA is
   carved out of the 38% NFT bucket; one clause on the figure reconciling 833k analyzed
   vs ~985k settled.

**Issue count by severity:** HIGH: 3 (A1, B1; and A2 is MED-HIGH). MEDIUM: 4 (A3, A4,
B2; A2 borderline). LOW / none-but-noted: 7 (A5, A6, B3, B4, B5, B6, B8). Plus 3
findings-doc relics to tidy for corpus hygiene.
