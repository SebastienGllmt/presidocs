# Chia Offers — how they work (local reference)

> **Local summary, not verbatim.** Source: <https://chialisp.com/offers/> (the
> official Chialisp docs), retrieved 2026-05-24. For canonical wording and any
> updates, see the URL. Captured so an offline agent has the mechanism on hand.

## What an offer file is

A text string describing a peer-to-peer asset trade. It contains an **incomplete
spend bundle** in **bech32** form (prefix `offer1…`) that can be published,
copied, and accepted by anyone **without modification**. It names the assets
being **offered** and **requested**, enabling trustless trading with no
intermediary and no on-chain footprint until someone accepts it.

## Settlement mechanism

Offers use the **`settlement_payments`** puzzle, whose `notarized_payments`
parameter is shaped like:

```
((N . ((PH1 AMT1 ...) (PH2 AMT2 ...) ...)) ...)
```

`N` is a nonce; each `PH`/`AMT` pair is a puzzle hash + amount (in mojos). The
puzzle emits two condition types:

- `CREATE_PUZZLE_ANNOUNCEMENT` — announces the payments required for the trade to
  complete, enforcing atomicity (the spend fails if either side can't fulfill its
  end).
- `CREATE_COIN` — creates the coins for each payment.

## Partial fills & atomicity

Payments are specified as "a certain puzzle hash for a certain value in mojos,"
**not a specific coin** — so change works, and multiple parties can aggregate
smaller amounts to fill one offer. The maker's and taker's spends **must land in
the same block**, so settlement is simultaneous (no counterparty risk, and MEV
reordering can't split the two halves).

## Lifecycle: creation → acceptance

**Creation (maker):** specify terms (e.g. 1 XCH for 251 CKC) → wallet selects
coins and builds notarized coin payments → a **nonce derived from the sorted coin
IDs** prevents duplication/double-spend → spend bundle pays the settlement puzzle
→ status `PENDING_ACCEPT`.

**Acceptance (taker):** validate the offer and that the maker's coins are unspent
→ build the combined spend bundle → status `PENDING_CONFIRM` → broadcast to
mempool → status `CONFIRMED` once in a block.

## Cancellation (two ways)

- **Off-chain:** just don't share / delete the file (status stays
  `PENDING_ACCEPT`). Useless if a copy is already circulating.
- **On-chain:** **spend the reserved coins**, invalidating the notarized payments
  so no circulating copy can ever be accepted.

## Why it's trustless

"Any alterations to the file will invalidate it," and the only two outcomes are
**acceptance** or **cancellation** — there's no way to tamper with terms or steal
the reserved coins.

## Key terms

- **Nonce** — value derived from all offered coin IDs; prevents offer duplication.
- **Settlement payments puzzle** — the contract that creates + announces payments.
- **Notarized payments** — list pairing nonces with required coin payments.
- **Spend bundle** — the combined maker+taker transaction that atomically executes.

See also: [`chia-offers-cli.md`](./chia-offers-cli.md) for the CLI lifecycle.
