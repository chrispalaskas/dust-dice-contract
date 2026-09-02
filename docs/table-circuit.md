# Table and Lobby circuits — measurements and decisions

The production contracts: `contract/src/table.compact` (the game, one deployment per table) and
`contract/src/lobby.compact` (a per-site registry). Design is
[table-contract.md](table-contract.md); this document is what the compiler and the simulator
actually say about it.

Toolchain, unchanged from [gate0-report.md](gate0-report.md): Compact CLI `0.5.1`, compactc
`0.34.0`, language `0.26.0`, `@midnight-ntwrk/compact-runtime 0.19.0`.

---

> **SUPERSEDED FROM §1 ONWARD by §0 below.** Two redesigns landed after this document was
> written: SIMULTANEOUS ROUNDS (every seat plays each round independently; see
> [simultaneous-rounds.md](simultaneous-rounds.md)) and INTERACTIVE HOLDS (the player picks the
> dice to keep after seeing each roll, replacing the six pre-declared hold policies). Between
> them they changed the exported circuit list, the round count, the dice merge and every
> measurement.
>
> **§0 is the as-shipped record.** Everything from §1 onward is kept as the history of how the
> design got here — the compile-time findings, the derivation/scoring separation and the padding
> mechanism are all still true and are what made the current shape possible — but the numbers,
> the circuit names and the policy set in those sections describe contracts that no longer exist.
> An earlier banner in this position said the same thing about the E2E run's split of
> `resolveTurn`; that split survives, in `resolveRoll1/2/3`.

---

## 0. As shipped: simultaneous rounds with interactive holds

Ten exported circuits against a deploy ceiling measured at 11–12. Measured with compactc
`0.34.0`, language `0.26.0`; `k` read out of the compiled ZKIR with `@midnight-ntwrk/zkir-v2`'s
`Zkir.fromJson(...).getK()` (`npm run k -w cli`), prover-key sizes from a full
`compact compile`.

### 0.1 The k table

**Every circuit is inside [13, 15], and that is a two-sided requirement.** The proof server
bundles `bls_midnight_2p9 .. 2p15` and cannot fetch more, so 16 is unprovable. And there is a
FLOOR: `claimTimeout` at k=11 was rejected by the node 1,610 times in live play with
`OutsideTimeToDismiss`, measured at 7,455–7,463 bytes against a required 8,269, while
`abortTable` at k=12 and everything above never failed once. The admission floor is a
**proof-size** floor and proof size follows k, so k is the only reliable lever — raising the
ledger padding does not work (§0.4).

| circuit        | caller   |   k | instructions | public inputs | prover key | headroom           |
| -------------- | -------- | --: | -----------: | ------------: | ---------: | ------------------ |
| `join`         | player   |  14 |          830 |             3 |  5,208,806 | 1 step             |
| `playerMove`   | player   |  14 |        1,243 |            10 |  5,207,892 | 1 step             |
| `resolveRoll1` | operator |  15 |          870 |             1 |  9,981,795 | **none**           |
| `resolveRoll2` | operator |  15 |          924 |             1 |  9,975,405 | **none**           |
| `resolveRoll3` | operator |  15 |          926 |             1 |  9,975,444 | **none**           |
| `closeRound`   | anyone   |  13 |          687 |             1 |  2,819,527 | 2 steps            |
| `eliminate`    | anyone   |  13 |        1,015 |             3 |  2,822,941 | 2 steps, ballasted |
| `settle`       | anyone   |  14 |        1,482 |             4 |  5,212,390 | 1 step             |
| `redeem`       | anyone   |  13 |          605 |             1 |  2,820,079 | 2 steps, ballasted |
| `abortTable`   | anyone   |  14 |        2,172 |             2 |  5,201,354 | 1 step             |

Verifier keys are 2,119 bytes for every circuit. `--skip-zk` compiles the whole contract in
**0.72 s** and emits byte-identical ZKIR, so the instruction counts above are safe to quote from
the dev loop; only key generation needs the full compile.

**k is not monotonic in instruction count and never was.** `abortTable` is the largest circuit
here at 2,172 instructions and sits at k=14, while `resolveRoll2` at 924 needs k=15. The domain
is set by the _gates_, and for the resolve circuits that means the roll hash and its rejection
ladder — 30 `div_mod_power_of_two` and ~120 `less_than` per roll. Prover-key size is likewise a
step function of the domain plus a gate-set constant, which is why it clusters at three values
(2.8 MB at k=13, 5.2 MB at k=14, 10.0 MB at k=15) rather than tracking the circuits' work.

### 0.2 The two circuits that needed ballast, and what they were given

`eliminate` and `redeem` both do very little — one seat, a subtraction, a send — and both landed
**under the floor** on first measurement: `eliminate` at **k=10** and `redeem` at k=13 only
because it already carried a hash. Neither was given a hash over nothing. Both were given work
that is worth doing and happens to be the right size:

| circuit     | before | ballast added                                                                  | after |
| ----------- | -----: | ------------------------------------------------------------------------------ | ----: |
| `eliminate` |     10 | `assertCustody()` (6 reads + the invariant) and the `seatReceipt` penalty hash |    13 |
| `redeem`    |     13 | the `seatReceipt` payout hash over the seat's final scorecard                  |    13 |

`assertCustody()` is the check that catches a pot/redeemable arithmetic slip at the exact moment
money moves between the two. The receipts are a public, permanent record of the arithmetic, and
a player disputing a settlement has something to point at. Both are declared as ballast in the
source so nobody later "optimises" them away and reopens the floor.

`abortTable` was at **k=12** before `finalDigest` was added — one step above the observed
failure but below the 13 target — and the closing certificate lifted it to 14.

### 0.3 The resolve path has no headroom, and it was measured first

`resolveRoll1/2/3` were measured **before any of the redesign was written**, because the whole
contract turns on whether they still fit. Three shapes, same ladder:

| shape                                      | roll 1 | roll 2 | roll 3 | verdict        |
| ------------------------------------------ | -----: | -----: | -----: | -------------- |
| cursor model, pre-declared policies        |  1,320 |    961 |  1,852 | k=15 / 15 / 15 |
| simultaneous rounds, pre-declared policies |  1,133 |    792 |    792 | k=15 / 15 / 15 |
| simultaneous rounds, interactive holds     |    870 |    924 |    926 | k=15 / 15 / 15 |

The interactive redesign paid for itself twice here. `resolveRoll1` **lost** the witnessed
modal-face check and the mask computation (1,133 → 870); rolls 2 and 3 **gained** the ten
conditional selects of the left-to-right stream merge (792 → 924) and still came out under the
cursor model's figures. All three remain at the ceiling, so anything that grows this path from
here makes the contract unprovable rather than slow. That is why `closeRound` is a separate
circuit and why the resolve steps touch exactly one ledger map.

The single-circuit `resolveTurn` that started all this needed **k=17** and could never have
produced a transaction. The cut at one roll per transaction was forced by the corpus — one roll
is k=15, two are k=16 — and with interactive holds it is no longer a compromise at all: the
player must see each roll to choose the next hold, so the rolls have to be separate transactions
anyway.

### 0.4 The padding is retained, and it does not do what it was added for

`padTransaction()` writes a 4 KB compile-time constant to `padStore` after
`kernel.checkpoint()`. It was added to clear the ~8 KB admission floor and **it does not**:
raising it 2 KB → 4 KB grew the transaction by a few hundred bytes, not 2,048, because
`pad(n, "…")` is a short tag followed by zero fill and serialises to almost nothing. It is kept
because the transcript bytes are free and cannot hurt.

What the padding's _shape_ still buys is real and is §3.3's finding: as a **compile-time
constant** it costs nothing, and as a `Vector<64, Bytes<32>>` **argument** it cost two public
inputs and five instructions per 32-byte word — enough on its own to push the resolve circuits to
k=16 and the contract out of provability.

### 0.5 Circuit count

Ten exported against a ceiling measured at 11–12. The interactive turn has three player moves —
open, hold, score — which as separate circuits would have been twelve. They are **merged into one
`playerMove`** behind a `kind` discriminator with canonical sentinels for the arguments a kind
does not use. A circuit has no branches, so the merge costs nothing at proving time that three
circuits would not each have paid anyway: the union of the three read sets is what every kind
reads regardless. Encoding in [table-interface.md](table-interface.md).

Helper circuits (`padTransaction`, `pinTime`, `assertCustody`, `totalRedeemable`,
`awaitingOperatorAt`) are **not** exported and cost nothing against the ceiling — the compiler
emits one `.zkir` and one key pair per _exported_ circuit. Neither do `pure` circuits from
`dice-core`, `scoring-core` and `policy-core`: a pure circuit produces no prover key, no verifier
key and no zkir at all.

### 0.7 The deploy ceiling is NINE circuits, and it fights the k floor

The figure "a deploy ceiling measured at 11-12" appeared in every previous revision of this
document and of `table.compact`. It was inherited from a neighbouring project, was never tested
here, and is **wrong**.

A deploy transaction carries one verifier key per exported circuit, and the node refuses it
outright when the total is too large -- with an error that names neither the contract nor the
cause:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

Measured by deploying real contracts and nothing else (`npm run deploy-probe -w cli`, ~40 s per
answer) on midnight-node `2.0.0-rc.4`:

| exported circuits | verifier-key bytes | deploy                     |
| ----------------: | -----------------: | -------------------------- |
|                 8 |             15,416 | lands (block 288)          |
|                 9 |             19,071 | lands                      |
|                10 |             21,190 | **refused, every attempt** |

So the limit is between 19,071 and 21,190 bytes of verifier key.

**IT IS BYTES, NOT CIRCUITS, AND THAT COUPLES IT TO k.** A verifier key is **1,351 bytes at
k <= 12** and **2,119 bytes at k >= 13**. So §0.1's rule -- lift every circuit to k >= 13 to
clear the node's proof-size admission floor -- is in direct tension with this one:

|           | admission floor (§0.1)       | deploy ceiling (§0.7)         |
| --------- | ---------------------------- | ----------------------------- |
| `k <= 12` | risks `OutsideTimeToDismiss` | small key, deploy-friendly    |
| `k >= 13` | safe                         | 2,119 B of deploy budget each |

The previous design could afford eight circuits partly BECAUSE two of them had small keys --
`claimTimeout` at k=11 and `abortTable` at k=12 -- and `claimTimeout` at k=11 is precisely the
circuit that was then refused at admission 1,610 times in live play. **There is no setting of k
that is free**, and a contract has to pick which limit to pay.

This one keeps every circuit at k >= 13, so nothing is ever refused at admission, and pays with
a hard cap of nine exported circuits. New on-chain behaviour has to go behind an existing
circuit's kind discriminator.

**How this was found is worth recording**: not by reading a spec, but by a demo run that
bootstrapped three wallets, funded two of them, deployed a lobby, and then failed on the table
deploy with an error that says nothing about verifier keys. `src/deploy-probe.ts` exists so the
next person spends forty seconds on the same question.

### 0.6 Conflict-freedom, read off the compiled transcript

Not a measurement of size but of the property the layout exists for, and it is checked
mechanically on every test run by `src/test/ledger-access.ts`, which parses the generated
`index.js` for the `popeq` (binding read) and `ins` (blind write) operations per circuit.

| circuit          | binds to (reads)                                                                      |
| ---------------- | ------------------------------------------------------------------------------------- |
| `playerMove`     | `phase`, `openRound`, `seatCount`, `tableId`, and its own seat's four map entries     |
| `resolveRoll1`   | `phase`, `openRound`, `roundDigest`, `seedCommitment`, `tableId`, own `seatTurn`      |
| `resolveRoll2/3` | `phase`, `seedCommitment`, `tableId`, own `seatTurn` (roll 3 also own `seatProgress`) |
| `redeem`         | `phase`, `seatCount`, `tableId`, and its own seat's three map entries                 |
| `closeRound`     | all six `seatProgress`, plus `phase`/`openRound`/`roundDigest`/`seatCount`            |
| `eliminate`      | the above **plus `pot` and `activeSeats`** — deliberately serialising                 |

Every field on the player path is either sealed, frozen for the duration of a round, or that
seat's own. `pot` and `activeSeats` are the contract's only shared accumulators and both are off
the player path; two concurrent eliminations conflict and one retries, which is correct.

---

## 1. Exported circuits — HISTORICAL (the cursor model with pre-declared policies)

Eight, against a deploy ceiling of ~11 measured upstream. **The deploy fits with three circuits
to spare.**

> Superseded by §0.5. `takeTurn` and `claimTimeout` no longer exist; `playerMove`, `closeRound`,
> `eliminate` and `redeem` do.

| circuit        | caller   | does                                                                                     |
| -------------- | -------- | ---------------------------------------------------------------------------------------- |
| `join`         | player   | stake `tier` in, register `C_s = H(sk_s)`, take the next seat; the last join starts play |
| `takeTurn`     | player   | score the previous round's dice; declare this round's forced entropy and hold policy     |
| `resolveRoll1` | operator | witness the seed, derive roll 1, check the modal face, latch the mask and mixed entropy  |
| `resolveRoll2` | operator | witness the seed, reroll once under the latched mask                                     |
| `resolveRoll3` | operator | witness the seed, reroll again, publish the dice, advance the digest and the turn        |
| `settle`       | anyone   | reveal the seed, pick the winner by tie-break, pay winner `pot − q` and rake `q`         |
| `claimTimeout` | anyone   | forfeit a player who missed their deadline, and move the game on                         |
| `abortTable`   | anyone   | refund `tier` to every seated player; nothing to the rake                                |

Helper circuits (`advanceTurn`, `stampTime`, `padTransaction`, `forfeitFlags`) are **not**
exported and are inlined — the compiler emits exactly one `.zkir` file and one key pair per
exported circuit, so
they cost nothing against the ceiling. Neither do the `pure` circuits from `dice-core`,
`scoring-core` and `policy-core`: a pure circuit produces no prover key, no verifier key and no
zkir at all.

---

## 2. Compile times

`--skip-zk` is the dev loop and emits byte-identical zkir, so its instruction counts are safe to
quote as circuit size; only key generation needs the full compile.

| contract  | `--skip-zk` | full ZK     |
| --------- | ----------- | ----------- |
| dice      | 0.79 s      | 46.2 s      |
| turn      | 7.97 s      | 59.1 s      |
| scoring   | 0.75 s      | 3.6 s       |
| takeTurn  | 24.3 s      | 78.3 s      |
| **table** | **1.03 s**  | **114.5 s** |
| **lobby** | **0.43 s**  | **26.4 s**  |

Reproduce with `npm run measure -w @yahtzee/contract` (writes `contract/build/measure/`).

**The headline is `table`'s 1.03 s.** `takeTurn.compact` — a single seat, no pot, no turn order —
takes 24.3 s, and its own header records that adding a whole-hand hold mask to it never finished
compiling at all ([scoring-circuit.md](scoring-circuit.md) §5, [bugs-found.md](bugs-found.md) #1).
The full six-seat game contract, with all six hold policies including two whole-hand ones,
compiles **24× faster** than the measurement scaffold it replaces.

That is not an optimisation, it is the two-transaction split. `resolveTurn` **derives** dice and
`takeTurn` **scores** them, so no merged die is ever read by `applyScore`. The defect is
(times a value is re-read) × (size of its expression DAG); the split puts a ledger write between
the two, and a ledger read is a fresh leaf. The design that docs/table-contract.md chose for
_game_ reasons — the player must see the dice before choosing a category — turns out to be the
only one that compiles.

---

## 3. Circuit size and artifacts

`<build>/zkir/<circuit>.zkir` instruction counts, and the keys from the full build.
Reproduce with `npm run zkir-stats -w @yahtzee/contract`.

| contract | circuit        | instructions | inputs |     prover key | verifier key |
| -------- | -------------- | -----------: | -----: | -------------: | -----------: |
| table    | `join`         |        1,035 |    131 |      9,960,155 |        2,119 |
| table    | `takeTurn`     |        2,319 |    134 |      9,967,349 |        2,119 |
| table    | `resolveTurn`  |    **3,030** |    129 | **38,515,740** |        2,119 |
| table    | `settle`       |        1,584 |    132 |      9,948,285 |        2,119 |
| table    | `claimTimeout` |        1,608 |    129 |      8,458,853 |        1,351 |
| table    | `abortTable`   |        2,244 |    129 |      8,458,463 |        1,351 |
| lobby    | `openTableAt`  |          484 |    131 |      9,943,571 |        2,119 |
| lobby    | `tableFilled`  |          525 |    129 |      9,943,409 |        2,119 |

Two things in that table are not what they look like, and both were established earlier in the
project rather than re-derived here:

- **Prover key size is not a cost measure.** PLONK rounds the proving domain up to a power of
  two, so it is a step function. `claimTimeout` (1,608 instructions) and `abortTable` (2,244)
  land within 400 bytes of each other; `settle` (1,584) is 1.5 MB _larger_ than `claimTimeout`
  despite being smaller. Rank designs by instruction count.
- **Verifier key size tracks the gate set, not the circuit.** Every circuit here that calls
  `persistentHash` is 2,119 B and every one that does not is 1,351 B, with no correlation to
  size. `claimTimeout` and `abortTable` are the two that never hash — a forfeit and a refund
  change no digest.

### `resolveTurn` is the outlier, and deliberately so

3,030 instructions, and the only circuit in the whole project on the 38.5 MB key step. It carries
six `persistentHash` calls (seed commitment, entropy mixing, three roll hashes, the resolve
digest) plus three passes of the rejection ladder. Its opcode mix confirms it is doing what it was
designed to: `cond_select=726`, `less_than=396`, `add=345` — the ladder's comparisons and the
mask's selects, in the predicted proportions.

The prover-key ladder across the whole project, which is the useful context for it:

```
39 KB → 147 KB → 281 KB → 547 KB → 2.8 MB → 8.5 MB / 10.0 MB → 19.5 MB → 38.5 MB
                                             (same step, gate set differs)
```

`dice/rollDice` (one roll) is 10.0 MB, `turn/resolveTurn` (three rolls, no policy dispatch) is
19.5 MB, and `table/resolveTurn` (three rolls, six policies, digest chain, ledger writes) is
38.5 MB — two steps up from a single roll.

**This is the one number the E2E run must check first**, for a reason that has nothing to do with
performance: [gate0-report.md](gate0-report.md) found the proof server ships only a subset of SRS
degrees and cannot reach `srs.midnight.network` from this environment. A 2 KB `persistentHash`
pushed a probe circuit to k=17, which is **not bundled**, and every `/prove` failed after ~366 s of
silent retries. `table/resolveTurn` is the largest circuit this project has ever built. Its k is
not readable from the artifacts, so it has to be proved to be known. See §7.

### What the transaction padding costs

`Padding` is 64 × `Bytes<32>` written after `kernel.checkpoint()` — the lever from Gate 0 that
grows a transaction past the ~8 KB `OutsideTimeToDismiss` admission floor without growing its
dismiss cost. Measured by recompiling the whole contract at three sizes:

| padding words | `resolveTurn` | `takeTurn` |    `join` |  inputs |
| ------------: | ------------: | ---------: | --------: | ------: |
|             8 |         2,749 |      2,038 |       755 |      17 |
|            32 |         2,869 |      2,158 |       875 |      65 |
|        **64** |     **3,030** |  **2,319** | **1,035** | **129** |

Exactly **5 instructions and 2 public inputs per word**, flat across every circuit — so the knob
is linear and predictable. `paddingWords()` in `table.compact` and the `Vector<64, …>` in the
`Padding` struct are the two places to change together.

Linear in instructions is not linear in **keys**, though, and that is the part that matters.
Full ZK build of the same contract at 8 words against the shipped 64:

| circuit        | prover key @ 8 words | @ 64 words | effect            |
| -------------- | -------------------: | ---------: | ----------------- |
| `abortTable`   |            2,140,815 |  8,458,463 | **+2 steps**      |
| `claimTimeout` |            2,141,142 |  8,458,853 | **+2 steps**      |
| `settle`       |            2,826,382 |  9,948,285 | **+2 steps**      |
| `join`         |            5,211,067 |  9,960,155 | **+1 step**       |
| `takeTurn`     |            5,216,689 |  9,967,349 | **+1 step**       |
| `resolveTurn`  |           38,503,722 | 38,515,740 | **none — 0.03 %** |

**The padding is what sets the proving domain for five of the six circuits, and is irrelevant to
the sixth.** Two consequences for the E2E run, and they point opposite ways:

- If one of the five small circuits turns out to sit at an SRS degree the proof server does not
  have, **cutting `paddingWords()` is the lever** — it moves them down one or two whole steps.
  That trades directly against the ~8 KB admission floor, which is the other bound, so the two
  have to be tuned against each other rather than independently.
- If **`resolveTurn`** is unprovable, padding will not save it. Its domain is set by three passes
  of the rejection ladder and six hashes, and shrinking the padding to an eighth moves it by
  0.03 %. The only lever left there is splitting the rolls across two transactions.

**Both consequences fired.** `resolveTurn` was indeed unprovable, and padding indeed did not save
it. The one thing this section did not anticipate is that the padding's cost was almost entirely
an artefact of it being a **circuit argument** — see §3.4.

### 3.4 As shipped, after the E2E run

Two changes, both forced, both measured. See [e2e-report.md](e2e-report.md) for how they were
arrived at and `table.compact` decisions 8 and 9 for why.

1. **The operator's move is three circuits, one roll each.** `resolveTurn` compiles to k=17; the
   proof server bundles k=9..15 only.
2. **The padding is a compile-time constant, not a `Padding` argument.** `pad(2048, ...)` written
   to the ledger after `kernel.checkpoint()`, which the compiler emits as a literal `StateValue`
   push inside the ledger op. The bytes still land in the transcript — so they still earn the
   dismiss-time allowance — but there are no public inputs and no per-word instructions.

| contract | circuit        | instructions | inputs | prover key | verifier key |   k |
| -------- | -------------- | -----------: | -----: | ---------: | -----------: | --: |
| table    | `join`         |          806 |      3 |  5,209,510 |        2,119 |  14 |
| table    | `takeTurn`     |        2,124 |      6 |  5,215,131 |        2,119 |  14 |
| table    | `resolveRoll1` |        1,254 |      1 |  9,987,859 |        2,119 |  15 |
| table    | `resolveRoll2` |          895 |      1 |  9,976,806 |        2,119 |  15 |
| table    | `resolveRoll3` |        1,786 |      1 |  9,990,317 |        2,119 |  15 |
| table    | `settle`       |        1,413 |      4 |  2,827,063 |        2,119 |  13 |
| table    | `claimTimeout` |        1,360 |      1 |    575,519 |        1,351 |  11 |
| table    | `abortTable`   |        1,996 |      1 |  1,079,284 |        1,351 |  12 |
| lobby    | `openTableAt`  |          233 |      3 |  2,821,203 |        2,119 |  13 |
| lobby    | `tableFilled`  |          274 |      1 |  2,820,987 |        2,119 |  13 |

> **Re-measured after the security-review remediation**
> ([security-review.md](security-review.md)). The row above is the post-fix contract. Six circuits
> moved by a handful of instructions and **not one moved a PLONK step** — `k` and `inputs` are
> identical to the pre-fix measurement, and the prover keys differ by tens of bytes on
> multi-megabyte objects:
>
> | circuit            | instructions        | why                                                          |
> | ------------------ | ------------------- | ------------------------------------------------------------ |
> | `join`             | 783 → 806 (+23)     | zero-address assert; `entropyKeyCommitment` gained `tableId` |
> | `takeTurn`         | 2,106 → 2,124 (+18) | `entropyKeyCommitment` gained `tableId`                      |
> | `resolveRoll1/2/3` | +18 each            | `seedCommitmentOf` gained `tableId`                          |
> | `settle`           | 1,336 → 1,413 (+77) | `seedCommitmentOf` + the deadline predicate and the ternary  |
> | `claimTimeout`     | unchanged           | untouched by the fixes                                       |
> | `abortTable`       | unchanged           | untouched by the fixes                                       |
>
> The two commitment hashes went from a 2-element to a 3-element `Vector<n, Bytes<32>>` and cost
> +18 instructions each rather than a whole extra hash pass: 64 bytes and 96 bytes need the same
> **two** SHA-256 compression blocks once padding is added, so the widening is nearly free. That
> mattered here rather than being a curiosity — `resolveRoll1/2/3` sit at the k=15 ceiling with no
> headroom, so a fix that had cost one more block would have had to be redesigned instead of
> shipped. The **constructor** grew sixteen explicit zero-inits and two new asserts and is not in
> this table at all, because constructors are not proved and emit no keys.

Read the `inputs` column against §3's: **129 public inputs became 1**. That is the whole of the
padding change, and it is worth one to three PLONK steps per circuit — `claimTimeout`'s prover
key fell from 8.46 MB to 0.58 MB, a factor of fifteen, for a contract that does exactly the same
thing and produces the same size of transaction.

The three resolve circuits sit at **k=15, the ceiling**, with no headroom at all. Any future
circuit work on the resolve path has to be checked with `npm run k -w cli` before it is trusted.

---

## 4. Hold policies — all six shipped

[table-contract.md](table-contract.md) expected to prune this set by measurement. **Nothing needed
pruning.** `contract/src/policy-core.compact` implements all six of
[api/src/policies.ts](../api/src/policies.ts)'s policies at their canonical encodings:

| code | policy          | mask fan-in     | in-circuit?         |
| ---: | --------------- | --------------- | ------------------- |
|    0 | `Stand`         | none            | yes                 |
|    1 | `RerollAll`     | none            | yes                 |
|    2 | `KeepModal`     | 1 die + witness | **witness-checked** |
|    3 | `KeepFace(1–6)` | 1 die           | yes                 |
|    4 | `ChaseStraight` | all 5 dice      | yes                 |
|    5 | `KeepPairsPlus` | all 5 dice      | yes                 |

- **`ChaseStraight` and `KeepPairsPlus` compile fine**, contradicting the cautious expectation in
  the spec. Both are whole-hand masks — every mask bit depends on all five roll-1 dice — which is
  the fan-in that killed the earlier attempt. It is harmless here because each merged die is read
  **once**, into the ledger write, instead of ~40 times by `applyScore`. Fan-in alone was never
  the trigger; fan-in × re-reads is.
- **`KeepModal` still cannot be computed**, exactly as the spec predicted, and ships via the
  witness-the-answer trick. The operator witnesses the modal face `m`; the circuit verifies
  canonical modality with six comparisons (`count[m] > count[f]` for `f > m`, `≥` for `f < m`) and
  the mask becomes `die == m` with `m` a fresh leaf. Nothing is trusted — `isCanonicalModal` is
  proved exhaustively equivalent to `modalFace` over all 252 sorted hands × 8 candidate faces in
  `src/test/table.test.ts`, so exactly one value produces a transaction.

The witness takes the roll's **public determinants** (`tableId`, the mixed entropy, the round)
rather than roll 1 itself. Taking the dice would force the circuit to derive roll 1 twice — once
to feed the witness, once to use it — and pay for the whole ladder again.

---

## 5. Deviations from docs/table-contract.md

Everything the spec specifies is implemented. Five things it left open or under-specified were
decided here; all five are argued at length in `table.compact`'s header, summarised for review:

1. **Seat storage is three ledger `Map`s keyed by seat index** (`seatIdentity`, `seatCard`,
   `seatProgress`), split by write frequency, with **all six slots pre-inserted by the
   constructor** so every runtime `lookup` is total. A `Vector` would make every runtime seat
   access a 6-way disjunction to read and a 6-way rebuild to write.
2. **The roll hash reaches the spec's input set one hash earlier.** The spec writes
   `H(seed, entropy_s(r), gameDigest, tableId, r, rollIndex)`. The implementation folds the digest
   into the entropy first — `mixed = H("mix", entropy, gameDigest)` — and hands `mixed` to
   `dice-core.compact`'s existing `RollContext` as `playerEntropy`. Same inputs, same
   domain separation, fixed-width fields throughout. The reason is compatibility: `RollContext`
   is pinned byte-for-byte by three measured contracts and by `src/dice-mirror.ts`, and adding a
   field would change the dice of every existing artifact and void the cross-check corpus.
3. **`100 <= tier <= 10^15` is enforced at construction**, so the 1% rake `q` is never 0 and `settle`
   never has to make a payment conditional. No division exists in language 0.26, so the rake is
   the witness-checked identity `q * 100 + r == pot, r < 100` — which has exactly one solution,
   and the remainder `r` rides with the winner.
4. **Time is declared and sandwiched.** The kernel has block-time predicates and **no accessor**
   — `blockTimeGt/Gte/Lt/Lte(Uint<64>)` exist, strict and seconds-based; `blockTime()` does not,
   and `kernel.blockTime` is "undefined for ledger field type Kernel". A circuit that must stamp
   `lastActionAt` therefore has to be told the time and pin the claim between two predicates,
   trapping `now` in `(blockTime − 120, blockTime]` plus `now >= lastActionAt`. Deadlines
   themselves are exact and read real block time. Details are in decision 5 of the contract
   header; the runtime trap that makes testing this delicate is
   [bugs-found.md](bugs-found.md) #12.

   The slack was 600 s and the incentive argument that justified it was **wrong**: on a hand-off
   transition the deadline you stamp belongs to the next actor, not to you, so under-declaring is
   free and costs someone else. The slack is now 120 s and the constructor refuses any timeout
   that is not strictly greater than `120 × 4`. See [security-review.md](security-review.md) §2's
   Critical.

5. **The contract never asserts its own token balance** — see §6.

### All-forfeited settlement: refund, not last-seat-standing

The spec left this open. **Chosen: when `claimTimeout` forfeits the last active seat, the table
goes to a new `abandoned` phase, `settle` refuses it, and `abortTable` refunds every seat its
`tier` with nothing to the rake — with no further waiting, since the timeout that produced
`abandoned` has already elapsed.**

Paying the pot to the last seat standing was rejected because it makes _timing out last_
profitable: with two seats left, the player who is behind can simply stop playing, and if the
other also stops, the one who stopped second collects. A refund makes walking away worth exactly
what it should be — nothing gained, nothing lost beyond the game.

Note the asymmetry with a **partial** forfeit, which is deliberate: a seat that forfeits while
others keep playing does **not** get its stake back. It stays in the pot and is paid to whoever
wins, and the forfeited seat still competes for that pot with whatever it had already scored
(`src/test/table.test.ts` constructs a game where a forfeited seat wins). Only the case where
_nobody_ is left has no winner to pay.

---

## 6. What the simulator cannot verify — for the E2E run

**`unshieldedBalance(nativeToken())` returns 0 under compact-runtime 0.19.0 no matter what
`receiveUnshielded` was handed, in the same circuit call.** New defect, written up as
[bugs-found.md](bugs-found.md) #11 with a standalone repro
(`contract/repro/bug11-unshielded-balance-simulator.compact`).

The consequence is sharper than it sounds. The natural guard —
`assert(unshieldedBalanceGte(nativeToken(), total))`, which `probes/gate0/src/pot.compact` carries
— is **false for every honest call** under the simulator, so a test suite that exercises a payout
cannot go green while it is present. `table.compact` therefore keeps its own `pot: Uint<64>` field
and asserts against that, and never calls `unshieldedBalance`.

**No offline test in this repo can fail if `receiveUnshielded` or `sendUnshielded` is given the
wrong amount, the wrong colour, or the wrong recipient.** The 114 passing tests cover the
contract's bookkeeping and its _choice_ of recipient; they cannot cover the transfer.

### The E2E devnet checklist

Verify per circuit, from the indexer's per-transaction UTXO movement
(`probes/gate0/tools/utxo-audit.mjs`) and **never** from a wallet's aggregate balance — Gate 0 §9
recorded the facade misreporting a balance by 4,900,000 in exactly this situation.

1. **`resolveTurn` can be proved at all.** Highest priority, and a potential blocker rather than a
   regression: it is the largest circuit in the project, two PLONK steps above a single roll
   (§3), and the proof server lacks some SRS degrees with no route to fetch them. Failure looks
   like a hang, not an error — check `docker compose logs proof-server | grep "Missing public
parameters"` before suspecting anything else. If it is unprovable, the fallback is to split
   the three rolls across two transactions, which the two-step turn already makes structurally
   easy but which costs another ~21 s per turn.
2. **Every circuit clears the ~8 KB admission floor** with `paddingWords() == 64`, and none is so
   large its k is unavailable. Both bounds, both directions, per circuit — six numbers. Retuning
   is not symmetric (§3): dropping the padding moves the five small circuits down one or two
   PLONK steps and moves `resolveTurn` by 0.03 %, so a padding change is a fix for an
   unavailable-k problem in the small circuits and no help at all for the big one.
3. **`join` moves exactly `tier`** from the joining wallet into the contract, and nothing else.
4. **`settle` spends zero user inputs** and creates exactly two outputs — `pot − q` to the
   winner's address as recorded at join, and `q` to the sealed rake address. The zero-user-input
   row is the one that demonstrates custody; it is what made Gate 0's `payOut` decisive.
5. **`abortTable` creates exactly `seatCount` outputs of `tier` each**, nothing to the rake, and
   **nothing to the unclaimed slots**. This is the only place in the contract where a token
   operation sits inside a conditional (`if (s < seatCount)` inside an unrolled loop). It
   compiles and it simulates, but a conditional `sendUnshielded` has never been executed against
   a real node in this project — if any construct here misbehaves on chain, it is this one.
6. **A winner who has never registered for DUST generation** receives spendable NIGHT that
   generates no DUST, so they cannot pay a fee with it (Gate 0's designation trap). Onboarding
   must register players before they act; worth re-confirming against a fresh wallet.

---

## 7. Test coverage

`npm test -w @yahtzee/contract` — **114 tests, all green** (62 pre-existing, 45 new for the table,
7 for the lobby). ~42 s.

The happy-path tests are **differential**: `src/test/table-harness.ts` plays a whole game through
the circuits while `replayGame` reconstructs the same game from the TypeScript mirrors and
[api/src/rules.ts](../api/src/rules.ts) alone, and every roll, digest, scorecard and running total
is compared as it is produced. That replay is not test scaffolding — it **is** the settlement
verifier, the thing the browser "verify this game" panel and the CLI verifier will run, and the
tests assert it reproduces a full six-seat game move for move.

Three mirrors, one per include file, all flat-exported from `@yahtzee/contract`:
`dice-mirror.ts` (the ladder, pre-existing), `policy-mirror.ts` (hold policies, entropy scheme)
and `table-mirror.ts` (the event digest chain).

Covered: the full 2-seat and 6-seat games with mixed policies and score-only round 13; the
digest chain; every entropy and authorisation rejection; category reuse and out-of-range
categories; the canonical encodings of the two rounds that omit an argument; wrong seed, wrong
turn, wrong sub-state; a lying modal-face witness at all six faces plus out-of-range; every hold
policy against the mirror; `isCanonicalModal` exhaustively over all 252 hands; both sides of every
timeout boundary; the declared-time sandwich in all three directions; all three tie-break legs;
and the pot arithmetic through join, settle, abort and abandon.

Two techniques worth reusing:

- **Continuous negative testing.** On every scoring move of the main games, the harness first
  asks the chain to accept a category the reference rules _refuse_, and requires a rejection —
  ~25 extra rejections per game, free, because the reference already knows what is illegal.
- **Scenarios that had to be found, not built.** Every die comes from a hash, so a tie cannot be
  arranged by hand and neither can a joker. Both were located by sweeping `replayGame` offline
  (milliseconds per game) and the discovered table ids are hard-coded, so the tests are
  deterministic and any change to the dice ladder, the masks or the digest chain breaks them
  loudly. Table id 30 under a KeepModal schedule produces a repeat Yahtzee — a real forced-joker
  placement plus the +100 bonus, on chain.

The tie-break needed three separate scenarios because two of its legs coincide in ordinary play:
among seats that finish, seat order **is** finish order. Only a forfeited seat, which carries
`noFinish()`, separates "earliest finisher" from "lowest seat" — so the discriminating test is a
seat that forfeits, ends level with a seat that finished, and correctly loses.

---

## 8. A residual the randomness design does not name

`table-contract.md` closes **entropy** grinding: `entropy_s(r)` is forced to
`H(sk_s, tableId, r)` against a join-time commitment, so a player has no free choice there. But a
player still makes one free, dice-affecting choice per turn — the **hold policy** — and makes it
after the game digest is public. A player who knows the seed can evaluate all **eleven** legal
choices (Stand, RerollAll, KeepModal, KeepFace × 6, ChaseStraight, KeepPairsPlus) and take the
best.

It is bounded and inherent rather than a flaw in this implementation: best-of-11 ordinary
outcomes, not the best-of-2^256 that free entropy would give, and any design where the player
makes a dice-affecting choice at turn time gives a seed-knower a preview of exactly that many
outcomes. Removing it means pre-declaring every policy at join, which costs the skill expression
the pipeline exists to preserve. It also **requires the seed**, so it falls under the assumption
the spec already relies on: the operator must not seat itself at tables it operates.

Recorded so that "entropy is non-grindable" is never read as "outcomes are unpredictable to a
seed holder". The full argument is in `table.compact`'s header.

---

## 9. Suggested changes to docs elsewhere

Not applied — reported for the owner of those documents.

- **`docs/table-contract.md`** should record: all six hold policies shipped (its §"Hold-policy
  set" expects pruning and lists `KeepGe4`, which is a measurement-scaffold policy and is **not**
  in `api/src/policies.ts` or in the contract); the `mixEntropy` framing of the roll input (§2
  above); the `abandoned` phase and the all-forfeited refund rule; the `tier >= 100` constraint;
  the declared-and-sandwiched time scheme, since "block-time seconds" alone does not say the
  clock cannot be read; and the policy-grinding residual (§8).
- **`README.md`** should state that `Table` and `Lobby` are the deployable contracts and that
  `dice`/`turn`/`scoring`/`takeTurn` are measurement scaffolds that stay in the tree.
- **`api/package.json`** blocks `@yahtzee/api/src/rules.ts` — its `exports` map publishes only
  `.` and `./node`, so Node rejects the subpath and `contract/src/test/scoring.test.ts` failed to
  load, silently taking its 35 tests with it (one failing _file_, not 35 failing tests). Worked
  around with a relative import on the contract side; the proper fix is a `./rules` subpath
  export, which is api's to make.
- **`npx prettier --check .`** has four pre-existing warnings this work did not touch:
  `contract/repro/README.md`, `docs/dice-circuit.md`, `docs/scoring-circuit.md` (markdown table
  alignment and one stray blank line). `docs/bugs-found.md` was reformatted, since this work
  appends to it.
