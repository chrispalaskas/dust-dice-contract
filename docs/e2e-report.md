# E2E report — a whole game of Yahtzee on a real chain

A two-player, thirteen-round game of Dust Dice, played through the real circuits against
the real proof server on the local devnet, settled with the winner and the rake paid out of the
contract's own custody, and then re-verified from the chain log by a program that was given
nothing but the table's address.

Driver: [`cli/`](../cli/README.md). Reproduce with `npm run demo -w cli`, then
`npm run verify -w cli -- <table-address>`.

> **TWO RUNS ARE RECORDED HERE, NEWEST FIRST.** **Run 2** (2026-09-01) is the current design:
> simultaneous rounds with interactive holds, nine circuits. **Run 1** is the original cursor
> model with pre-declared hold policies, kept unedited below as the record of how the design got
> here — its section numbers (§1–§7) belong to it alone. Where the two disagree, Run 2 is
> current.

## Environment

Unchanged from [gate0-report.md](gate0-report.md) except where noted.

| Component          | Version / endpoint                                                              |
| ------------------ | ------------------------------------------------------------------------------- |
| midnight-node      | `2.0.0-rc.4` (vendors ledger `9.1.0.0-rc.3`), `ws://127.0.0.1:9954`             |
| indexer-standalone | `4.4.0-pre-alpha.16-…`, `http://127.0.0.1:8098/api/v4/graphql`                  |
| proof-server       | `9.0.0-rc.5_experimental`, `http://127.0.0.1:6310`                              |
| Compact            | CLI `0.5.1`, compactc `0.34.0`, language `0.26.0`                               |
| SDK                | `midnight-js 5.0.0-beta.7`, `wallet-sdk 2.0.0-beta.2`, `compact-runtime 0.19.0` |
| networkId          | `undeployed`                                                                    |

---

# Run 2 — 2026-09-01: simultaneous rounds with interactive holds

A second full game, against the redesigned contract: every seat plays each round independently,
and within a turn the player sees each roll and picks the dice to keep. Two seats, thirteen
rounds, played through the real circuits and the real proof server, settled, and re-verified from
the chain by a program given nothing but the table's address.

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| table         | `af10c8646119af1b06ff4f5b7af6566146f7d0b86e354037ab3cea9c7e8b73aa`    |
| tableId       | `19104e95beea9596af1c6f207efc2dcfb47e40b8a13b512202de333b52014998`    |
| revealed seed | `9f7a28875a456b3c8c964b2ca8d844f8bf67d44ed24c215923cacfa8b7036896`    |
| tier / seats  | 5,000,025 × 2                                                         |
| outcome       | seat 1 wins 149–110; pot 10,000,050 → winner 9,900,050 + rake 100,000 |
| verification  | **939 checks passed, 0 failed**                                       |

Environment unchanged from Run 1 except the contract: **nine** exported circuits, compactc
`0.34.0`, language `0.26.0`.

## The blocking finding: the deploy ceiling is nine circuits, not eleven

**This run did not start on the first attempt, and the reason invalidates a number repeated
throughout this project's documentation.**

The redesigned contract had ten exported circuits, comfortably inside the "deploy ceiling
measured at 11–12" that `table.compact` and [table-circuit.md](table-circuit.md) had both
asserted for months. It could not be deployed. The node refuses the transaction outright:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

The node log shows the transaction _validated for the mempool_ and then never included — blocks
continue at `extrinsics_count: 4` with `end: NoMoreTransactions`. Nothing names verifier keys,
contract size, or which limit was hit.

A deploy carries **one verifier key per exported circuit**. Measured by deploying real contracts
and nothing else, same node, same wallet, same session:

|    exported circuits | verifier-key bytes | deploy                    |
| -------------------: | -----------------: | ------------------------- |
| 8 (Run 1's contract) |             15,416 | lands, block 288          |
|                    9 |             19,071 | lands                     |
|                   10 |             21,190 | **refused, 6/6 attempts** |

So the ceiling is between 19,071 and 21,190 bytes of verifier key. **The 11–12 figure was
inherited from a neighbouring project, never tested here, and is wrong by two to three
circuits.**

**It is bytes, not circuits, and that couples it to `k`.** A verifier key is **1,351 bytes at
k ≤ 12** and **2,119 bytes at k ≥ 13**. Which puts this limit in direct opposition to the
admission floor of Run 1 §3:

|          | admission floor (§3, Run 1)  | deploy ceiling (this run)     |
| -------- | ---------------------------- | ----------------------------- |
| `k ≤ 12` | risks `OutsideTimeToDismiss` | small key, deploy-friendly    |
| `k ≥ 13` | safe                         | 2,119 B of deploy budget each |

Run 1's contract fitted eight circuits partly _because_ two of them had small keys —
`claimTimeout` at k=11 and `abortTable` at k=12 — and `claimTimeout` at k=11 is precisely the
circuit that was then refused at admission 1,610 times in live play. **There is no setting of `k`
that is free.** Lifting every circuit above the admission floor is what pushed this deploy over
the block limit.

**Resolution.** Keep every circuit at k ≥ 13 so nothing is ever refused at admission, and pay for
it with a hard cap of nine circuits. Two merges got there: three player moves behind one
`playerMove` kind discriminator, and rolls 2 and 3 behind `resolveReroll`, which reads _which_
reroll it is performing from the seat's own stage. The merge cost no PLONK step — a reroll's
domain is set by the roll hash, not the transcript — and it made skipping or reordering a roll
_unrepresentable_ rather than merely refused.

Logged as [bugs-found.md](bugs-found.md) #16. `npm run deploy-probe -w cli` now answers "does
this contract deploy?" in about forty seconds; it belongs next to `npm run k -w cli` in any
pre-flight, because `k` answers whether each circuit can be **proved** and neither implies the
other.

**A second, cheaper failure preceded it**: the first attempt deployed a contract compiled with
`--skip-zk`, which emits ZKIR and bindings but no keys. It failed _after_ generating three
wallets, funding two and waiting out two DUST registrations. `requireCompiledContracts()` now
checks for every circuit's key files before anything is spent.

## The run

**143 game transactions in 43.7 minutes**, plus two deploys and two lobby calls — 146 circuit
calls in total, none failed, none retried.

|                          |                                    |
| ------------------------ | ---------------------------------- |
| player transactions      | 79                                 |
| operator transactions    | 64                                 |
| opens / holds / scores   | 26 / 25 / 26                       |
| rolls resolved           | 51                                 |
| round closes             | 13                                 |
| turn lengths             | 9 × 1-roll, 9 × 2-roll, 8 × 3-roll |
| distinct hold masks sent | 15                                 |

**All three turn lengths and fifteen distinct masks were exercised**, most of them with
_non-prefix_ held sets (`01101`, `10100`, `10010`, `00101`, …). That matters: a prefix-only mask
behaves identically under the left-to-right stream merge and the positional merge Run 1's
contract used, so a demo made only of prefix masks would pass against either and prove nothing.

### Timings, by circuit

| circuit         |   n | prove | balance+sign | submit→inclusion |  total |
| --------------- | --: | ----: | -----------: | ---------------: | -----: |
| `(constructor)` |   2 | 0.00s |        0.35s |           17.21s | 18.65s |
| `openTableAt`   |   1 | 0.68s |        0.35s |           16.51s | 18.61s |
| `join`          |   2 | 1.23s |        0.36s |           15.19s | 17.91s |
| `tableFilled`   |   1 | 0.68s |        0.38s |           15.20s | 17.30s |
| `playerMove`    |  77 | 0.96s |        0.35s |           15.49s | 17.85s |
| `resolveRoll1`  |  26 | 1.84s |        0.35s |           16.30s | 19.54s |
| `resolveReroll` |  25 | 1.79s |        0.35s |           16.56s | 19.74s |
| `closeRound`    |  13 | 0.51s |        0.35s |           16.29s | 18.20s |
| `settle`        |   1 | 1.23s |        0.34s |           15.96s | 18.62s |

**Averages over 146 calls: proving 1.22 s, balancing 0.35 s, submission→inclusion 15.89 s, total
18.52 s per transaction.** Run 1 measured 19.13 s over 111 calls, so the platform is unchanged
within 3%.

**Inclusion is still 86% of the budget.** The most expensive circuit to prove is a roll at 1.8 s
against ~16 s of waiting for the chain. `playerMove` — which merges three moves and is the
busiest circuit at 77 calls — proves in 0.96 s. **Proving has never been the bottleneck and the
merge did not make it one.**

### The cost of an interactive turn

The redesign made turns _longer in transactions_ and _variable in length_, which is the honest
headline. Measured, not estimated:

| turn              | player tx | operator tx | total |
| ----------------- | --------: | ----------: | ----: |
| stop after roll 1 |         2 |           1 |     3 |
| stop after roll 2 |         3 |           2 |     5 |
| full three rolls  |         4 |           3 |     7 |

Run 1's pre-declared turn was a flat 1 + 3 = 4. This run averaged **4.92 transactions per turn**
across its mixed schedule.

Re-derived at the measured 18.52 s:

| shape                                                 | transactions | serial wall time |
| ----------------------------------------------------- | -----------: | ---------------: |
| 2 seats × 13 rounds, mixed (this run)                 |          143 |       **44 min** |
| 6 seats × 13 rounds, mixed                            |          404 |          125 min |
| 6 seats × 13 rounds, every turn stops after roll 1    |          254 |           78 min |
| 6 seats × 13 rounds, every turn takes all three rolls |          566 |          175 min |

**Early scoring is a real lever and it belongs to the player.** A six-seat table where everyone
stops after roll 1 is 45% of the traffic of one where everyone rolls three times. A UI should
make "score now" as easy to reach as "roll again".

**The operator is the bottleneck and simultaneity does not fix it.** Player transactions are
parallel across seats; the operator's are not, because one wallet's spends must be sequential
([bugs-found.md](bugs-found.md) §0 #8/#22). At six seats the operator submits up to 18 resolves
per round. An operator wanting the full width of simultaneous rounds needs a pool of wallets, one
per seat — the same conclusion [concurrency-probe.md](concurrency-probe.md) reached, now
confirmed against a real game.

### Transaction sizes against the ~8 KB admission floor

Every row landed, so every row cleared the floor. The margin is what matters.

| circuit         |  bytes | allowance | margin over floor | block |
| --------------- | -----: | --------: | ----------------: | ----: |
| `(constructor)` |  8,864 |  17.73 ms |              +880 |   520 |
| `openTableAt`   |  8,493 |  16.99 ms |          **+509** |   526 |
| `tableFilled`   |  8,613 |  17.23 ms |              +629 |   535 |
| `resolveReroll` |  8,786 |  17.57 ms |              +802 |   557 |
| `resolveRoll1`  |  8,866 |  17.73 ms |              +882 |   545 |
| `playerMove`    |  9,011 |  18.02 ms |            +1,027 |   538 |
| `closeRound`    |  9,087 |  18.17 ms |            +1,103 |   563 |
| `join`          | 10,118 |  20.24 ms |            +2,134 |   529 |
| `settle`        | 10,894 |  21.79 ms |            +2,910 |   975 |

The thinnest margin is again the lobby's `openTableAt` at **+509 bytes**, essentially unchanged
from Run 1's +508 — the lobby circuits do almost nothing, so the padding is nearly all of their
transaction. **No table circuit came close to the floor**, which is what keeping every one of
them at k ≥ 13 buys.

### Custody, from per-transaction UTXO movement

| transaction    |     spent by users |           created | net into contract |
| -------------- | -----------------: | ----------------: | ----------------: |
| `join(seat 0)` | 10,000,000,000,000 | 9,999,994,999,975 |    **+5,000,025** |
| `join(seat 1)` | 10,000,000,000,000 | 9,999,994,999,975 |    **+5,000,025** |
| `settle`       |              **0** |        10,000,050 |       −10,000,050 |

`settle` spent **zero user inputs** while creating 10,000,050 of real native NIGHT — 100,000 to
the operator's rake address and 9,900,050 to seat 1's join-time address. A transaction that
spends nothing and creates real value can only be paying out of the contract's own balance.
**That is custody, demonstrated rather than asserted.** The contract's native-NIGHT balance
afterwards is 0, and no seat had anything left to redeem, which is the correct end state for a
clean settlement.

## The two non-settlement exits, for real

`npm run timeouts -w cli` — two more tables, 65 transactions, both scenarios PASS. These exist
because `src/test/table.test.ts` already covers the whole timeout matrix in the simulator,
exhaustively and cheaply, and cannot cover the two halves only a real chain has: the kernel's
block-time **predicates** evaluated against real consensus time, and the **token movement**
inside those paths (`sendUnshielded` moves nothing in the simulator —
[bugs-found.md](bugs-found.md) #11).

### ELIMINATE — the penalty survives to a payout

Table `209a14b215ccabef30a7f2d51748577ae084581d689b9e1608b8198798b6a687`. Two seats join; seat 0
never opens a turn at all — stage 0, the first of the four player-owed states `eliminate` covers.

| step                                             | measured                                            |
| ------------------------------------------------ | --------------------------------------------------- |
| wait for the round deadline                      | 404 s against the chain's own clock                 |
| `eliminate(seat 0, q=384617, rem=4)`             | penalty **384,617**, refundable **4,615,408**       |
| `activeSeats`                                    | 2 → 1                                               |
| `pot`                                            | 10,000,050 → **5,384,642**                          |
| `redeem` while the table is live                 | **refused** — "the table is not finished"           |
| seat 1 plays 12 more rounds alone, then `settle` | winner seat 1, rake 53,846                          |
| **`redeem(seat 0)`, by UTXO audit**              | **created 4,615,408** to seat 0's join-time address |

**Every number is the rule, recomputed.** The penalty is `⌊tier × (round+1) / 13⌋` =
`⌊5,000,025 × 1 / 13⌋` = 384,617 with remainder 4 — the witness-and-assert Euclidean identity,
which has exactly one solution, holding against real consensus. The pot afterwards is seat 1's
stake plus seat 0's forfeit: `5,000,025 + 384,617 = 5,384,642`. And the refund reaching a real
unshielded output is `tier − penalty` to the atom.

**Why this scenario plays a whole game.** The penalty only reaches a UTXO through `redeem`, and
`redeem` is refused until the table is terminal — decision 4 of
[simultaneous-rounds.md](simultaneous-rounds.md), and what keeps the custody invariant to one
line. The only terminal state that PRESERVES a penalty is a settlement: both abort paths waive
it. So confirming the arithmetic by UTXO audit means finishing the game.

**The refusal is itself a result.** `redeem` returning "the table is not finished — nothing may
be withdrawn while it is live" from a real node is decision 4 demonstrated rather than asserted.
No amount of ledger reading shows it.

### ABORT — the operator abandons a turn

Table `53035ef0a7aa5bd861f4c31b60295b915ca38ade536264044bfaeeb2094638f1`. Two seats join; seat 0
opens a turn and the operator never resolves it, leaving the seat at stage 1 (`awaitRoll1`) —
which is the operator's to discharge, not the player's.

| step                                        | measured                                          |
| ------------------------------------------- | ------------------------------------------------- |
| wait for `roundDeadline + tableTimeoutSecs` | 987 s against the chain's own clock               |
| `abortTable(q=50000, rem=25)`               | **5,000,025 redeemable per seat** — the full tier |
| `redeem(seat 0)`                            | created **5,000,025**                             |
| `redeem(seat 1)`                            | created **5,000,025**                             |
| contract native NIGHT                       | 10,000,050 → **0**                                |

**No rake, and that is the rule rather than an oversight**: the table never produced a game
because the operator abandoned it, so raking it would pay the operator for failing. Only the
all-eliminated waiver pays a rake on an abort. The per-seat rake identity `q × 100 + rem == tier`
is still required on every path so the argument encoding stays canonical — it is simply not
applied here.

**`abortTable` paid nobody directly.** It converted the pot into per-seat `redeemable` and left
the sending to `redeem`, which is now the only circuit that pays a player. That is a change from
Run 1, where `abortTable` sent to each seat inside a conditional loop; one payout path is easier
to reason about and removes the old hazard of sending to a pre-inserted zero address.

### What the two scenarios buy that the simulator cannot

- **The deadlines are real.** 404 s and 987 s of actual waiting, with `blockTimeGt` evaluated
  against the block time of the block the call landed in. The simulator sets that number itself.
- **The money is real.** Three `redeem` transactions created 14,615,458 of native NIGHT out of
  contract custody, each to the address its seat recorded at `join`. Under the simulator every
  one of those sends succeeds and moves nothing.
- **Both contract-funded sends spent ZERO user inputs**, exactly as `settle` did — fees are paid
  in DUST, so a payout from contract custody consumes no native input at all.

## Verifying the game from the chain alone

`npm run verify -w cli -- <address>`, given the table address and nothing else — no seeds, no
player secrets, no artefacts from the process that played the game.

**VERIFIED: 939 checks passed, 0 failed.**

It replayed 2 joins, 26 opens, 25 holds, 26 scores, 51 rolls, 13 round closes and 0 eliminations
from 144 contract actions, and confirmed:

- the revealed seed opens the commitment the table was deployed with;
- **every roll**, re-derived from `(tableId, seed, mixed entropy, round, roll index)` through the
  same byte ladder the circuit uses — and every _reroll_ re-derived under the hold mask the
  player actually sent, read from the ledger and merged left to right over the rerolled
  positions;
- **every held die survived its reroll byte-for-byte**;
- the round digest chain, from genesis through every join and every `closeRound`;
- every score recomputed from the dice with `api/src/rules.ts` — the rules engine, not the
  circuit — box by box;
- the custody invariant `pot + Σ redeemable == tier × seatCount` after **every** transaction;
- the winner, and that the chain paid the seat the tie-break selects.

**Three things were harder to verify than in Run 1, and all three are solved by diffing state
rather than by being told.** `playerMove` is one entry point for three moves, so which move it
was is recovered from the seat's stage transition, and _which seat_ moved from the one entry that
changed. The category is not in the ledger, so it is recovered by diffing the scorecard — a
stronger check than being told, since the verifier finds the box that changed _and_ recomputes
what belongs in it. Which of the two rerolls `resolveReroll` performed is likewise read from the
prior stage.

### A second table, to cover what the first could not

The clean game had **zero** eliminations, so the verifier's `eliminate` and `redeem` replay paths
had never run against a chain. The ELIMINATE scenario's table was therefore verified too:

**VERIFIED: 402 checks passed, 0 failed** — 2 joins, 13 opens, 13 scores, 13 rolls, 13 round
closes, **1 elimination and 1 redemption**, with the eliminated seat correctly excluded from the
winner computation (replay total 0, marked eliminated) while seat 1 took the pot. The penalty was
recomputed from the rule, not read: `⌊tier × (round+1) / 13⌋`, and checked against the pot
movement and the seat's `redeemable` in the same step.

Between the two tables, every replay path the verifier has is now exercised against a real chain:
opens, holds, scores, both roll circuits, round closes, eliminations, redemptions, settlement and
payout.

**One limitation, stated plainly:** per-block state replay needs at most one call to a table per
block. A table genuinely _can_ take several per block — that is the whole point of the
concurrency work, measured at six in [concurrency-probe.md](concurrency-probe.md) — so the demo
driver is strictly sequential precisely to keep its games verifiable by this method. A table
played by six independent clients may not be. That is a limitation of the verifier, not of the
contract, and the verifier says so rather than producing a wrong answer.

**What it still cannot prove**, unchanged from Run 1 §6: that each seat's published entropy really
is `H(sk_s, tableId, round)` for the secret committed at join. That binding is what the circuit
asserts in zero knowledge, and it is unverifiable from public data by construction — if it were
verifiable, `sk_s` would be public.

## Verdict

**The design works on a real chain, and the platform constraint that bounds it is not the one
anybody had written down.**

What was proven: simultaneous rounds and interactive holds play, settle and verify; the
elimination penalty is exact from a witness-and-assert identity all the way to an unshielded
output; both non-settlement exits work against real block-time predicates; custody holds at every
step and the contract ends every path with a zero balance.

What changed in the platform's story: **the deploy ceiling is nine circuits, not eleven**, it is
really a cap on verifier-key bytes, and it **opposes** the admission floor — clearing one costs
budget against the other. Every prior document in this project asserted the wrong number.

### What has to change

- **`turnTimeoutSecs` now bounds a whole ROUND, not a move.** Up to four player transactions and
  three operator ones per seat share one deadline. At six seats a worst-case round is ~300 s of
  chain time before the operator's own round trips. An operator SLA written against the old
  per-move meaning will eliminate seats that were playing normally.
- **The operator needs a wallet pool.** Player transactions parallelise across seats; the
  operator's do not, because one wallet's spends must be sequential. At six seats it submits up
  to 18 resolves per round, and that alone sets the length of a game.
- **A UI should make "score now" as prominent as "roll again".** It is the only lever anyone has
  over table length, and it is worth 45% of the traffic.

### What is still unproven

- **Same-block concurrency in a real game.** [concurrency-probe.md](concurrency-probe.md)
  measured six wallets landing in one block, but this driver is deliberately sequential so its
  games stay verifiable by per-block state replay. A table driven by six independent clients has
  not been run.
- **Six seats.** Every game here was two seats (plus one solo). The six-seat figures in this
  report are derived from the measured per-transaction cost, not observed.
- **The all-eliminated waiver on chain.** Covered by the simulator, not yet by a devnet run —
  it needs every seat at one table to be eliminated.

---

# Run 1 — the cursor model with pre-declared hold policies

> Historical. The contract described below no longer exists: the seat cursor was replaced by
> simultaneous rounds and the six hold policies by interactive holds. Kept unedited because the
> platform findings in it — the SRS ceiling, the admission floor, the padding mechanism, the
> per-transaction cost model — all still hold and are what made Run 2's design possible.

## 1. The go/no-go: **NO-GO as designed, and it was answered offline**

The blocking question was whether `resolveTurn` — the operator's move, three rolls of five dice
under a latched hold mask, the largest circuit in the project — could be proved at all. Gate 0
had found that the proof server ships a subset of SRS degrees and cannot reach
`srs.midnight.network`, and [table-circuit.md](table-circuit.md) had measured `resolveTurn`'s
prover key at 38.5 MB, two PLONK steps above a single roll.

**It could not be proved, and the contract as designed could never have produced a single
resolve transaction.**

That verdict was reached **before anything was deployed**, and how it was reached is the more
useful finding. The expected procedure was to deploy a throwaway table and attempt a proof; the
expected failure mode is a **six-minute hang** ending in a generic `BadInput`, which is a
terrible signal to design against. Instead:

1. The proof-server image's bundled SRS degrees were enumerated directly. The image is
   distroless, so there is no shell to ask — `docker export yahtzee-proof-server | tar -t` lists
   `.cache/midnight/zk-params/bls_midnight_2p{9,10,11,12,13,14,15}`. **k=9 through k=15, and
   nothing else.**
2. Each circuit's own PLONK domain was read straight out of its compiled ZKIR with
   `@midnight-ntwrk/zkir-v2`'s `Zkir.fromJson(json).getK()` — an undocumented accessor, and the
   only one that exists (see [bugs-found.md](bugs-found.md) §13). `--skip-zk` compilation is
   enough to produce the ZKIR, so this costs about a second.

| contract | circuit         |   k | verdict                    |
| -------- | --------------- | --: | -------------------------- |
| `table`  | `resolveTurn`   |  17 | **UNPROVABLE** — no `2p17` |
| `table`  | `join`          |  15 | at the ceiling             |
| `table`  | `takeTurn`      |  15 | at the ceiling             |
| `table`  | `settle`        |  15 | at the ceiling             |
| `table`  | `claimTimeout`  |  15 | at the ceiling             |
| `table`  | `abortTable`    |  15 | at the ceiling             |
| `lobby`  | `openTableAt`   |  15 | at the ceiling             |
| `lobby`  | `tableFilled`   |  15 | at the ceiling             |
| `dice`   | `rollDice`      |  15 | one roll                   |
| `turn`   | `probeTwoRolls` |  16 | two rolls — already over   |
| `turn`   | `resolveTurn`   |  16 | three rolls, no policy     |

Two things fall straight out of that table, and both shaped the fix:

- **One roll is k=15 and two rolls are k=16.** So any split had to put **one roll per
  transaction**. The two-way split the plan floated (rolls 1+2, then roll 3) was already ruled
  out by measurements taken weeks earlier, without needing to be tried.
- **Every shipped circuit was sitting at k=15, the ceiling, with no headroom at all.** That is
  not a coincidence, and finding out why is what made the fix affordable — see §2.

This check is now a committed tool: `npm run k -w cli`
([`cli/tools/circuit-k.mjs`](../cli/tools/circuit-k.mjs)). It should be run after any change to
a circuit, before anything is deployed.

---

## 2. The fallback, and the thing that made it fit

### 2.1 The split: one roll per transaction

`resolveTurn` became `resolveRoll1`, `resolveRoll2`, `resolveRoll3`, sequenced by a `rollStep`
counter on the ledger, each asserting the value it is the successor of so the operator cannot
skip, repeat or reorder a roll. Exported circuits: **8**, against a deploy ceiling of ~11.

- `resolveRoll1` checks the seed, mixes the entropy with the game digest, derives roll 1,
  verifies the witnessed modal face against it, and latches the mixed entropy and the hold mask
  into the ledger.
- `resolveRoll2` checks the seed and rerolls once under the latched mask.
- `resolveRoll3` checks the seed, rerolls again, writes the turn's dice to the seat, folds the
  turn into `gameDigest`, and advances the cursor.

The seed is re-checked at every step, which is not redundant: each step derives a roll from it,
so a step that trusted an earlier check would accept dice derived from a different preimage.

**The dice did not change.** Same three roll hashes over the same `RollContext`s in the same order
under the same mask, so a turn's final dice are bit-for-bit what the one-circuit version produced.
`gameDigest` still absorbs exactly one event per turn with the same fields. **The settlement
verifier and the TypeScript mirrors were not touched at all** — they do not know the split
happened. `policy-core.compact` keeps the unsplit `resolveDiceChecked` (unprovable, but it still
simulates) precisely so a test can assert that equivalence, and
`describe('the three-transaction resolve')` in `src/test/table.test.ts` does.

What did change, stated plainly:

- **Throughput.** A turn is four transactions instead of two. That is the dominant cost of the
  whole fix and it is what sets the length of a game (§3).
- **The intermediate hands are public.** Rolls 1 and 2 land on chain as their own transactions
  instead of staying inside one proof. Nothing exploitable follows: the only player choice in a
  turn is the hold policy, declared in `takeTurn` **before any roll exists**, and the mask is
  latched from roll 1 — so by the time roll 1 is public, every remaining die is determined. It is
  strictly more legible, and the verifier now checks all three rolls rather than just the last.

### 2.2 The split did not fit either, until the padding stopped being an argument

Split naively, the three resolve circuits came out at **k=16** — still unprovable. Shrinking the
padding brought them to k=15 only at 16 words (512 bytes), which does not clear the node's
~7,984-byte admission floor. **At that point the contract had no feasible configuration at all:**
the SRS ceiling and the admission floor were pushing against each other with no gap between them.

The gap was in the padding's _shape_, not its size. Gate 0 introduced the padding as a
`Vector<64, Bytes<32>>` **circuit argument**, and [table-circuit.md](table-circuit.md) had
measured its cost as "5 instructions and 2 public inputs per word" without drawing the
consequence: an exported circuit's parameters are **public inputs to the proof**, and PLONK's
domain must cover the public-input region, so on a small circuit a 128-input argument sets the
domain by itself.

A compile-time constant costs neither. `pad(2048, "yahtzee:v1:pad")` written to a `Bytes<2048>`
ledger cell after `kernel.checkpoint()` is emitted by the compiler as a literal `StateValue` push
inside the ledger op — so the 2,048 bytes still land in the transcript, still count toward
`est_size()`, and still earn the dismiss-time allowance, while contributing essentially nothing
to the proving domain.

Same contract, same behaviour, same 2 KB of padding, same transaction size:

| circuit            | padding as an argument | padding as a constant |
| ------------------ | ---------------------: | --------------------: |
| `claimTimeout`     |      k=15, 8,458,853 B |   **k=11, 575,520 B** |
| `abortTable`       |      k=15, 8,458,463 B | **k=12, 1,079,285 B** |
| `settle`           |      k=15, 9,948,285 B | **k=13, 2,824,864 B** |
| `join`             |      k=15, 9,960,155 B | **k=14, 5,209,319 B** |
| `takeTurn`         |      k=15, 9,967,349 B | **k=14, 5,215,077 B** |
| `resolveRoll1/2/3` |      k=16 — unprovable |   **k=15 — provable** |

A factor of fifteen on `claimTimeout`'s prover key for a contract that does exactly the same
thing, and on the resolve path the difference between deployable and not. Logged as
[bugs-found.md](bugs-found.md) §14. This is the finding with the widest reach beyond this
project: **any** Compact contract using Gate 0's padding workaround is paying one to three PLONK
steps for nothing.

### 2.3 As shipped

| contract | circuit        | instructions | public inputs | prover key |   k |
| -------- | -------------- | -----------: | ------------: | ---------: | --: |
| table    | `join`         |          783 |             3 |  5,209,319 |  14 |
| table    | `takeTurn`     |        2,106 |             6 |  5,215,077 |  14 |
| table    | `resolveRoll1` |        1,236 |             1 |  9,987,807 |  15 |
| table    | `resolveRoll2` |          877 |             1 |  9,976,727 |  15 |
| table    | `resolveRoll3` |        1,768 |             1 |  9,990,255 |  15 |
| table    | `settle`       |        1,336 |             4 |  2,824,864 |  13 |
| table    | `claimTimeout` |        1,360 |             1 |    575,520 |  11 |
| table    | `abortTable`   |        1,996 |             1 |  1,079,285 |  12 |
| lobby    | `openTableAt`  |          233 |             3 |  2,821,203 |  13 |
| lobby    | `tableFilled`  |          274 |             1 |  2,820,987 |  13 |

The three resolve circuits sit at **k=15 with no headroom**. Any future work on the resolve path
has to be checked with `npm run k -w cli` before it is trusted.

Contract tests: **119 passing** (the 114 that existed before, unchanged, plus 5 for the split's
sequencing, its equivalence to the unsplit circuit, and the newly public intermediate rolls).

---

---

## 3. The run

One game, start to finish, on the local devnet. Table
`8f6cd96e443a008576abbd4c7c188465610995f6c0ac95813d37aee763df548f`, lobby
`bc824cc3cce95ae03a15e30a7b28e42c99ab687b68deda94bdbe61a99594d392` registered at tier 0, two players on freshly generated seeds funded and DUST-registered from
the genesis wallet.

- **111 circuit calls**, plus two deploys and two plain funding transfers.
- **2,123 s of transaction time** — 35 minutes of chain, for a 13-round two-seat game.
- Seat 0 scored **127**, seat 1 scored **130**. Seat 1 won on total, no tie-break needed.
- Pot **10,000,050** → **9,900,050** to the winner and **100,000** to the rake.
- **Zero failed transactions.** No retry fired in the whole run: no `InvalidDustSpendProof`, no
  `OutsideTimeToDismiss`, no fee-state drift over 111 sequential contract calls.

The tier is deliberately **5,000,025**, which is not divisible by 100, so the pot's Euclidean
rake split has a non-zero remainder (`q = 100,000`, `r = 50`) and the "remainder goes to the
winner" path was exercised on chain rather than only in the simulator.

### Timings, by circuit

| circuit        |   n | prove | balance+sign | submit→inclusion |  total |
| -------------- | --: | ----: | -----------: | ---------------: | -----: |
| (constructor)  |   2 | 0.00s |        0.35s |           17.19s | 18.64s |
| `join`         |   2 | 1.16s |        0.37s |           15.27s | 17.91s |
| `takeTurn`     |  28 | 1.00s |        0.35s |           15.25s | 17.67s |
| `resolveRoll1` |  26 | 1.86s |        0.36s |           15.19s | 18.47s |
| `resolveRoll2` |  26 | 1.82s |        0.35s |           16.99s | 20.21s |
| `resolveRoll3` |  26 | 1.88s |        0.35s |           17.21s | 20.53s |
| `settle`       |   1 | 0.65s |        0.36s |           15.21s | 17.29s |
| `openTableAt`  |   1 | 0.68s |        0.35s |           15.19s | 17.28s |
| `tableFilled`  |   1 | 0.71s |        0.35s |           16.53s | 18.63s |

**Averages over all 111 calls: proving 1.59 s, balancing 0.35 s, submission→inclusion 16.11 s,
total 19.13 s per transaction.**

Gate 0 predicted 20.9 s per transaction from four calls; this run measured **19.13 s over 111**,
so that figure was good to within 9% — and the shape of it is unchanged. **Inclusion is 84% of
the budget.** Proving a `resolveRoll` takes 1.9 s against 17 s of waiting for the chain; the
biggest circuit in the project is not the bottleneck and never was.

**The split's real cost is visible here and it is not proving time.** A turn is
`takeTurn + resolveRoll1 + resolveRoll2 + resolveRoll3` ≈ **76.9 s**, against ≈ 38 s for the
two-transaction shape. The three resolve steps together prove in 5.6 s — barely more than the
~2.5 s a single combined resolve took when it was proved in the simulator — so almost the entire
penalty is three inclusion waits instead of one.

### Game shapes, re-derived at the measured 19.13 s

| shape                          | transactions | serial wall time |
| ------------------------------ | -----------: | ---------------: |
| 2 seats × 13 rounds (this run) |          111 |       **35 min** |
| 6 seats × 13 rounds            |          343 |          109 min |

A six-seat table is now **nearly two hours**, which is not a game. This is the sharpest
consequence of the SRS ceiling, and it is worth stating as a product fact rather than a
performance note: **the platform's proving constraints, not the game design, are what cap table
size.** Options, none free: fewer rounds for larger tables, several tables running concurrently
(they are independent contracts, so they genuinely parallelise), or batching the three resolve
steps into one transaction — which would cut two inclusion waits per turn but inherits the
client-side gas under-declaration defect (bugs-found.md §0 #21, ~15% failure at 2 calls) and
needs its own probe.

### Transaction sizes against the ~8 KB admission floor

Every row landed in a block, so every row cleared the floor. The margin is what matters.

| circuit        |  bytes | allowance | margin over floor | block |
| -------------- | -----: | --------: | ----------------: | ----: |
| (constructor)  |  8,864 |  17.73 ms |              +880 |  2085 |
| `openTableAt`  |  8,492 |  16.98 ms |          **+508** |  2091 |
| `tableFilled`  |  8,613 |  17.23 ms |              +629 |  2100 |
| `join`         |  9,847 |  19.69 ms |            +1,863 |  2094 |
| `takeTurn`     |  9,269 |  18.54 ms |            +1,285 |  2103 |
| `resolveRoll1` |  9,266 |  18.53 ms |            +1,282 |  2107 |
| `resolveRoll2` |  9,100 |  18.20 ms |            +1,116 |  2111 |
| `resolveRoll3` | 10,067 |  20.13 ms |            +2,083 |  2115 |
| `settle`       | 10,321 |  20.64 ms |            +2,337 |  2443 |

**No retuning was needed** — the 2,048-byte constant clears the floor on every circuit. The
thinnest margin is the lobby's `openTableAt` at **+508 bytes**, which is comfortable but is the
one to watch: the lobby circuits do almost nothing, so the padding is nearly all of their
transaction. Since the padding is now a constant, raising it costs no PLONK step at all, so if
anything downstream shaves bytes the fix is free. That asymmetry — bytes cheap, circuit rows
scarce — is the opposite of the situation Gate 0 left behind.

---

## 4. Custody, from per-transaction UTXO movement

Read from the indexer, never from a wallet — Gate 0 §9 recorded the facade misreporting a
balance by 4,900,000 in exactly this situation.

| transaction   |  user inputs spent | outputs created                 | net into contract |
| ------------- | -----------------: | ------------------------------- | ----------------: |
| `join` seat 0 | 10,000,000,000,000 | 9,999,994,999,975 (change)      |    **+5,000,025** |
| `join` seat 1 | 10,000,000,000,000 | 9,999,994,999,975 (change)      |    **+5,000,025** |
| `settle`      |              **0** | 9,900,050 winner + 100,000 rake |   **−10,000,050** |

Each join moved **exactly `tier`** into the contract and nothing else. And the settle row is the
decisive one, for the same reason Gate 0's `payOut` was: **it spends zero user inputs while
creating 10,000,050 of real native NIGHT.** That value can only have come from the contract's own
balance. The contract's ledger-reported native balance afterwards is **0**, and so is its own
`pot` field — bookkeeping and ledger agree, which is the cross-check no offline test in this repo
can perform (`unshieldedBalance` returns 0 in the simulator, bugs-found.md §11).

Both created outputs carry `registeredForDustGeneration=true`, so the winner can actually spend
their winnings — the designation trap from Gate 0, avoided because the driver registers every
persona before it acts.

Payout addresses were the ones **recorded at join** and **sealed at construction**; no circuit
ever learned its caller, and `settle` was submitted by the operator's wallet purely because
somebody has to pay the fee — it is permissionless and reads no secret.

---

## 5. The timeout paths, for real

The simulator already covers the whole timeout matrix. What it cannot cover is the half only a
real chain has: the kernel's block-time predicates evaluated against actual consensus time, and
the token sends, which move nothing in the simulator. Two tables with 60 s turn / 90 s table
timeouts:

**`claimTimeout` — a stalled player forfeits.** Table
`96d74867354acc09752137dcd80ddc04f95ea05a8b4f1dfd63a088103e8a5c78`. Both seats joined, seat 0
never moved, and after the turn deadline elapsed the claim was made — from the operator's wallet,
which is a demonstration that it is permissionless, not a requirement.

- `activeSeats` 2 → 1; seat 0 `forfeited=true` with the never-finished sentinel 65535.
- Cursor advanced to seat 1, still round 0 — the contract's own skip logic, on chain.
- **Pot unchanged at 10,000,050**: a forfeited stake stays in the pot and is paid to whoever
  eventually wins.
- **UTXO movement: 0 spent, 0 created.** The claim pays the claimant nothing. That is what
  licenses a tight deadline — there is no bounty to farm.

**`abortTable` — an abandoned table refunds.** Table
`39c2e6f6e6472789b83666657f6407fe862c44493d0270ef3a01cdbd839de0c7`. Both seats joined, seat 0
took its turn, the operator never resolved — the exact griefing residual the randomness design
concedes — and after the table deadline anyone could abort.

- Refunded **10,000,050** in total: **5,000,025 to each player**, at the addresses recorded at
  join.
- **The rake address received 0.** `abortTable` has no rake path.
- Contract's native NIGHT: 10,000,050 → **0**.

That second result is the one worth flagging. `abortTable` is the **only** place in the contract
where a token operation sits inside a conditional (`if (s < seatCount)` inside an unrolled loop
over all six slots), it had never been executed against a real node, and
[table-circuit.md](table-circuit.md) named it as the construct most likely to misbehave. It
paid exactly the two real seats and nothing to the four empty ones. **It works.**

---

## 6. Verifying a game from the chain alone

```
npm run verify -w cli -- <table-address>
```

The verifier is given **a contract address and nothing else** — no seeds, no player secrets, no
run state, no artefact of the process that played the game. It reads the table's whole public
history from the indexer (one action per transaction, with an entry point and a block height) and
the contract's public state at each of those blocks, and reproduces the game:

1. **The revealed seed opens the commitment.** `H(seed) == seedCommitment`, where the commitment
   was fixed at deployment, before any player existed — so the operator could not have chosen a
   seed to suit the dice.
2. **Every roll re-derives.** For each turn, from `(tableId, seed, mixEntropy(entropy, digest),
round, rollIndex)` through the same byte-threshold ladder the circuit uses. All **three** rolls
   per turn, not just the last — the split resolve publishes each one, so each is checkable.
3. **The digest chain reproduces**, from the genesis digest through every join and every
   resolution. This is what makes (2) worth anything: each roll hashes the digest as it stood
   _before_ that turn, so no single roll can be checked without having replayed every earlier
   event in order. Reproducing the chain end to end **is** checking that no event was inserted,
   dropped or reordered.
4. **Every score recomputes**, from the dice, with `api/src/rules.ts` — the contract-canonical
   rules engine, deliberately not the circuit's own `pureCircuits`, so the check is differential
   rather than self-referential. Box by box, including the upper bonus and the Yahtzee bonuses.
   The category a player chose is not stored in the ledger at all (it is a circuit argument), so
   the verifier recovers it by finding the box that changed across the `takeTurn` — and then
   recomputes what belongs in it, which is a stronger check than being told.
5. **The winner is the seat the tie-break selects** — highest total, then earliest finisher, then
   lowest seat — and it is the seat the chain paid.
6. **The payout is what it should be**: the settle transaction spent zero user inputs and created
   exactly `pot − q` to the winner's address _as recorded at join_ and `q` to the rake address
   _as sealed at construction_.

### What it deliberately cannot prove

That a seat's published entropy really is `H(sk_s, tableId, round)` for the secret committed at
join. That binding is what the `takeTurn` circuit asserts in zero knowledge, and it is
unverifiable from public data **by construction** — if it were verifiable, `sk_s` would be public
and the anti-grinding scheme would be worthless. What the verifier confirms is that the chain
accepted a proof of it. That is the whole reason the proof exists, and saying so plainly is more
useful than a check that pretends to more than it has.

One precondition, enforced rather than assumed: the replay reads each call's _previous_ state, so
it needs at most one call to the table per block. Two calls in one block would both resolve to the
state after both. A single table is driven strictly sequentially so this does not arise, and the
verifier refuses to guess if it ever does.

---

## 7. Verdict, and what has to change

**The design works on this platform, after one forced change and one that should be adopted
everywhere.**

Confirmed end to end, by transactions that landed in blocks:

- A Compact contract taking custody of native unshielded NIGHT from two independent wallets and
  paying a winner and a rake out of it in one transaction, with zero user inputs.
- The two-step turn, the forced-entropy scheme, the running game digest, all six hold policies
  including the **witness-checked `KeepModal`** (exercised repeatedly on chain), the pipelined
  category choice, the full official joker rules, and the tie-break.
- Both non-settlement exits: a forfeit that pays nobody, and a refund that pays every seated
  player exactly its stake through a conditional token send.
- A settled game re-verified from the chain alone: **590 checks, 0 failures.**

### Must change

1. **`docs/table-contract.md` and `docs/table-circuit.md` described a `resolveTurn` that cannot
   exist.** Both now carry amendments; `table.compact`'s decisions 8 and 9 are the primary
   record.
2. **The 6-seat table is no longer viable as designed** — 343 transactions, ~109 minutes. The
   architecture doc's "long but within a real Yahtzee evening" no longer holds at six seats. A
   decision is needed: cap tables at 2–3 seats, shorten the game, run tables concurrently, or
   probe batching the three resolve steps into one transaction.
3. **`npm run k -w cli` belongs in CI**, before any deploy. Three circuits sit at k=15 with zero
   headroom; the next thing added to the resolve path will silently become unprovable, and the
   symptom is a six-minute hang.

### Should change, beyond this project

**Stop passing padding as a circuit argument.** Any Compact contract using Gate 0's
`OutsideTimeToDismiss` workaround in its published form is paying one to three PLONK steps for
bytes it can have for free. The fix is one line and it is measured in §2.2.

### Defects logged

- [bugs-found.md](bugs-found.md) **§13** — a circuit's PLONK domain is never reported by the
  toolchain, so provability cannot be checked before proving. Three upstream issues proposed.
- [bugs-found.md](bugs-found.md) **§14** — an exported circuit's array argument costs two public
  inputs per word and can dominate the proving domain.

Both are additions to the picture §4 (SRS degrees missing) already painted; neither was
discoverable from documentation.

### What is still unproven

- **Six seats on chain.** The contract handles six in the simulator and the cursor logic is
  exercised there, including mid-game forfeits, but no six-seat table has been played on a real
  node — the wall clock made it impractical here.
- **Batching**, and therefore whether a turn can be brought back under two inclusion waits.
- **The browser path.** Everything here ran through Node with `@dust-dice/api/node`'s plumbing; the
  dapp connector, wallet prompts and the in-page verifier panel are untested.
- **Sustained multi-table load.** One table at a time, ~130 transactions total. The fee-state
  drift documented in bugs-found.md §0 #22 never appeared, but this run is not evidence that it
  will not.
