# Dice derivation circuit

Answers GATE 0 Q2's dice half (docs/architecture.md): what does the rejection ladder cost,
is it fair, and does a three-roll turn fit in one transaction?

Built and measured first, standalone, before any other contract code — it is the dominant
circuit cost in the project.

- Sources: `contract/src/dice-core.compact` (the derivation), `contract/src/dice.compact`
  (one roll + cost probes), `contract/src/turn.compact` (three rolls + hold policy)
- Verifier mirror: `contract/src/dice-mirror.ts`
- Tests: `contract/src/test/dice.test.ts`, `contract/src/test/fairness.test.ts`
- Reproduce: `npm run measure -w @yahtzee/contract`, `npm test -w @yahtzee/contract`

Toolchain: Compact CLI 0.5.1, compactc 0.34.0, language 0.26.0,
`@midnight-ntwrk/compact-runtime` 0.19.0. Machine: x86_64 linux, single-threaded compile.

---

## 1. The premise in architecture.md was wrong

architecture.md said:

> A 1–6 die from hash bytes: take a byte, reduce mod 8 (mask — power of two), reject 6 and 7,
> advance to the next byte. 25% rejection per candidate.

**There is no mask.** Language 0.26 has no bitwise operators at all — `&`, `|`, `^`, `<<`,
`>>` are not even lexed (`&` fails with `unexpected character '&'`, `>>` with
`parse error: found ">" looking for an expression`), and there is no `%` or `/` either.
Reducing a byte mod 8 means computing `b - 8*floor(b/8)`, and `floor(b/8)` is a 31-comparison
ladder. The cheap primitive the design assumed does not exist.

What does exist, verified by compiling each one:

| Operation                                              | Status                               |
| ------------------------------------------------------ | ------------------------------------ |
| `h[0]` on a `Bytes<32>`                                | works, yields `Uint<8>`              |
| `h as Vector<32, Uint<8>>`                             | works, unpacks all 32 bytes          |
| `Uint` relational operators (`<`, `>=`, …)             | work                                 |
| `(b >= 42) as Uint<8>`                                 | works — Boolean widens to an integer |
| `fold(lambda, init, vector)` with a struct accumulator | works                                |
| `&` `\|` `^` `<<` `>>` `%` `/`                         | **do not exist**                     |

So the primitive for slicing a value is a **monotone threshold ladder**: `sum of (b >= t_k)`.
And a threshold ladder does not have to bucket into a power of two — which reframes the
problem entirely.

---

## 2. Design chosen: byte ladder, 4 candidates per die

Rather than extract a 3-bit candidate and reject 2 of 8 values, bucket a **whole byte**
directly into six ranges:

```
accept  b < 252                       (252 = 6 x 42)
die     1 + #{ t in {42,84,126,168,210} : b >= t }
```

| Property                            | Value                                     |
| ----------------------------------- | ----------------------------------------- |
| Candidate width                     | one whole byte                            |
| Comparisons per candidate           | 6 (five thresholds + one acceptance test) |
| Accepted values                     | 252 of 256                                |
| Rejection probability per candidate | 4/256 = 1/64 = **1.5625%**                |
| Buckets                             | six ranges of **exactly 42** values each  |
| Face probability given acceptance   | exactly 42/252 = **1/6**                  |
| **Candidates per die**              | **4**                                     |
| **Exhaustion probability per die**  | **(1/64)^4 = 5.96 × 10⁻⁸**                |
| Bytes consumed per roll             | 5 dice × 4 = **20** of the hash's 32      |
| Hashes per roll                     | **1**                                     |

Die _d_ consumes hash bytes `4d … 4d+3`. The ranges are disjoint, so the five dice are
independent; bytes 20–31 are unused spare capacity.

### Entropy source and domain separation

One `persistentHash` over a single fixed-width struct — not a concatenation, so no field can
be slid into another:

```compact
struct RollContext {
  domain: Bytes<32>,         // pad(32, "yahtzee:v1:roll")
  tableId: Bytes<32>,
  seed: Bytes<32>,           // operator's commit-reveal seed
  playerEntropy: Bytes<32>,  // player's contribution
  round: Uint<8>,
  rollIndex: Uint<8>,        // 0, 1, 2 within a turn
  stream: Uint<8>,           // spare; 0 today
}
```

**One hash per roll is enough** — the question of "two hashes with a counter, or two 3-bit
candidates per byte" is moot, because the byte ladder needs only 20 of 32 bytes. The
`stream` field is there if a future roll ever needs more.

`pad(32, s)` places the UTF-8 bytes at the **start** of the buffer and zero-fills after.
This is not documented anywhere we could find; it was established by comparing the mirror's
hashes against the circuit's, and `dice.test.ts` keeps the check alive.

### Exhaustion fallback and its bias

If all four candidates reject, the die is **1**. That gives face 1 an extra 5.96 × 10⁻⁸ of
probability mass — about one spurious `1` per 16.8 million dice derived. A full 6-player
game derives roughly 1 170 dice, so the expected number of games affected before one
occurs is about 14 000. Documented, not fixed: adding a fifth candidate would cut it to
9 × 10⁻¹⁰ at a cost of 6 more comparisons per die, and it is not worth it.

Fairness is **exact conditional on acceptance** — the buckets are equal — so the fallback is
the _only_ source of bias in the design.

### The design that was rejected

The literal 3-bit ladder from architecture.md is implemented alongside
(`deriveDiceBitLadder`) purely so the comparison is measured rather than argued. Extracting
a 3-bit field costs a 7-comparison ladder (`floor(b/32)`), so its candidates cost _more_
than byte-ladder candidates while rejecting 16× more often: 25% rejection needs 12
candidates per die for the same 6 × 10⁻⁸, i.e. 84 comparisons per die against the byte
ladder's 24.

Measured: **4.7× more circuit instructions for identical output quality.** See §4.

---

## 3. Compile times and key sizes

Four compiles, each into a fresh directory (`contract/scripts/measure-build.sh`), run twice
to check reproducibility.

| Contract                    | `--skip-zk`       | full ZK           |
| --------------------------- | ----------------- | ----------------- |
| `dice.compact` (6 circuits) | **0.81 / 0.77 s** | **45.9 / 46.1 s** |
| `turn.compact` (2 circuits) | **7.95 / 8.00 s** | **58.6 / 57.0 s** |

Both runs produced byte-identical keys, zkir and instruction counts; only wall time varies,
and by under 3%.

The dev loop is genuinely fast: `--skip-zk` is 57× faster on dice and 7× on turn. Use it for
everything except key generation.

`turn.compact` compiles 10× slower than `dice.compact` under `--skip-zk` despite having a
quarter the circuits and a fifth the instructions. That is the tail of the blowup in
bugs-found.md #1 — `resolveTurn` sits one level below the cliff, not far from it.

### Prover and verifier keys

| Contract | Circuit              | Prover key               | Verifier key |
| -------- | -------------------- | ------------------------ | ------------ |
| dice     | `probeHashOnly`      | 2 823 322 B (2.69 MiB)   | 2 119 B      |
| dice     | `probeOneDie`        | 9 960 598 B (9.50 MiB)   | 2 119 B      |
| dice     | `rollDice`           | 9 965 533 B (9.50 MiB)   | 2 119 B      |
| dice     | `rollDiceSecretSeed` | 9 965 538 B (9.50 MiB)   | 2 119 B      |
| dice     | `rollDiceBitLadder`  | 9 989 905 B (9.53 MiB)   | 2 119 B      |
| turn     | `probeTwoRolls`      | 19 482 591 B (18.58 MiB) | 2 119 B      |
| turn     | `resolveTurn`        | 19 522 042 B (18.61 MiB) | 2 119 B      |

Two things to take from this table:

1. **The verifier key is a constant 2 119 bytes** for every circuit measured, from 33
   instructions to 2 163. On-chain verification cost does not grow with circuit size.
2. **Prover key size is a step function, not a cost measure.** `rollDice` (464 instructions)
   and `rollDiceBitLadder` (2 163 instructions) differ 4.7× in real size and land within
   0.25% of each other on key size — PLONK rounds the proving domain up to a power of two.
   The observed steps are ≈2.7 MiB, ≈9.5 MiB, ≈18.6 MiB. **Do not use key size to compare
   designs**; use the zkir instruction count.

---

## 4. Circuit size (zkir instruction counts)

From `contract/scripts/zkir-stats.mjs`.

| Contract | Circuit              | Instructions | Rolls of 5 dice              |
| -------- | -------------------- | -----------: | ---------------------------- |
| dice     | `probeHashOnly`      |           33 | 0 (hash + ledger write only) |
| dice     | `probeOneDie`        |          152 | 1 die                        |
| dice     | `rollDice`           |      **464** | 1                            |
| dice     | `rollDiceSecretSeed` |          466 | 1                            |
| dice     | `rollDiceBitLadder`  |    **2 163** | 1 (rejected design)          |
| turn     | `probeTwoRolls`      |        1 015 | 2                            |
| turn     | `resolveTurn`        |    **1 447** | 3                            |

### Cost attribution

Subtracting the probes apart:

| Component                                          | Instructions |
| -------------------------------------------------- | ------------ |
| `persistentHash` over `RollContext` + ledger write | 33           |
| `Bytes<32>` → `Vector<32, Uint<8>>` unpack         | ≈41          |
| One die, byte ladder (4 candidates)                | ≈78          |
| One die, bit ladder (12 candidates)                | ≈418         |
| Five dice + unpack + hash                          | 464          |

The opcode mix confirms the ladder is doing exactly what was designed:
`rollDice` contains **`less_than` = 120**, which is precisely 5 dice × 4 candidates × 6
comparisons. `cond_select` = 145, `add` = 100.

`rollDiceBitLadder` contains `less_than` = 570, `cond_select` = 845, plus 90 `assert`
instructions that the byte ladder does not have — range checks emitted by the `b - 32*top3(b)`
subtraction in `mid3`. Subtraction is checked in Compact, so peeling bits arithmetically
costs assertions as well as comparisons.

### Two findings worth carrying forward

**Witness-sourced input costs nothing over an argument.** `rollDice` (seed as a circuit
argument, 464 instructions, 9 965 533 B) versus `rollDiceSecretSeed` (seed from a witness,
466 instructions, 9 965 538 B): **2 instructions and 5 bytes.** Circuit parameters are
already private inputs to the proof, so keeping the operator's seed secret is free. The
compiler says as much when it refuses a ledger write of an argument — it calls `tableId`
"the value of parameter tableId" in a _witness_-disclosure error (§6).

**`div_mod_power_of_two` exists in ZKIR but not in the language.** `rollDice` emits 30 of
them and `resolveTurn` 90 (30 per hash) — they are the `Bytes<32>` → `Vector<32, Uint<8>>`
unpack. So the proving layer has a division-by-power-of-two primitive that language 0.26
gives no way to invoke. Had it been exposed, the mask-based design would have worked as
architecture.md assumed. Worth an upstream feature request.

### Linearity, and the full-game question

| Rolls | Instructions | Delta |
| ----- | ------------ | ----- |
| 1     | 464          | —     |
| 2     | 1 015        | +551  |
| 3     | 1 447        | +432  |

**Linear at ≈490 instructions per additional roll** (the 2-roll circuit carries the hold
policy that the 1-roll circuit does not, which is why the first delta is the larger one).

Extrapolating architecture.md's stretch goal — full-game settlement, 13 rounds × 3 rolls =
39 rolls — gives ≈19 000 instructions, roughly 13× `resolveTurn`. That is a 13× extrapolation
from measured data and no more than an indication; two power-of-two key steps above
`resolveTurn` puts the prover key near 75 MiB, and proving time was not measured here. **The
one-transaction-per-turn shape (a) is comfortable. Full-game settlement (c) should not be
committed to without measuring proving time on a real proof server.**

---

## 5. Turn shape: what holding actually costs

**Holding saves nothing in-circuit.** "Re-derive only the un-held dice" has no in-circuit
analogue: which dice are held depends on roll 1's values, unknown at compile time, so the
ladder for all five positions in rolls 2 and 3 exists in the circuit regardless. Holding is
a _select_ between the kept die and the freshly derived one — the derivation still happens.

Consequences, both confirmed by the measurements:

- A three-roll turn costs three full five-dice derivations. `resolveTurn` = 1 447 ≈ 3 × 464
  plus policy.
- **The hold policy is free.** All three policies are evaluated on every proof and the enum
  only selects among the results, so `keepNone` costs exactly what `keepModalFace` costs.
  Adding more policies later costs their evaluation on _every_ turn, not just the turns that
  use them — so keep the policy set small for cost reasons, not just UX ones.

Freshly derived dice for roll _i_ come from a hash with `rollIndex = i`, so a held die and
its replacement draw on disjoint entropy.

### The hold mask is latched, and a compiler defect forced it

The natural shape re-evaluates the policy on the merged dice before each re-roll. **It does
not compile** — compactc 0.34.0 spins at 100% CPU past 200 s and 1.3 GB RSS even with
`--skip-zk`, and never finishes. Root cause and minimal repro in
[bugs-found.md #1](bugs-found.md).

So `holdMask` is computed **once**, from roll 1, and both re-rolls use it. Measured on the
same machine, same source otherwise:

| Shape                       | `--skip-zk` compile                        |
| --------------------------- | ------------------------------------------ |
| Mask latched from roll 1    | **2.65 s**                                 |
| Mask re-evaluated each roll | **never completes** (>200 s, RSS climbing) |

This is a defensible design — it is what "pre-declared hold policy" already meant in
architecture.md, and a Yahtzee player may keep their holds across both re-rolls — but it was
**not chosen freely**, and that matters for the record. Its one behavioural cost:
`keepModalFace` chases whatever the first roll's modal face was, even if a later roll offers
a better one. If the defect is fixed, per-roll re-evaluation becomes available again.

---

## 6. Language 0.26 surprises

Each of these cost real time and none is in the documentation we had.

**1. No bitwise operators, no division, no modulo.** Covered in §1. The threshold ladder is
the substitute, and it is better than the masking design it replaced.

**2. `pure` circuits get no ZK keys at all.** An `export pure circuit` lands in the generated
`pureCircuits` object, compiles to plain JavaScript, and produces **no prover key, no
verifier key, and no zkir**. `ProvableCircuits` is empty for a contract whose every circuit
is pure. This is right — a pure function of public inputs needs no proof — but it means a
pure circuit **cannot be measured**. Every measured circuit here is a thin impure wrapper
whose only job is a ledger write.

**Corollary — architecture.md's "pure helper circuits inline and do not count (verify)" is
confirmed.** `dice.compact` exports 7 circuits, 5 impure and 2 pure, and the compiler prints
`Compiling 5 circuits`. `turn.compact` exports 3, 2 impure and 1 pure, and prints
`Compiling 2 circuits`. Pure circuits do not count against the deploy circuit-count ceiling.

**3. Exported circuit parameters are private by default, exactly like witness results.**
Writing an argument-derived value to the ledger fails with
`potential witness-value disclosure must be declared but is not`, and the compiler names the
culprit as "the value of parameter `tableId` of exported circuit `rollDice`". Arguments come
from the caller's local context; they are inputs to the proof, not public data. So `disclose()`
is needed for arguments too — and, per §4, sourcing a value from a witness rather than an
argument costs 2 instructions. Privacy here is close to free; what you pay for is _disclosure_.

**4. Compile time can be exponential.** bugs-found.md #1. The practical rule: keep chains of
comparisons whose operands are themselves conditional results **one level deep**.

**5. `include` is the reliable way to share Compact source.** `include "dice-core";` inserts
verbatim, so the included file carries no `pragma` and no `import`. Both contracts include
the same derivation, which is what makes "the mirror matches the circuit" meaningful across
both.

### TypeScript-side surprises

**6. `node --test` on `.ts` sources rejects TypeScript parameter properties.** Strip-only type
removal cannot erase `constructor(private readonly x: T)` without changing runtime behaviour,
so it errors with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The simulator uses plain fields.

**7. Strip-only mode does not remap a `.js` specifier onto a `.ts` file.** Sibling imports are
written `./dice-mirror.ts` with `allowImportingTsExtensions` +
`rewriteRelativeImportExtensions`, which rewrites them back to `.js` on emit. Generated
Compact output keeps `.js` — it really is JavaScript.

**8. TypeScript 6.0.3 does not find the workspace-hoisted `@types/node` from a workspace
subdirectory.** Every `node:` builtin import fails with `TS2591: Cannot find name
'node:crypto'`, which reads like a missing package; installing `@types/node` at any version
does not fix it. `"types": ["node"]` does. Relatedly, TS 6 now requires `rootDir` explicitly
once `outDir` is set (TS5011).

**9. Updated ledger and private state live at `results.context.callContext`,** not on
`results.context` — a `CircuitContext` holds a `queryContexts` map for the whole call tree and
`callContext` is the executing contract's view of it.

---

## 7. Fairness

Two properties, established two different ways.

### Exact fairness, by exhaustion over all 256 byte values

`dice.test.ts` enumerates every byte and asserts:

- exactly **252 of 256** values are accepted;
- the accepted values map onto faces 1–6 with **exactly 42 values each**.

So the ladder is provably unbiased _conditional on acceptance_. There is no statistics in
this part — it is a complete enumeration of the input space.

### Uniformity of the entropy, by chi-square

What enumeration cannot show is whether the bytes fed to the ladder are uniform — that is a
property of `persistentHash` and of the byte slicing. `fairness.test.ts` runs 20 000 rolls
(**100 000 faces**, twice the 50 000 asked for) through the TypeScript mirror.

Inputs are derived from a fixed seed (`sha256(label:i)`), not the system RNG, so the
statistic is reproducible on any machine. A test drawing fresh randomness fails at p=0.05
one run in twenty by definition.

**Hash path — 20 000 rolls, 100 000 faces, expected 16 666.67 per face:**

| Face | Count  | Deviation |
| ---- | ------ | --------- |
| 1    | 16 575 | −0.550%   |
| 2    | 16 730 | +0.380%   |
| 3    | 16 812 | +0.872%   |
| 4    | 16 613 | −0.322%   |
| 5    | 16 582 | −0.508%   |
| 6    | 16 688 | +0.128%   |

- **χ² = 2.6424**, critical value 11.07 (df = 5, p = 0.05)
- **VERDICT: FAIR** — cannot reject uniformity, and comfortably so (χ² is under a quarter of
  the critical value)
- Candidate rejections: 1 559 of 101 559 = **1.5351%** against the predicted 1.5625%
- Ladder exhaustions: **0** (expected 0.006 over 100 000 dice)

The rejection rate matching 1/64 to three decimal places is the strongest single check here:
it says the circuit is reading the bytes the mirror thinks it is.

A second run pushes uniform random bytes straight into the ladder, bypassing the hash, so a
failure can be localised to hashing/slicing versus the buckets. It also passes.

### Per-position uniformity, and a false alarm worth recording

Pooled counts can hide compensating per-position bias, so each of the five die positions is
tested separately: χ² = 2.998, 5.915, **16.728**, 3.480, 3.359.

Position 2 exceeds 11.07. **It is noise, and here is why:**

- Scaling the _same_ deterministic inputs 10× to 200 000 rolls drops position 2 to **5.23**.
  A real bias would have grown roughly 10×, to ≈167.
- Across four different input families the outlier moves to a different position every time
  (2, then 4, then 0, then 3) — the signature of the multiple-comparisons rate: testing five
  positions at p=0.05 flags at least one **23%** of the time (1 − 0.95⁵).
- Entropy byte 8 — position 2's first candidate — is uniform on its own: χ² = **4.71** over
  200 000 samples, with 3 123 rejections against 3 125 expected.

The test asserts against the p=0.001 bound (20.515) for exactly this reason, and prints the
p=0.05 comparison for information. The reporting was also changed so a fresh-randomness run
over the line does not print the word "biased".

### Circuit-versus-mirror agreement

The fairness numbers only mean something if the mirror is the circuit. `dice.test.ts`
cross-checks on random inputs:

| Check                                               | Inputs                                                           | Result                                               |
| --------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `deriveDice` mirror vs circuit                      | 50 random contexts                                               | exact match                                          |
| `deriveDiceBitLadder` mirror vs circuit             | 50 random contexts                                               | exact match                                          |
| `resolveTurnPure` mirror vs circuit, all 3 policies | 50 random contexts                                               | exact match on all three rolls                       |
| Dice in 1–6                                         | 200 random contexts                                              | all in range                                         |
| Determinism                                         | same context twice                                               | identical                                            |
| Circuit executed against a ledger                   | `rollDice`, `rollDiceSecretSeed`, `probeHashOnly`, `resolveTurn` | dice in range, ledger matches return, matches mirror |

The mirror is written independently — its own threshold ladder, its own byte slicing — rather
than delegating to the compiled circuit, or the cross-check would be vacuous. The one thing
it does not reimplement is `persistentHash`: it rebuilds the `RollContext` runtime type from
the runtime's public type descriptors and calls the runtime's own `persistentHash`.
Reimplementing Compact's field-aligned encoding would be reimplementing the platform.

**All 27 tests pass.**

---

## 8. Conclusions for the design

1. **Byte ladder, 4 candidates per die, one hash per roll.** 4.7× cheaper than the 3-bit
   design architecture.md assumed, exactly fair conditional on acceptance, exhaustion
   5.96 × 10⁻⁸.
2. **architecture.md's "Dice derivation" section needs correcting** — there is no mask, and
   the rejection rate is 1.6% not 25%.
3. **One transaction per turn is comfortable.** `resolveTurn` is 1 447 instructions and an
   18.6 MiB prover key, three full rolls included.
4. **Full-game settlement stays a stretch goal.** ≈19 000 instructions extrapolated; needs a
   proving-time measurement against a real proof server before anyone commits.
5. **Keep the hold-policy set small** — every policy is evaluated on every turn.
6. **Keep the operator's seed in a witness.** It costs 2 instructions.
7. **Verifier keys are constant-size (2 119 B)**, so on-chain verification cost is flat.
8. **Never compare designs by prover key size.** Use zkir instruction counts.
9. **A latched hold mask is a compiler-imposed constraint**, not a design choice. Revisit if
   bugs-found.md #1 is fixed.
