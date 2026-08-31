# Bugs found building on Midnight

Running log of defects discovered in upstream components while building Midnight Yahtzee,
kept from commit one so each becomes an upstream issue/PR instead of tribal knowledge.

Format per entry: **symptom**, **root cause**, **workaround/fix**, **intended upstream action**.
Status legend: **patched-locally** (fix applied on a local checkout, needs upstreaming),
**worked-around** (avoided, root cause remains), **fixed-here** (fixed in this repo),
**open** (unresolved/watching), **inherited** (known from the neighbouring project
`dapp-hackathon-team-1`, re-confirmed or pre-empted here).

## 0. Inherited prior art

This project builds on the same toolchain as `dapp-hackathon-team-1` (compactc 0.33/0.34,
ledger-9.1.0.0-rc.3, node 2.0.0-rc.4). Its `docs/bugs-found.md` documents 24 defects we
treat as prior incidents, the most load-bearing being:

- **#8/#22 — `1010: Custom error: 170` has multiple causes**: node↔SDK ledger-tag pairing
  mismatch (deterministic from first deploy); fee-state drift after sustained chain load
  (permanent, only a fresh chain clears it); concurrent DUST spends from one wallet
  (in-flight spends race). Only the node log distinguishes them.
- **#21 — client-side gas under-declaration on multi-call transactions**: `gas_heuristic`
  declares a flat 1.2× per call with no term for calls-per-transaction; ~15% failure at
  2 calls, 60% at 3. Workaround: one call per transaction; where impossible (c2c), inflate
  the _fallible_ transcript budget only (`MIDNIGHT_GAS_FACTOR` patch on
  `@midnight-ntwrk/compact-js`). Inflating the guaranteed half is rejected at admission
  (`OutsideTimeToDismiss`).
- **#11 — `contractStateObservable` misses rapid successive updates**: one-shot
  `queryContractState` for read-after-write; observable only for live UI.
- **#12/#18 — level private-state provider self-deadlocks and silently drops
  function-valued fields**: memoize one `Level` per dbName; keep private state plain data.
- **#13 — `kernel.self()` returns zeros in constructors**: instance ids must be constructor
  arguments.
- **#15 — `MerkleTree.insertHash` expects the tree's own leaf digest**: use `.insert(value)`.
- **#24 — `FetchZkConfigProvider` defaults `verify: 'require'`** and only a real wallet proof
  exercises the path: pass `verify: 'off'` for local-devnet artifacts, with a comment.
- **#6 — `wallet-sdk-facade` needs `overrides: { "@midnight-ntwrk/wallet-sdk-utilities": "1.2.1" }`**,
  and an incremental `npm install` does not re-resolve a new override — clean reinstall only.
- **#7 — wallet facade `isSynced` hangs forever** (shielded sync never connects): wait on
  dust + unshielded sync only.

Entries below are new findings in this repo.

---

## 1. compactc 0.34.0: exponential compile time on nested conditional reuse — **open**

**Symptom.** `compact compile --skip-zk` never finishes. The compiler spins at 100% CPU with
RSS climbing past 1.3 GB; killed at 200 s with no output and no error. Adding full ZK key
generation is irrelevant — it never reaches that stage. No diagnostic, no progress output,
nothing distinguishing it from a hang.

Hit while building `contract/src/turn.compact`: three rolls of five dice where the hold
policy is re-evaluated on the merged dice before each re-roll. Two rolls compiled in 1.48 s;
three never completed.

**Root cause.** Compile time is exponential in the nesting depth of a `const` binding that is
reused inside a conditional. The compiler expands the expression DAG into a tree rather than
sharing bound subexpressions, so each level of nesting multiplies.

Measured with a `step` circuit whose body uses its argument twice in a conditional, composed
N deep — no hashing, no witnesses, no ledger ADTs, one `Uint<8>` in and out:

| Nesting depth | `--skip-zk` compile |
| ------------: | ------------------- |
|             4 | 0.35 s              |
|             8 | 0.47 s              |
|            12 | 1.24 s              |
|            16 | 4.66 s              |
|            20 | 17.76 s             |

≈1.39× per level, and it is smooth — there is no cliff, just a growth curve that crosses
usability. The two uses per level would give 2× if nothing were shared, so some sharing
happens; not enough.

The practical trigger is a **running-max chain**: comparisons whose operands are themselves
the results of earlier conditionals. A 30-line repro with no dependencies — `faceCount` (five
equality comparisons summed), `modalFace` (a six-step running max over those counts), and a
`step` that selects using `modalFace`'s result — composed N deep:

| `modalFace` nesting | `--skip-zk` compile                        |
| ------------------: | ------------------------------------------ |
|                   1 | 1.85 s                                     |
|                   2 | **never completes** (>120 s, RSS climbing) |

One level is fine, two is unbounded. Both repros are committed, with run instructions, at
`contract/repro/` (`bug1-modalface-nesting-{1,2}.compact` and
`bug1-const-reuse-depth-{12,20}.compact`) — attachable to an upstream issue verbatim and
re-runnable against a future compiler to check whether it is fixed.

Confirmed **not** related to: the dice rejection ladder (the blowup reproduces with one
candidate per die, and with no hashing at all); ledger ADTs; witnesses; `fold`; `--skip-zk`
versus full ZK; simple comparisons at depth (`d >= 4` re-evaluated on merged dice compiles in
0.44 s).

**Workaround — worked-around.** Keep chains of comparisons whose operands are themselves
conditional results **one level deep**. In `turn.compact` the hold mask is computed once from
roll 1 and reused for both re-rolls rather than re-evaluated per roll:

| Shape                       | `--skip-zk` compile |
| --------------------------- | ------------------- |
| Mask latched from roll 1    | **2.65 s**          |
| Mask re-evaluated each roll | **never completes** |

The latched form is a defensible design in its own right (see docs/dice-circuit.md §5), so
this costs the project little — but it is a constraint imposed by the compiler, not chosen,
and it is recorded as such. Note also that `turn.compact` still compiles 10× slower than the
much larger `dice.compact`: the workaround sits below the cliff, not far from it. Any future
`Table.takeTurn` that adds scoring on top of merged dice should expect to meet this again.

**Intended upstream action.** Issue against `LFDT-Minokawa/compact` with the 24-line depth
scaling repro and the 30-line `modalFace` repro, both self-contained. Two asks: (1) share
`const`-bound subexpressions instead of re-expanding them per use site; (2) failing that,
emit a diagnostic or a progress indicator so an exponential expansion is distinguishable from
a hang — the current behaviour costs an hour before anyone suspects the compiler.

## 2. Language 0.26: `div_mod_power_of_two` exists in ZKIR but is unreachable from Compact — **open**

**Symptom.** Not a defect, a capability gap worth filing. Language 0.26 has no bitwise
operators (`&`, `|`, `^`, `<<`, `>>` are not lexed), no `%` and no `/`, so extracting a bit
field from a byte has to be done with comparison ladders — `floor(b/32)` costs seven
comparisons, and `b mod 8` costs 31.

**Root cause.** The capability is present one layer down. The compiled zkir for
`contract/src/dice.compact` contains 30 `div_mod_power_of_two` instructions per hash — the
`Bytes<32>` → `Vector<32, Uint<8>>` unpack. The proving layer has a
division-by-power-of-two primitive; the surface language gives no way to invoke it.

**Workaround — worked-around.** Threshold ladders, which turned out better than the masking
design they replaced (docs/dice-circuit.md §2): bucketing a byte into six ranges of 42 costs
6 comparisons and rejects 1.6% of the time, against a 3-bit mask's 7+ comparisons and 25%.
So this cost design time, not runtime.

**Intended upstream action.** Feature request against `LFDT-Minokawa/compact`: expose
`divModPowerOfTwo` (or bitwise `&`/`>>` on `Uint<N>`) as a stdlib primitive lowering to the
existing zkir op. Worth noting in the request that the absence is not documented — the gap
was found by reading generated zkir, and the Midnight docs' own dice/randomness examples
assume masking is available.
