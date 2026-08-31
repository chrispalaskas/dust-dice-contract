# Scoring circuit

The other half of GATE 0 Q2 (docs/architecture.md). docs/dice-circuit.md priced turning a hash
into five fair dice; this prices turning five dice into a scorecard, and then prices the two
together, which is the shape `Table.takeTurn` will actually have.

- Sources: `contract/src/scoring-core.compact` (all the scoring logic, `include`d),
  `contract/src/scoring.compact` (scoring standalone + probes),
  `contract/src/takeTurn.compact` (dice **and** scoring in one circuit)
- Reference: `api/src/rules.ts` — contract-canonical, and the circuit is checked against it
- Tests: `contract/src/test/scoring.test.ts`
- Reproduce: `npm run measure -w @yahtzee/contract`, `npm test -w @yahtzee/contract`

Toolchain: Compact CLI 0.5.1, compactc 0.34.0, language 0.26.0,
`@midnight-ntwrk/compact-runtime` 0.19.0. Machine: x86_64 linux, single-threaded compile —
the same machine as docs/dice-circuit.md, so the numbers are comparable.

---

## 1. Headline

1. **Scoring is cheap. Dice are expensive.** The full official-rules scoring path is **579
   instructions and a 548 KB prover key**. One roll of five dice is 464 instructions and a
   **9.5 MB** prover key. Scoring costs **1/36th of the dice** in key size — because scoring
   never hashes, and `persistentHash` is what the prover key is mostly made of (§4).
2. **Full joker rules survived, complete and unsimplified.** Forced matching-upper placement,
   full-value lower jokers, the upper-fallback branch, and +100 only when the Yahtzee box
   holds 50. No simplification was needed. `api/src/rules.ts` and the site rules need no
   change.
3. **The two halves add up, exactly.** Combined `takeTurn` is 1 804 instructions;
   `probeRollsOnly` in the same contract is 1 260; the difference, 544, is within 6% of the
   579 that scoring costs standalone — and the gap is accounted for line by line (§5).
4. **But the combined circuit cannot use `keepModalFace`.** That is a compiler limit, not a
   cost limit, and it is the significant finding of this exercise. bugs-found.md #1's root
   cause was misdiagnosed; the corrected diagnosis and a three-file repro are in §6.
5. **Two new upstream defects.** `Uint<0..N>` silently excludes `N`, so `x as Uint<0..1>`
   throws on every `true` (bugs-found.md #10 — this one had already been written into the
   first draft of the code and only execution caught it). And docs/dice-circuit.md's
   "verifier keys are a constant 2 119 bytes" is **wrong** — §4.

---

## 2. Design: sums of products, not dispatch

A circuit has no branches, only selects, so a 13-way category dispatch computes all thirteen
values whichever way it is written. Written as a ternary ladder it is also thirteen nested
conditionals whose operands are themselves conditional results — the shape bugs-found.md #1
says not to write. So there is no dispatch:

```
score = sum over c of  (category == c) * value(c)
```

Exactly one selector is 1, so the sum is the score. Flat, nesting depth 1, and no more
expensive than the ladder would have been. The same rewrite is applied three more times:

| Reference shape in `rules.ts`                   | Circuit shape                                            |
| ----------------------------------------------- | -------------------------------------------------------- |
| `switch (category)` over 13 cases               | 13 products summed                                       |
| `if / else if / else` over 3 joker branches      | one Boolean disjunction, flattened by Boolean algebra     |
| `for` scan for the running-best seat             | all 36 pairwise comparisons                              |
| `card.scores[category]` (run-time index)         | 13-way disjunction / 13-way conditional vector rebuild    |

The winner rewrite is worth spelling out. `rules.ts` finds the winner with a scan that
replaces the leader on strict improvement. That is a running max — the same shape as
`modalFace` in turn.compact, which bugs-found.md #1 says cannot be nested. Because the order
(total, then earliest finish, then lowest seat) is **total**, "the maximum" is equivalently
"the one element that beats every other", which is 36 independent flat comparisons and no
chaining at all. It costs more instructions (246) and it cannot trip the compiler. Since it is
`pure`, it also carries no prover key either way.

### Representing `number | null`

`rules.ts` stores `number | null` per category. A circuit has no null, so `Scorecard` splits
it: `filled[c]` says whether the box is taken, `scores[c]` is 0 until it is. A scratched
category is `(0, true)` and an open one is `(0, false)` — exactly the distinction `null` draws,
and the reason `isComplete` reads `filled` rather than looking for non-zero scores.

### The rake, without division

Language 0.26 has no `/` and no `%` (bugs-found.md #2), so `pot / 100` cannot be evaluated
in-circuit. The quotient and remainder are supplied by the caller and the circuit checks the
Euclidean identity:

```
q * 100 + r == pot   and   r < 100
```

Uniqueness is the security argument: exactly one `(q, r)` satisfies both, so a supplied
quotient is as good as a computed one and an operator cannot inflate the rake by choosing a
different pair. `rake = q`, `winnerPayout = pot - q`, so the remainder goes to the winner —
`splitPot` in `rules.ts`. Cost: **36 instructions**, the cheapest circuit in the project.

---

## 3. Compile times

Each compile into a fresh directory (`contract/scripts/measure-build.sh`).

| Contract                        | `--skip-zk` | full ZK  |
| ------------------------------- | ----------- | -------- |
| `dice.compact` (5 circuits)     | 0.77 s      | 46.2 s   |
| `turn.compact` (2 circuits)     | 7.97 s      | 57.2 s   |
| `scoring.compact` (9 circuits)  | **0.64 s**  | **3.2 s** |
| `takeTurn.compact` (4 circuits) | **22.9 s**  | **78.4 s** |

`scoring.compact` has more circuits than the other three put together and compiles fastest of
the four, in both modes — sums of products are cheap to compile as well as cheap to prove.
`takeTurn.compact` is 36× slower than `scoring.compact` under `--skip-zk` for one extra
circuit, and that is the tail of bugs-found.md #1 (§6).

**`--skip-zk` and full ZK produce byte-identical zkir.** Checked on all 20 circuits across the
four contracts: instruction counts match exactly, every one. So `--skip-zk` is safe to quote
as circuit size, and it is 6–72× faster. Use it for everything but key generation.

---

## 4. Circuit size and keys

From `contract/scripts/zkir-stats.mjs`.

| Contract   | Circuit           | Instructions | Prover key | Verifier key |
| ---------- | ----------------- | -----------: | ---------: | -----------: |
| scoring    | `probeRake`       |       **36** |    148 800 |    **1 351** |
| scoring    | `resetCard`       |           87 |     39 076 |        1 351 |
| scoring    | `loadCard`        |          136 |    147 960 |        1 351 |
| scoring    | `probeCardWrite`  |          204 |    147 312 |        1 351 |
| scoring    | `probeRawScore`   |          243 |    281 245 |        1 351 |
| scoring    | `probeWinner`     |          246 |    546 532 |        1 351 |
| scoring    | `settleTable`     |          269 |    548 601 |        1 351 |
| scoring    | `probeApplyScore` |          524 |    282 506 |        1 351 |
| scoring    | **`scoreTurn`**   |    **579**   | **547 523**|        1 351 |
| takeTurn   | `probeRollsOnly`  |        1 260 | 19 519 507 |        2 119 |
| takeTurn   | **`takeTurn`**    |  **1 804**   | 19 524 992 |        2 119 |
| dice       | `rollDice`        |          464 |  9 965 533 |        2 119 |
| turn       | `resolveTurn`     |        1 447 | 19 522 042 |        2 119 |

### Two corrections to docs/dice-circuit.md

**1. Verifier keys are NOT constant.** dice-circuit.md §3 concluded "the verifier key is a
constant 2 119 bytes for every circuit measured, from 33 instructions to 2 163". That held only
because every circuit measured there hashed. Across all 20 circuits now measured the split is
perfectly clean:

| Uses `persistentHash` | Verifier key | Prover key range         |
| --------------------- | ------------ | ------------------------ |
| yes                   | 2 119 B      | 2.8 MB – 19.5 MB         |
| no                    | **1 351 B**  | **39 KB – 549 KB**       |

Every hashing circuit is 2 119 and every non-hashing circuit is 1 351, with no exceptions and
no correlation to instruction count — `probeHashOnly` is 33 instructions and 2 119 B; `loadCard`
is 136 instructions and 1 351 B. Key size tracks **which PLONK gates the circuit needs**, and
the SHA-256 gate is what costs. The revised claim: verifier keys are constant *within a gate
set*, at two observed values, and on-chain verification cost still does not grow with circuit
size.

**2. The prover-key step function goes much finer than 2.7 MiB.** dice-circuit.md observed
steps at ≈2.7 / 9.5 / 18.6 MiB and concluded key size is useless for comparing designs. The
steps below that are 39 KB, ≈148 KB, ≈282 KB, ≈548 KB — roughly doubling, as PLONK domain
rounding implies. The conclusion stands (`probeWinner` at 246 instructions and
`probeApplyScore` at 524 land on 547 KB and 283 KB respectively — the *smaller* circuit gets
the *bigger* key), but the resolution at the low end is better than it looked.

### Cost attribution

| Component                                                | Instructions |
| -------------------------------------------------------- | -----------: |
| Write an empty scorecard, no read (`resetCard`)           |           87 |
| Read a scorecard, write it back, total it twice           |          204 |
| `rawScore`, one category, 13 products summed              |         ≈156 |
| Joker-rule placement decision on top of `rawScore`        |         ≈281 |
| `placeScore` + card write + incremental total             |          ≈55 |
| Dice range check (5 dice, 2 comparisons each)             |          ≈35 |
| Winner tie-break, 6 seats, 36 pairwise comparisons        |          246 |
| Rake identity check                                       |           36 |

The opcode mix confirms the design. `scoreTurn` has **`test_eq` = 63** — thirteen category
selectors, thirteen `filledAt` positions, thirteen `setFilledAt`, and the count-equality
predicates — and **`mul` = 33**, which is the sum-of-products selectors and nothing else. There
is no `div_mod_power_of_two` anywhere in `scoring.compact`: no hash, no byte unpacking.

`probeWinner` costs `less_than` = 56 for 36 pairwise comparisons, which is the price of the
flat rewrite. A running max would be roughly a fifth of that; it would also be the shape that
does not compile when anything else reads its output.

---

## 5. The combined circuit: do the halves add up?

Yes, and the accounting closes.

| Circuit                          | Instructions | Prover key |
| -------------------------------- | -----------: | ---------: |
| `takeTurn/probeRollsOnly` (dice) |        1 260 | 19 519 507 |
| `takeTurn/takeTurn` (dice+score) |    **1 804** | 19 524 992 |
| difference — scoring in-circuit  |      **544** |    **5 485** |
| `scoring/scoreTurn` standalone   |          579 |    547 523 |

**544 against 579**, and the 35-instruction gap is exactly the dice range check that
`scoreTurn` needs and `takeTurn` does not: `takeTurn`'s dice come out of `deriveDice` and
cannot be anything but 1–6, so the five `assert d >= 1 && d <= 6` pairs are dropped. Nothing
else is unaccounted for.

Against the two-transaction route (`resolveTurn` 1 447 + `scoreTurn` 579 = 2 026), the combined
circuit is **222 instructions cheaper** — one ledger write instead of two, one dice range check
instead of one, and no `modalFace`.

And the prover key barely moves: **+5 485 bytes, 0.03%.** Adding the entire official rules of
Yahtzee to a turn that already derives fifteen dice is free at the key level, because the key is
sized by the three SHA-256 hashes. **Scoring is not a cost problem for this project.**

### Why `keepModalFace` is not available in the combined circuit

`takeTurn.compact` offers `keepNone` and `keepGe4` and asserts against `keepModalFace`. This is
forced. Measured, `--skip-zk`, three rolls with scoring on the final merged dice:

| Hold mask                | Merged-die fan-in | Reads of each merged die | Compile   |
| ------------------------ | ----------------: | -----------------------: | --------- |
| `die >= 4` (per-die)     |                 3 |     ~40 (full applyScore) | 10.2 s    |
| `die == d[0]` (fan-in 2) |                 4 |     ~40 (full applyScore) | 8.9 s     |
| `die == modalFace(roll1)`|                15 |               1 (diceSum) | 5.0 s     |
| `die == modalFace(roll1)`|                15 |             6 (isYahtzee) | 45.5 s    |
| `die == modalFace(roll1)`|                15 |              7 (rawScore) | **>150 s** |
| `die == modalFace(roll1)`|                15 |     ~40 (full applyScore) | **>200 s** |

A per-die hold predicate makes a merged die depend on three leaves — its own die in each of the
three rolls — and forty re-reads of a three-leaf value is free. A whole-hand predicate makes
*every* merged die depend on all fifteen ladder outputs plus the whole `modalFace` expression,
and the compiler re-expands all of it on every re-read.

`holdOne` in takeTurn.compact therefore takes **one die**, not the hand:

```compact
pure circuit holdOne(policy: HoldPolicy, die: Uint<8>): Boolean
```

The signature makes the constraint unrepresentable rather than merely commented. The enum keeps
turn.compact's variant order so the two contracts stay wire-compatible and one mirror
(`resolveTurnTs`) checks both.

**Three routes remain open for the real `Table.takeTurn`:**

1. **Per-die hold policies only.** One transaction per turn, 1 804 instructions, 19.5 MB key.
   Costs the game `keepModalFace`, which is the "chase a Yahtzee" policy — a real gameplay
   loss, and the one to weigh.
2. **Two transactions per turn.** `resolveTurn` writes the dice to the ledger, `scoreTurn` reads
   them back. A ledger read is a fresh leaf, so the DAG is cut and nothing blows up. All hold
   policies stay available. Both halves are already measured: 1 447 + 579. bugs-found.md §0 #21
   says one call per transaction is the safe shape anyway, so this costs a transaction, not a
   risk.
3. **Client-declared holds.** Pass the hold mask in as a circuit argument and assert it against
   the declared policy off-chain. The mask becomes a leaf, so fan-in collapses to 3 and every
   policy is available in one transaction. Not measured; it changes the trust model (the client
   asserts its own holds) and needs its own design pass.

Route 2 is the recommendation until bugs-found.md #1 is fixed: it keeps the game rules intact
and the cost is a transaction, which is measurable and bounded.

---

## 6. bugs-found.md #1 was misdiagnosed

The original write-up said compile time is exponential in the **nesting depth** of a `const`
reused inside a conditional, and prescribed "keep chains of comparisons whose operands are
themselves conditional results one level deep".

That prescription is followed to the letter throughout `scoring-core.compact` — and it is not
the mechanism. Two measurements say so:

- **Flattening does not help.** Rewriting `modalFace` from a 5-step running max into a flat
  argmax (six independent "is this face the maximum" predicates, summed — no chained
  conditionals whatsoever) leaves the combined circuit non-terminating at >200 s. Zero nesting,
  same blowup.
- **Fan-in alone does not cause it either.** A whole-hand mask built from a single `faceCount`
  gives every merged element fan-in 15, and compiles in 0.45 s.

The variable is **the size of the sub-expression that each re-read has to re-expand, times the
number of re-reads**, compounding through each layer. The compiler does not share
`const`-bound subexpressions, so a value read M times costs M expansions of its whole DAG —
and if that DAG itself contains a re-read value, the factors multiply.

`contract/repro/bug1-fanin-{narrow,wide-cheap,wide-modal}.compact` are three files identical
except for the three-line body of `mask`, with the same instruction count to within 6%:

| Repro variant | mask reads      | mask cost   | reuse=6 | reuse=12 | reuse=18 |
| ------------- | --------------- | ----------- | ------: | -------: | -------: |
| `narrow`      | own position    | 1 comparison| 0.43 s  | 0.48 s   | 0.57 s   |
| `wide-cheap`  | all 5 positions | 1 faceCount | 0.45 s  | —        | —        |
| `wide-modal`  | all 5 positions | running max | 3.89 s  | 25.5 s   | 51.6 s   |

`narrow` is flat in the reuse count. `wide-modal` is not, on identical instruction counts. That
is the defect in 116 lines with no hashing, no witnesses and no ledger ADTs.

The practical rule, restated:

> Before re-reading a value many times, ask what its expression DAG contains. If it carries a
> large shared sub-expression, cut the DAG first — put the value through the ledger, or take it
> as a circuit argument, or restructure so each element depends only on what it needs.

`totalAfterPlacing` in `scoring-core.compact` is that rule applied. The obvious
`cardTotal(placeScore(card, category, dice))` reads the newly-placed score **nineteen** times —
`setScoreAt` writes it conditionally into all thirteen slots, `grandTotal` sums thirteen and
`upperBonus` re-sums six. In `takeTurn` that score carries the merged-dice DAG, and the naive
form takes the compile from **23 s to 187 s** for an identical result. The incremental form
reads it twice. Same answer, pinned by the tests on every corpus case; 8× the compile speed.

---

## 7. Cross-check against api/src/rules.ts

`contract/src/test/scoring.test.ts`, 35 tests. The circuit is compared against the reference
engine, never against a second copy of itself.

| Check                              | Corpus                                              | Result       |
| ---------------------------------- | --------------------------------------------------- | ------------ |
| `rawScore`                          | **exhaustive**: 13 categories × all 6⁵ hands = 101 088 | exact match |
| `isYahtzee`                         | exhaustive: all 7 776 hands                          | exact match  |
| `applyScore` placement/score/bonus  | 2 500 scorecards × 13 categories = **32 500**        | exact match  |
| `placeScore` whole updated card     | every legal case of the 32 500                       | exact match  |
| `cardTotal` and `totalAfterPlacing` | every legal case of the 32 500                       | exact match  |
| `upperTotal`, `grandTotal`          | 2 500 scorecards                                     | exact match  |
| Joker scenarios                     | all 4 from `api/src/rules.test.ts`, plus 3 more      | exact match  |
| `winnerSeat`                        | 4 000 random tables, seat counts 2–6                 | exact match  |
| `splitPot`                          | 4 tiers × 5 seat counts, 9 boundary pots, 2 000 random | exact match |
| `scoreTurn` against a ledger        | a full 13-turn game, box by box                      | exact match  |
| `takeTurn` against a ledger         | a full 13-turn game, dice derived in-circuit          | exact match  |
| `takeTurn` dice vs turn.compact     | 2 policies × 13 rounds, via `resolveTurnTs`           | exact match  |

**All 35 pass. Zero divergences from `rules.ts` at any point.**

Two things about the corpus that matter more than its size:

**It is shaped, not just large.** Uniform random dice are a Yahtzee 6/7776 of the time, so a
plain random corpus would exercise the joker branches essentially never — and the joker branches
are the only part of `applyScore` with non-obvious behaviour. Two fifths of the cases are
five-of-a-kind with the Yahtzee box already taken. The test then *asserts on its own coverage*:
it counts how many cases reached the forced-upper branch, the lower-joker branch and the
scratched-box path, and fails if any is under 50. A corpus generator that drifts cannot make
this suite pass vacuously.

**Filled boxes get the reference's own scores.** A filled category is given
`refRawScore(cat, randomHand)` rather than an arbitrary number, so upper-section totals land
near the 63 bonus threshold about as often as a real game puts them there. The Yahtzee box is
special-cased to 0 or 50, its only real values, because which one it holds decides the +100.

The one branch a random corpus cannot reach is the upper fallback — it needs all six lower boxes
filled at once — so it has a targeted test instead, ported from `rules.test.ts`.

### The reference is imported, not re-implemented

`scoring.test.ts` imports `api/src/rules.ts` directly, as
`@yahtzee/api/src/rules.ts` through the workspace symlink. There is deliberately no
`scoring-mirror.ts`: unlike the dice, where `dice-mirror.ts` is the settlement verifier and has
to exist independently, the scoring reference already exists and is canonical. A second copy in
`contract/` would make the cross-check vacuous.

That import forced one tooling change: **Node's default strip-only type removal rejects
`export enum`** with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, because an enum has runtime behaviour
(including the `Category[value]` reverse mapping that `rules.ts` uses in its error messages)
that cannot be erased. Same family as dice-circuit.md §6.6's parameter properties, but this one
is in a file the contract package does not own and must not rewrite. So
`npm test -w @yahtzee/contract` now runs with `--experimental-transform-types`, which does the
full transform. All 27 pre-existing tests pass unchanged under it.

---

## 8. Language 0.26 surprises, continued from dice-circuit.md §6

**10. `Uint<0..N>` excludes `N`.** The documentation says `Uint<8>` and `Uint<0..255>` are the
same type. They are not. In compactc 0.34.0 the range spelling is exclusive of its upper bound,
so `Uint<0..256>` is `Uint<8>`, and `Uint<0..1>` is the single-value type `{0}`. Consequences,
all silent at compile time:

```compact
pure circuit flag(x: Boolean): Uint<0..1> { return x as Uint<0..1>; }  // throws on every true
```

This was in the first draft of `scoring-core.compact` — it is the natural spelling for a 0/1
selector, the compiler accepted it, `--skip-zk` accepted it, full ZK key generation accepted it,
and the first execution threw `cast from Field or Uint value to smaller Uint value failed: 1 is
greater than 0`. Full evidence and the repro: bugs-found.md #10. **Use the bit-width spelling
`Uint<1>`**, which is correct. Fixing it also removed 64 instructions of bogus range-check
asserts from `takeTurn` and 64 from `scoreTurn` — about 10%.

**11. A checked narrowing cast is a real assert, and that is useful.** `rawScore` ends with a
cast to `Uint<8>`. For dice in 1–6 the sum is at most 50 and the cast is free of consequence;
for a die of 255 the pip total is 1 275 and the cast **aborts**. So the circuit refuses to
misscore garbage dice, where `rules.ts` — which indexes its histogram by face value — corrupts
its own counts silently. The circuit is the stricter of the two. That is the right way round,
and `scoring.test.ts` asserts the behaviour so it is not rediscovered as a surprise.

**12. A run-time index into a `Vector` does not exist.** `card.scores[category]` has no
in-circuit form: vector indices must be compile-time constants. Reading is a 13-way disjunction
(`filledAt`), writing is a 13-way conditional rebuild (`setScoreAt`). Both are flat and cost
about 13 `test_eq` each — cheap, but they are the reason a scorecard is fixed-width and 13 long
rather than a `Map`.

**13. Nine circuits in one contract compile faster than two in another.** `scoring.compact` has
9 circuits and compiles in 0.64 s; `turn.compact` has 2 and takes 7.97 s. Circuit *count* is
irrelevant to compile time next to circuit *shape*. Do not batch circuits into separate
contracts to speed up the dev loop; fix the shape instead.

---

## 9. Conclusions for the design

1. **Full official joker rules are affordable and shipped.** No simplification. `rules.ts` and
   the site rules stand as written.
2. **Scoring costs almost nothing next to the dice.** 579 instructions, 548 KB prover key,
   +0.03% on the key of a turn that already hashes three times. Design the game around the dice
   budget; scoring is noise.
3. **The verifier key is 1 351 B without hashing and 2 119 B with it.** Correct
   dice-circuit.md's "constant 2 119 B". On-chain verification cost still does not scale with
   circuit size.
4. **One transaction per turn works — with per-die hold policies only.** 1 804 instructions.
   `keepModalFace` needs either the two-transaction split (§5, both halves measured) or a
   client-declared hold mask (unmeasured, changes the trust model).
5. **bugs-found.md #1's stated root cause is wrong and its prescription is insufficient.**
   Depth is not the variable; total re-expansion work is. Corrected diagnosis, three-file repro
   and a restated rule in §6.
6. **`totalAfterPlacing` over `cardTotal(placeScore(...))` is a 8× compile-time difference** for
   an identical result. Any new helper that reads a dice-derived value more than a few times
   needs the same treatment.
7. **Never spell a bounded integer `Uint<0..N>`** in compactc 0.34.0. Use `Uint<N>`.
8. **The settlement path is pure and therefore free.** `winnerOfSeats` and `splitPot` carry no
   prover key at all; only the impure wrapper that writes the result does. The 36-comparison
   flat winner rewrite costs nothing that matters.
