# T8 (O4) — Offer expiry: who sets a TTL, and what it says about the two markets

**Thesis (as briefed).** Offer expiry is a sophistication/automation signal — bots
set expiries, humans listing NFTs don't — and it sharpens the two-markets picture.

**Verdict.** The briefed direction is **half-right and half-backwards**, which is
itself the interesting finding. Setting an expiry *is* a tooling/sophistication
signal, but it is **NOT** a signal of the fast-AMM-bot cluster. The AMM (TibetSwap)
almost never sets a date expiry; the **human/non-AMM side sets it ~4× more often**.
And the single biggest driver of expiry adoption is **NFT listings** (a late-2025
go4.me/G4M tooling wave), not bots. The correct reading: expiry is a **client-tooling
fingerprint that cuts *within* the slow NFT market** — separating a faster, more
sophisticated NFT-listing sub-population from hand-rolled listings — rather than a
clean divider between the two markets.

**Substrate.** All numbers from `generated/offers.duckdb` (833,145 completed offers,
snapshot 2026-05-23) via `research/dexie-offers/analysis/08-expiry.sql`. Monthly series in
`research/dexie-offers/findings/data/08-expiry-coverage-by-month.csv`.

---

## Coverage caveats (apply to every number)

- 84.7% of global, **biased to dropping the oldest offers of the busiest pairs**.
  Early-timeline counts are floors — but expiry didn't exist before late 2023, so
  the bias barely touches this thesis (the relevant era is well-covered).
- **`date_found` is dexie's first-seen, NOT offer creation** (per 05-microstructure).
  All time-to-fill numbers are first-seen→settled, a floor on true resting time.
  Rows with `date_completed < date_found` (first-seen lag) are excluded from TTF stats.
- `known_taker_source` (`tibet2`) only recorded **2025-04+**; tibet correlations are
  restricted to that era and AMM share is a floor (only `tibet2` is labeled).
- **An expiry that fired removes the offer from this dataset** (it never settles, so
  it's not `status=4`). So "fills faster with expiry" is partly **survivorship**:
  expiry mechanically truncates the long resting tail. Stated carefully below.

---

## Finding 1 — Two expiry mechanisms, mutually exclusive; only ~8% of offers use either

**Confidence: HIGH (direct counts).**

Offers can carry a **timestamp** expiry (`date_expiry`) or a **block-height** expiry
(`block_expiry`) — and in this data the two are **mutually exclusive** (0 offers have
both). The vast majority set neither.

| field | offers | % of all |
|---|---|---|
| `date_expiry` (timestamp TTL) | 61,524 | 7.39 |
| `block_expiry` (block-height TTL) | 4,804 | 0.58 |
| both | 0 | 0.00 |
| **neither** | **766,817** | **92.04** |

`date_expiry` is a genuine forward-looking TTL: median **~86,305 s (~1 day)** after
settlement, p10 ~14 min, p90 ~7 days; essentially all (61,169 / 61,524) point into
the future relative to settlement, with a single far-future "never" sentinel (year
2297). 355 settled at/after their stated expiry (clock/indexing edge cases — <0.6%).
`block_expiry` ranges blocks 4,560,518 → 8,762,840; 100 settled past it (same edge).

**`date_expiry` is the dominant mechanism (93% of all expiry use)** — the rest of
this write-up focuses on it; `block_expiry` is a thin, separate minority.

---

## Finding 2 — Expiry didn't exist until late 2023, then a sharp NFT-driven spike

**Confidence: HIGH (direct counts).** Full series:
`data/08-expiry-coverage-by-month.csv` (53 rows).

Zero offers carried any expiry before **2023-09** (first `date_expiry` 2023-09-26,
first `block_expiry` 2023-11-22). Adoption then ramped slowly to ~5%, until a sharp
spike in **2025-08 → 2025-11** peaking at **43% in 2025-09**, relaxing to ~16% by
2026-05.

Selected months (% of settled offers carrying each expiry type):

| month | n | % date_expiry | % block_expiry | % any |
|---|---|---|---|---|
| 2023-08 | 16,228 | 0.00 | 0.00 | 0.00 |
| 2023-10 | 20,190 | ~4.0 | ~0.2 | 4.24 |
| 2024-11 | 14,672 | 4.46 | 1.83 | 6.29 |
| 2025-07 | 28,799 | 2.14 | 1.53 | 3.67 |
| **2025-08** | 38,945 | **24.84** | 1.34 | 26.19 |
| **2025-09** | 34,356 | **42.01** | 0.87 | **42.88** |
| 2025-10 | 28,959 | 21.56 | 1.22 | 22.78 |
| 2025-11 | 26,256 | 14.46 | 0.41 | 14.87 |
| 2026-01 | 24,778 | 2.53 | 0.38 | 2.91 |
| 2026-05 | 22,687 | 15.70 | 0.33 | 16.04 |

The first appearance (late 2023) coincides with offer-tooling that exposes an expiry
field; the 2025-08+ spike is a discrete adoption wave, not organic drift (Finding 4).

### Chart 1 — Expiry adoption over time (monthly % carrying any expiry)

Data: `research/dexie-offers/findings/data/08-expiry-coverage-by-month.csv` (full 53-row series).
Shape: flat-zero through 2023-08 → low single digits 2023-10..2025-07 → spike to ~43%
(2025-09) → decay to ~16% (2026-05). Two stacked components (`date_expiry` dominant;
`block_expiry` a persistent ~1% floor).

---

## Finding 3 — The AMM does NOT set expiry; the human side does (~4×). Thesis reversal

**Confidence: HIGH (direct counts), within the labeled era (2025-04+).**

This is the decisive test of the "bots set expiries" hypothesis. Restricting to the
era where the taker is labeled, and splitting by whether the **TibetSwap AMM** filled
the offer:

| taker | offers | % any expiry | % date_expiry | % block_expiry |
|---|---|---|---|---|
| **non-tibet** (human/other) | 190,918 | **21.17** | **20.26** | 0.92 |
| **tibet AMM** | 163,603 | 6.44 | 5.39 | 1.06 |

The fast-AMM cluster — the canonical "bot" layer from 05-microstructure — sets
`date_expiry` on only **5.4%** of its fills, versus **20.3%** on the non-AMM side.
**So expiry is the opposite of an AMM-bot fingerprint.** `block_expiry` is the only
component that's roughly even (~1% both sides) — a thin, possibly more bot-flavored
stripe, but too small to carry the thesis.

(Mechanistic read, INFERENCE: an AMM matches against a live pool the instant the
offer hits the network, so a TTL is pointless — there's no resting period to bound.
A human listing an NFT *wants* a TTL so a stale listing doesn't get hit at an old
price weeks later. Expiry is a *resting-order* feature, and the AMM doesn't rest.)

---

## Finding 4 — The expiry wave is an NFT/go4.me tooling artifact

**Confidence: HIGH (direct counts) on the facts; MEDIUM on the "go4.me client" attribution.**

The 2025-08..11 spike is overwhelmingly **NFTs**. In that window:

| category | offers | with date_expiry | % date_expiry |
|---|---|---|---|
| NFT | 67,932 | 32,074 | **47.21** |
| fungible | 60,584 | 2,074 | 3.42 |

Nearly half of all NFT offers in the spike set a date expiry, vs ~3% of fungibles.
The asset codes among those expiry offers are dominated by the **go4.me / G4M**
ecosystem (`TIBET-G4M-XCH` 10,809 offers, `G4M` 10,268; the 32,074 `NULL`-code legs
are the NFTs themselves). This matches a marketplace/client (go4.me's NFT wave, also
flagged in 02-nft / 04-concentration) shipping default-TTL listings — a **tooling
fingerprint**, not a behavioral shift across users. This is *why* the aggregate
"NFT-involved set expiry more than fungible" (11.74% vs 5.64%) holds despite NFTs
being the slow market: the high-expiry era is the NFT-wave era.

---

## Finding 5 — Expiry correlates with faster fills — but via tail-truncation, not bot-speed

**Confidence: HIGH (shape); MEDIUM (absolute times = first-seen-relative).**
Excludes 19,646 first-seen-lag rows (`date_completed < date_found`).

Naively, offers with an expiry fill faster on the median:

| group | offers | median TTF | % sub-minute | % >30 day |
|---|---|---|---|---|
| `block_expiry` | 4,795 | **262 s** | 25.8 | 0.0 |
| `date_expiry` | 60,698 | **770 s** | 30.2 | 1.2 |
| no expiry | 748,006 | 2,824 s | **32.5** | **15.6** |

But note the **sub-minute share is *lower*** for expiring offers — they are *not* the
instant-AMM population. The faster median comes from the collapse of the **>30-day
tail** (15.6% → ~1%): an expiry mechanically prevents an offer from sitting for
months (and, by survivorship, any offer whose TTL fired is absent entirely).

**Controlling for category makes the mechanism unambiguous:**

| category | has expiry | offers | median TTF | % sub-min | % >30 day |
|---|---|---|---|---|---|
| fungible | no | 475,738 | 71 s | 46.6 | 7.4 |
| fungible | yes | 28,292 | **73 s** | **46.3** | 0.3 |
| NFT | no | 272,268 | 129,695 s (~36 hr) | 7.9 | 29.7 |
| NFT | yes | 37,201 | **4,574 s (~76 min)** | **17.5** | 1.7 |

- **Fungible:** expiry barely moves anything (median 71→73 s, sub-min 46.6→46.3). The
  AMM/bot market is fast *regardless* of expiry — expiry adds no speed there.
- **NFT:** expiry-setters fill **~28× faster on the median** (36 hr → 76 min),
  more than double the sub-minute rate (7.9→17.5), and shed the month-long tail
  (29.7→1.7). Within the slow human market, an expiry tags a **faster, more tooled
  listing sub-population**.

So expiry is a sophistication signal **inside the NFT/human market**, not a divider
*between* markets. (HIGH that the correlation exists; the causal split between "better
tooling lists at fairer prices that clear faster" vs "TTL truncates the slow ones" is
INFERENCE — both plausibly contribute.)

### Chart 2 — Median time-to-fill, category × expiry (4 bars)

Inline data: fungible/no 71 s; fungible/yes 73 s; NFT/no 129,695 s; NFT/yes 4,574 s.
The story: expiry is inert for fungibles, transformative for NFTs.

---

## Finding 6 — Expiry rarely binds: offers settle with ~a day of slack, few at the wire

**Confidence: HIGH (direct quantiles).** For 60,696 `date_expiry` offers with
`date_expiry > date_found` and `date_completed >= date_found`:

| metric | value |
|---|---|
| median lifetime (date_expiry − date_found) | **27.6 hr** |
| median slack at settlement (date_expiry − date_completed) | **86,305 s (~1 day)** |
| settled in last 10% of window | 3.0% |
| settled in last 1% of window | 0.9% |
| settled within 10 min of expiry | 6.6% |
| settled within 60 s of expiry ("at the wire") | **1.7%** |

The expiry is overwhelmingly a **safety TTL that goes unused** — offers clear well
before it, leaving ~a day of headroom. There **is** a small "at the wire" group
(~1,030 offers within 60 s of expiry; ~4,000 within 10 min) — plausibly last-second
fills of about-to-expire listings — but it's a rounding-error of total flow.

What TTL do people actually pick? The mode is **1–7 days**:

| chosen lifetime | offers |
|---|---|
| <10 min | 3,032 |
| 10–60 min | 7,479 |
| 1–24 hr | 12,431 |
| **1–7 day** | **32,347** |
| 7–30 day | 1,926 |
| >30 day | 3,481 |

### Chart 3 — Distribution of chosen expiry lifetimes (6 buckets)

Inline data above. A 1–7-day TTL dominates — consistent with a marketplace listing
default, not a high-frequency bot quote (which would pick seconds-to-minutes).

---

## Finding 7 — Tie-back to the two-markets thesis

**Confidence: MEDIUM-HIGH (synthesis of the above HIGH-confidence facts).**

05-microstructure framed two layers: a fast AMM/bot layer (sub-minute, fee-paying,
fungible, TibetSwap) over a slow resting layer (NFTs/illiquid CATs, hours-to-months,
zero-fee). Expiry maps onto that as follows:

- It does **not** cleanly separate the two markets. The fast layer (AMM) is the
  *low-expiry* side (5.4%), the slow layer (NFT/non-AMM) is the *high-expiry* side
  (20%+). If anything, expiry inversely correlates with the "bot speed" axis.
- Its real discriminating power is **within the slow NFT market**, where it splits a
  **tooled, fast-clearing listing cohort** (median ~76 min) from **hand-rolled slow
  listings** (median ~36 hr). That's a genuine sophistication axis — just a different
  one than "AMM bot vs human."
- Net: expiry **adds a third texture** rather than reinforcing the existing 2-way
  cut. The market isn't "bots set TTLs, humans don't"; it's "the AMM needs no TTL,
  and a modern NFT marketplace client sets one by default while the AMM and the
  hand-listers do not."

---

## Per-claim confidence summary

| claim | confidence | basis |
|---|---|---|
| 7.4% set date_expiry, 0.6% block_expiry, mutually exclusive, 92% neither | HIGH | direct counts |
| date_expiry is a real forward TTL (median ~1 day ahead of settle) | HIGH | direct quantiles |
| Zero expiry pre-2023-09; spike to 43% in 2025-09, decay to ~16% | HIGH | monthly counts |
| AMM sets date_expiry far less (5.4%) than non-AMM (20.3%) [2025-04+] | HIGH | direct counts, labeled era |
| Spike is NFT/go4.me(G4M)-driven (47% of NFT offers in window) | HIGH (fact) / MEDIUM (client attribution) | counts + asset codes |
| Expiry → faster median, but lower sub-min share; speedup is tail-truncation | HIGH (shape) / MEDIUM (abs time) | counts; date_found caveat |
| Within NFT, expiry-setters fill ~28× faster (36 hr → 76 min) | HIGH (correlation) / INFERENCE (causality) | category-controlled counts |
| Expiry rarely binds: ~1 day median slack, 1.7% settle within 60 s | HIGH | direct quantiles |
| Expiry cuts *within* the NFT market, not *between* the two markets | MEDIUM-HIGH | synthesis |

**Biggest caveat:** an expiry that *fired* removes the offer from this settled-only
dataset, so "expiry → faster" is partly survivorship (the TTL truncates the slow
tail) rather than evidence that expiry-setters are intrinsically faster traders.
Combined with `date_found` being first-seen (not creation), all time-to-fill figures
are first-seen-relative floors. The tibet/AMM split is only valid 2025-04+ and is a
floor on true AMM share (only `tibet2` is labeled).
