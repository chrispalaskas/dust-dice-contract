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
| `verifier/` | `npm run verify -- <table address>` — re-derives every roll and score of a finished table from the indexer's record, the revealed VRF key and each seat's revealed secret                                                  |
| `docs/`     | The protocol: `table-interface.md` (start here), `security-review.md`, `client-rules.md`, the circuit notes, and `bugs-found.md`, a log of 30 upstream defects met while building on the ledger-9 line                     |

## Build

```sh
npm ci
npm run compact          # compactc 0.36.0 (ledger 9, pinned in the scripts) — full keys; `npm run compact:fast -w contract` skips ZK
npm run typecheck && npm test
```

The compiled output (`contract/src/managed/`, ~180 MB with prover keys) is not committed; the
**build fingerprint** — the hash of the nine verifier keys — is what a deployed table pins, so a
release is reproducible by compiling the tagged source with the pinned compiler.

## Trust model, in one paragraph

Players' stakes sit in the table contract, paid out by its own circuits. The dice come from a
**blind VRF**. The operator seals one VRF public key per table at deploy. For each roll the player
builds an input point from its own seat secret (pinned at join), the table, the round, the roll
index and its previous hold, then blinds that point and posts it. The operator answers with its
key applied to the blinded point, along with a DLEQ proof, checked in-circuit, that it used the
sealed key. The player unblinds the answer in its next move, the contract checks the unblinding,
and the dice are a hash of the result, mixed with the table's round digest and the seat's
entropy. So the operator cannot choose a roll, because one query admits exactly one valid
answer. It cannot see a roll before the player does, because it only ever sees blinded points.
The player cannot steer a roll either, because its secret and its blinding are both fixed.
`settle` reveals the VRF secret and each seat's final score reveals that seat's secret, so after
settlement anyone can replay the whole game with `verifier`. A table force-settled after the
operator went silent still pays its winner but cannot be replayed. The construction is in
`contract/src/vrf-core.compact`, and its review is `docs/review/vrf-review.md`. On a **fast**
table the ORDER of a player's rolls rests on the operator's word, and the docs say so wherever it
matters. The operator there also sees each roll before the turn lands, because the player's moves
reach it before the chain, so it could go quiet after a roll it dislikes. The player's remedy is to
play the rest of the turn on chain: a seat waiting on the operator cannot be eliminated in either
mode. See `docs/fast-turn-dispute.md` and `docs/security-review.md`.

## Publishing (maintainers)

The three workspaces publish to npm under the `@dust-dice` scope, in dependency order, each at the
same version as the git tag:

```sh
npm publish -w contract   # no internal deps; ships dist/ with keys+ZKIR for table and lobby (~57 MB)
npm publish -w api        # ships dist/ and src/
npm publish -w verifier   # ships dist/ (with the `dust-dice-verify` bin) and src/
```

`publishConfig.access: public` is set on each, so no flag is needed. Versions cannot be reused
once published, so check `npm pack -w <ws> --dry-run` first.

**Releases publish from CI.** Pushing a `v*` tag runs `.github/workflows/release.yml`, which
compiles with proving keys, builds, tests, and publishes every package whose version is not on
the registry yet — through npm's trusted publishing (OIDC), so no token lives anywhere. Each
package on npmjs.com needs a trusted publisher configured once: this repository, workflow
`release.yml`.

## Built on Midnight

This project is built on the [Midnight Network](https://midnight.network), using the
[Compact](https://docs.midnight.network/develop/reference/compact/) smart contract language and the
Midnight.js SDK.

## Licence

Apache-2.0. Build on it as you like.
