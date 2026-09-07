# Dust Dice — the contract

_A Yahtzee-style dice game on Midnight._ This repository is the **public, auditable half** of
Dust Dice: the Compact contracts, the TypeScript mirrors and witnesses a client needs to talk to
them, the independent verifier that replays a finished game from the chain alone, and the
protocol documentation. The operator service and the web UI live in a separate, private repo.

"Yahtzee" is a trademark of Hasbro. This project is not affiliated with or endorsed by Hasbro and
uses the word only to describe the style of play.

> **Local devnet / testnet only.** Nothing here is audited or production-ready. Never deploy it
> with real value.

## What is here

| Path        | What                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract/` | `table.compact` (one deployment per table: stakes, seats, rolls, scoring, settlement), `lobby.compact` (a registry), the shared modules, TypeScript mirrors of every hash and rule, the witnesses, and 199 simulator tests |
| `api/`      | Contract-interaction plumbing: providers, wallet helpers, bech32, pure game rules. `./node` is Node-only                                                                                                                   |
| `verifier/` | `npm run verify -- <table address>` — re-derives every roll and score of a finished table from the indexer's record and the operator's revealed seed                                                                       |
| `docs/`     | The protocol: `table-interface.md` (start here), `security-review.md`, `client-rules.md`, the circuit notes, and `bugs-found.md`, a log of 30 upstream defects met while building on the ledger-9 line                     |

## Build

```sh
npm ci
npm run compact          # compactc 0.34.0 — full keys; `npm run compact:fast -w contract` skips ZK
npm run typecheck && npm test
```

The compiled output (`contract/src/managed/`, ~180 MB with prover keys) is not committed; the
**build fingerprint** — the hash of the nine verifier keys — is what a deployed table pins, so a
release is reproducible by compiling the tagged source with the pinned compiler.

## Trust model, in one paragraph

Players' stakes sit in the table contract, paid out by its own circuits. The operator commits to
a dice seed at deploy and every roll is a hash of that seed, the table's public round digest and
the players' own entropy — the operator cannot choose the dice, and after settlement anyone can
replay the whole game with `verifier`. On a **fast** table the ORDER of a player's rolls rests on
the operator's word, and the docs say so wherever it matters. See `docs/security-review.md`.

## Publishing (maintainers)

The three workspaces publish to npm under the `@dust-dice` scope, in dependency order, each at the
same version as the git tag:

```sh
npm publish -w contract   # no internal deps; ships dist/ with keys+ZKIR for table and lobby (~57 MB)
npm publish -w api        # ships dist/ and src/
npm publish -w verifier   # ships src/ (runs as TypeScript under Node's type stripping)
```

`publishConfig.access: public` is set on each, so no flag is needed. Versions cannot be reused
once published, so check `npm pack -w <ws> --dry-run` first. CI should publish through npm's
trusted publishing (OIDC from GitHub Actions) rather than a long-lived token.

## Built on Midnight

This project is built on the [Midnight Network](https://midnight.network), using the
[Compact](https://docs.midnight.network/develop/reference/compact/) smart contract language and the
Midnight.js SDK.

## Licence

Apache-2.0. Build on it as you like.
