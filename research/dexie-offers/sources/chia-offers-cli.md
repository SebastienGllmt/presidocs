# Chia Offers — CLI lifecycle (local reference)

> **Local summary, not verbatim.** Source:
> <https://docs.chia.net/guides/offers-cli-tutorial/>, retrieved 2026-05-24.
> Command syntax preserved; see the URL for the canonical tutorial.

## Core commands

**Create an offer** (`-o` = offered, `-r` = requested, `-p` = output file,
optional `-m` = fee):

```
chia wallet make_offer -o <wallet_id>:<amount> -r <wallet_id>:<amount> -p <filepath>
```

**Inspect an offer without accepting** (`-e` = examine/preview):

```
chia wallet take_offer -e <offer_file>
```

**Accept an offer** (drop `-e` to commit):

```
chia wallet take_offer <offer_file>
```

**View offer status** (`-s` for detailed summaries, `-f` = fingerprint):

```
chia wallet get_offers --id <offer_id> -f <fingerprint>
```

**Cancel an offer:**

```
chia wallet cancel_offer -id <offer_id>
```

## Multiple-asset offers

Stack `-o` / `-r` flags:

```
chia wallet make_offer -o 2:10 -o 3:10000 -r 1:0.1 -r 4:9000 -p <filepath>
```

## Expiring offers (RPC)

Use `create_offer_for_ids` with a `"max_time": <unix_timestamp>` parameter to set
an expiration.

## Status lifecycle

`PENDING_ACCEPT` (coins reserved, not yet confirmed on-chain) → `PENDING_CONFIRM`
(taker broadcast) → `CONFIRMED` (in a block) — or `CANCELLED` (on-chain cancel
completed).

## Cancellation: secure vs insecure

- **On-chain (default):** spends the reserved coins; records the cancellation;
  prevents any future acceptance, but costs fees + needs confirmation.
- **Local / `--insecure`:** un-reserves coins instantly without an on-chain record.
  Warning: *"If you have copied your offer file elsewhere, someone could still
  accept it."*

## Key warnings

- **Unknown CATs = scam risk.** A file's name doesn't dictate its contents; verify
  unknown token IDs from trusted sources before accepting.
- **Whole coins are reserved.** Chia's coin-set model reserves entire coins for an
  offer; one large coin can block spending other amounts simultaneously.
- **CAT1 is deprecated** and can't be used in offers.

See also: [`chia-offers.md`](./chia-offers.md) for the underlying mechanism.
