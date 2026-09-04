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

**Root cause.** The compiler expands the expression DAG into a tree rather than sharing
`const`-bound subexpressions, so a value read _M_ times costs _M_ expansions of its entire
DAG — and where that DAG itself contains a re-read value, the factors multiply.

> **AMENDED 2026-08-31 — the original diagnosis below was wrong.** This entry first said
> compile time is exponential in the **nesting depth** of a `const` reused inside a
> conditional, and prescribed keeping such chains one level deep. Building the scoring
> circuit falsified both halves: see "Corrected diagnosis" after the original measurements,
> and docs/scoring-circuit.md §6. The measurements themselves stand; the explanation of them
> did not. The prescription was followed to the letter in `scoring-core.compact` and did not
> prevent the blowup.

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

### Corrected diagnosis — nesting depth is not the variable

Hit again building `contract/src/takeTurn.compact` (dice and scoring in one circuit), which
this entry predicted in its last line. Two measurements kill the depth explanation:

- **Flattening does not help.** Rewriting `modalFace` from a 5-step running max into a flat
  argmax — six independent "is this face the maximum" predicates, summed, with no chained
  conditionals at all — leaves the combined circuit non-terminating at >200 s. Zero nesting,
  same blowup.
- **Fan-in alone is not it either.** A whole-hand mask built from a single `faceCount` gives
  every merged element the same fan-in of 15 and compiles in **0.45 s**.

The variable is **the size of the sub-expression each re-read must re-expand, times the number
of re-reads**, compounding layer by layer. Measured on the real contract, `--skip-zk`, three
rolls with scoring on the final merged dice:

| Hold mask                 | Merged-die fan-in | Reads of each merged die | Compile    |
| ------------------------- | ----------------: | -----------------------: | ---------- |
| `die >= 4` (per-die)      |                 3 |    ~40 (full applyScore) | 10.2 s     |
| `die == d[0]`             |                 4 |    ~40 (full applyScore) | 8.9 s      |
| `die == modalFace(roll1)` |                15 |              1 (diceSum) | 5.0 s      |
| `die == modalFace(roll1)` |                15 |            6 (isYahtzee) | 45.5 s     |
| `die == modalFace(roll1)` |                15 |             7 (rawScore) | **>150 s** |
| `die == modalFace(roll1)` |                15 |    ~40 (full applyScore) | **>200 s** |

A third repro pins it in 116 self-contained lines with no hashing, no witnesses and no ledger
ADTs: `contract/repro/bug1-fanin-{narrow,wide-cheap,wide-modal}.compact` are identical except
for the three-line body of `mask`, and their instruction counts agree to within 6% (1 293 /
1 303 / 1 367).

| Repro variant | `mask` reads    | `mask` cost   | reuse=6 | reuse=12 | reuse=18 |
| ------------- | --------------- | ------------- | ------: | -------: | -------: |
| `narrow`      | own position    | 1 comparison  |  0.43 s |   0.48 s |   0.57 s |
| `wide-cheap`  | all 5 positions | 1 `faceCount` |  0.45 s |        — |        — |
| `wide-modal`  | all 5 positions | running max   |  3.89 s |   25.5 s |   51.6 s |

`narrow` is flat in the reuse count; `wide-modal` is not, at equal instruction counts.

**Workaround — worked-around.** Restated: **before re-reading a value many times, ask what its
expression DAG contains.** If it carries a large shared sub-expression, cut the DAG first — put
the value through the ledger, take it as a circuit argument, or restructure so each element
depends only on what it needs. Three applications in this repo:

| Shape                                                     | `--skip-zk` compile |
| --------------------------------------------------------- | ------------------- |
| `turn.compact`, hold mask latched from roll 1             | **2.65 s**          |
| `turn.compact`, hold mask re-evaluated each roll          | **never completes** |
| `takeTurn.compact`, per-die hold policy                   | **22.9 s**          |
| `takeTurn.compact`, `keepModalFace`                       | **never completes** |
| `takeTurn`, incremental `totalAfterPlacing`               | **22.9 s**          |
| `takeTurn`, `cardTotal(placeScore(...))` — 19 reads not 2 | **187 s**           |

`takeTurn.compact` ships with a `holdOne(policy, die)` signature that cannot see the other four
dice, so the constraint is enforced by the type rather than by a comment. The cost to the game
is real and is recorded in docs/scoring-circuit.md §5: the combined one-transaction circuit
cannot offer `keepModalFace`, and the alternatives are a two-transaction turn (both halves
measured) or a client-declared hold mask (unmeasured).

**Intended upstream action.** Issue against `LFDT-Minokawa/compact` with all five self-contained
repros — the depth-scaling pair, the `modalFace` nesting pair, and the three-file fan-in set.
Three asks: (1) share `const`-bound subexpressions instead of re-expanding them per use site;
(2) failing that, emit a diagnostic or a progress indicator so an exponential expansion is
distinguishable from a hang — the current behaviour costs an hour before anyone suspects the
compiler; (3) document the cost model, so "this value is read forty times" is a thing a
developer knows to look for.

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

## 3. ledger 9.1: a minimal contract call is unconditionally inadmissible (`OutsideTimeToDismiss`) — **worked-around**

**Symptom.** Every call to a small Compact circuit is rejected before it reaches a block. The
client reports only `1010: Invalid Transaction: Custom error: 231`. Only the node log names it:

```
Transaction malformed: exceeded the maximum time to dismiss for transaction size;
this transaction would take 15.968ms to dismiss, but given its size of 7146 bytes,
it may take at most 15.000ms
Rejected transaction … : Transaction Error: Malformed(FeeCalculation(OutsideTimeToDismiss))
```

Deploys pass (they are large and carry no proof); calls fail. Nothing about the error suggests
"your transaction is too small", which is what it means.

**Root cause.** `midnight-ledger` @ `ledger-9.1.0.0-rc.3`:

```
allowance    = max(min_time_to_dismiss, time_to_dismiss_per_byte × est_size())  [structure.rs:2373-2376]
dismiss_cost = guaranteed_transcript_gas + validation_cost                       [structure.rs:2358-2363]
```

`INITIAL_LIMITS` (`structure.rs:1237-1285`): `min_time_to_dismiss = 15.000 ms`,
`time_to_dismiss_per_byte = 0.002 ms`. `validation_cost` is dominated by fixed cryptographic
constants — `proof_verify` 5.825 ms + `verifier_key_load` 3.407 ms per contract call, plus
another `proof_verify` per DUST spend, plus signatures and a doubled baseline
(`onchain-vm/gen/const_declaration.rs`, `structure.rs:1958-2047`).

So admissibility requires `size ≥ 500 bytes per ms of dismiss cost` — **≥ 7,984 bytes** at the
~15.97 ms fixed cost of one proof plus one DUST spend. The fixed verification cost of the
minimum viable contract call cannot be paid for by a minimum-sized transaction. Two observed
rejections fit the formula exactly:

|     Size |                     Allowance | Dismiss cost |
| -------: | ----------------------------: | -----------: |
|  7,146 B |             15.000 ms (floor) |    15.968 ms |
| 10,282 B | 20.564 ms (`= 10282 × 0.002`) |    21.698 ms |

`enforce_time_to_dismiss` is hard-coded `true` (`verify.rs:662`); only genesis-block processing
is lax, and the node toolkit's `update_ledger_parameters` does not expose these limits (it
spreads `..base.limits`). It cannot be configured away on a running chain.

**Workaround — worked-around.** Pad the transaction with a struct written to the ledger
**after `kernel.checkpoint()`**. A fallible-phase write counts toward `est_size()` but lands in
`f_cost`, which `time_to_dismiss` never sums — so the transaction grows without the dismiss cost
growing. 2 KB took `probes/gate0/src/pot.compact`'s calls from 7,146 B to 9,035–10,171 B, all
admitted. Controlled experiment on one deployed contract: `stakeIn` (unpadded) rejected 6/6,
`stakeInPadded` (identical token semantics) admitted first try.

Two things that do **not** work, both tried:

- `kernel.checkpoint()` alone, moving all contract work to the fallible phase: 15.967 → 15.968 ms.
  The contract transcript is not what is being measured.
- Padding via `persistentHash` over the 2 KB: pushes the circuit to k=17 → unprovable here (§4).
  Transaction bytes and circuit size are independent levers and padding must move only the first.

**Intended upstream action.** Issue against `midnightntwrk/midnight-ledger`. Two asks:
(1) the floor makes small contract calls unconditionally invalid — either `min_time_to_dismiss`
should also floor the _permitted_ cost, or the fixed per-proof verification cost should be
excluded from `cost_to_dismiss`, because as written the cheapest possible contract call can never
be admitted; (2) the rejection should say so — surface the required minimum size in the error,
and give the client-side SDK a pre-submission check rather than letting `Custom error: 231` be
the only signal. Also worth filing against `midnight-js`: the SDK can compute `est_size()` and
`cost()` locally and should refuse to submit with a diagnosis instead of a bare RPC error.

## 4. proof-server 9.0.0-rc.5: SRS fetched from the internet at prove time; small circuits unprovable offline — **open**

**Symptom.** Some circuits prove in ~0.35 s; others hang for ~366 s and then fail. The proof
server log:

```
Missing public parameters for k=5. Attempting to download from the host https://srs.midnight.network/
error sending request for url (https://srs.midnight.network/bls_midnight_2p5). Retrying...
… Giving up.
Error in response: BadInput("Failed to fetch data from https://srs.midnight.network/bls_midnight_2p5 after 3 attempts. Giving up.")
POST /prove HTTP/1.1; took 362.657546s
```

The client sees a proof-provider failure with no mention of a download, after six minutes.

**Root cause.** The image ships a subset of SRS degrees and lazily downloads the rest from
`srs.midnight.network` on first use. Where that host is unreachable, any circuit whose k is not
bundled is unprovable. Counter-intuitively the gap includes **small** degrees: `k=5` is missing,
so `probes/gate0/src/ctl.compact` — a single `Counter` increment, the cheapest contract call
that can be written — cannot be proved at all, while a much larger circuit proves in 0.35 s.
`k=17` (a `persistentHash` over 2 KB) is also missing.

This interacts badly with §3: §3 forces transactions to be _larger_, and one obvious way to
enlarge them changes the circuit's k and lands on a missing degree.

**Workaround — worked-around.** Keep circuit size inside the bundled degrees, and grow
transactions by a post-checkpoint ledger _write_ rather than by hashing (§3). When proving
appears to hang, check
`docker compose -p yahtzee-devnet logs proof-server | grep "Missing public parameters"` — the
symptom is otherwise indistinguishable from a slow proof.

**Intended upstream action.** Issue against the proof-server image: (1) bundle the full range of
degrees, or at minimum document which are bundled so a project can stay inside them; (2) fail
fast and explicitly when the SRS host is unreachable — six minutes of silent retries followed by
a generic `BadInput` is the worst possible surface; (3) support an offline/pre-seeded SRS
directory via a volume mount and an env var, which is what a local devnet needs.

## 5. wallet-sdk 2.0.0-beta.2: DUST registration cannot pay for itself on a freshly funded wallet — **worked-around**

**Symptom.** `registerNightUtxosForDustGeneration` throws on a wallet funded seconds earlier:

```
Error: Insufficient generated dust to cover registration fee
(have 214942000000000, need 510950455244571).
Use WalletFacade.waitForGeneratedDust(utxos, 510950455244571) before retrying.
```

**Root cause.** A genuine bootstrap ordering: the registration transaction pays its own fee in
DUST, and the only DUST available to a wallet whose NIGHT is not yet registered is what that
NIGHT has _projected_. Projected DUST scales with NIGHT held, so a modestly funded wallet has to
wait — at 1,000 NIGHT the projection reached only ~215e12 against a ~511e12 fee.

**Workaround — fixed-here.** `probes/gate0/src/wallet.ts`'s `ensureDustRegistered` uses the
SDK's own intended sequence: `estimateRegistration(utxos)` → `waitForGeneratedDust(utxos, fee)`
→ `registerNightUtxosForDustGeneration`. Also fund new wallets generously: at 10,000,000 NIGHT
the threshold is met immediately, at 1,000 NIGHT it is a long wait.

Note the error message is unusually good — it names the exact remedy and the exact figure. The
defect is that the happy path does not do this itself.

**Intended upstream action.** Low-severity issue against `midnightntwrk/midnight-wallet`:
`registerNightUtxosForDustGeneration` should optionally await its own fee threshold (an
`{ awaitFee?: boolean }` or `{ timeoutMs }` option) rather than requiring every caller to
reimplement the estimate→wait→register dance. Also worth documenting prominently: **a new user
cannot transact at all until registered, and registration is not free** — this is a mandatory
onboarding step, not an optimisation.

## 6. ledger 9.1: `InvalidDustSpendProof` is transient and indistinguishable from a permanent failure — **worked-around**

**Symptom.** Roughly 1 attempt in 3, immediately after the same wallet has spent, a submission
fails with `1010: Invalid Transaction: Custom error: 170`. The node log:

```
Transaction malformed: dust spend proof failed to verify; this is just as likely a disagreement
on dust state on the declared time (Timestamp(…)) as the proof being invalid: DustSpend { … }
Rejected transaction … : Transaction Error: Malformed(InvalidDustSpendProof)
```

Retrying the identical operation succeeds. Observed on deploys (failed, then succeeded on
attempts 2 and 3 unchanged) and on circuit calls.

**Root cause.** Not fully established. The node's own message says it: the wallet's view of DUST
state at the timestamp it declared disagrees with the node's. This is the same client error 170
that `bugs-found.md` §0 #8/#22 records as having several distinct causes; this one is the
transient race, not the deterministic ledger-tag mismatch.

**Workaround — fixed-here.** `probes/gate0/src/step.ts`'s `retryCall` retries with backoff, and
takes a **mandatory** `landed` predicate that re-reads chain state before each retry. That part
is not optional: a thrown submission error does not prove nothing landed, and blindly retrying a
`stakeIn` would double the pot and silently invalidate every balance the probe measures.

**Intended upstream action.** Issue against `midnightntwrk/midnight-wallet` /
`midnight-ledger`: either the wallet should re-derive its dust state against a fresh timestamp
before declaring one (making the race not happen), or the error should be classified as
retryable so SDK clients can distinguish it from a permanent malformation. As it stands, error
170 conflates at least three unrelated conditions and none of them is recoverable from the
client's side without reading the node's log.

## 7. midnight-js 5.0.0-beta.7: `deployContract` rejects a `Contract` instance with an error naming neither — **worked-around**

**Symptom.** Passing `compiledContract: new Contract({})` to `deployContract` fails deep inside
transaction construction:

```
Error: Unexpected error: TypeError: Cannot read properties of undefined (reading 'ctor')
  at @midnight-ntwrk/compact-js/dist/esm/effect/internal/compactContext.js:23
  at createUnprovenDeployTxFromVerifierKeys (@midnight-ntwrk/midnight-js-contracts/…:1069)
```

The error names neither the offending argument nor what was expected, and it surfaces several
layers below the call.

**Root cause.** `deployContract` calls `compact-js`'s `createContract`, which reads a hidden
`CompactContext` off `compiledContract[TypeId]` and requires `.ctor` and `.witnesses` on it. The
argument must be built with
`CompiledContract.make(tag, Ctor).pipe(withWitnesses(…) | withVacantWitnesses, withCompiledFileAssets(path))`,
not instantiated directly. `withVacantWitnesses` is the combinator for a contract declaring no
witnesses (`withWitnesses({})` is typed only for contracts that declare some).

**Workaround — fixed-here.** `probes/gate0/src/contract.ts`.

**Intended upstream action.** Issue against `midnight-js` / `compact-js`: `createContract`
should check for a missing context and throw a message naming the parameter and the required
constructor (`compiledContract must be built with CompiledContract.make(...); received a raw
Contract instance`). The type signature should also reject it — `deployContract` accepting
something that fails only at runtime is the underlying problem.

## 8. wallet-sdk 2.0.0-beta.2: `submitTransaction` returns an identifier that is not the indexer's transaction hash — **worked-around**

**Symptom.** The 33-byte value returned by `wallet.submitTransaction()` (e.g.
`000467d1827cb1f5cffc15c0a9f6a0848c09924a089e365bbc8d4cc5cbc18bbc5e`, 66 hex chars) does not
resolve via the indexer's `transactions(offset: { hash: … })` query, either as-is, with the
leading byte stripped, or truncated to 32 bytes. midnight-js's `FinalizedTxData.txHash` from
`deployContract` / `callTx` (64 hex chars) resolves fine through the same query.

**Root cause.** Not established beyond the shape difference: the wallet returns a
`TransactionIdentifier`, which is evidently a different thing from the transaction hash the
indexer keys on. Confirmed only that the two are not interconvertible by truncation.

**Workaround — worked-around.** Use `FinalizedTxData.txHash` for anything that has to be looked
up later (`probes/gate0/tools/tx-sizes.mjs` and the report's evidence tables all key on it). Do
not treat `submitTransaction`'s return value as a transaction hash. Plain transfers made through
`wallet.transferTransaction` therefore have no easily queryable hash — the probe verifies those
by balance delta instead.

**Intended upstream action.** Issue against `midnightntwrk/midnight-wallet`: either rename the
return value so it is not mistaken for a hash, document the relationship to the indexer's hash,
or expose a conversion. A caller that submits a transfer and then wants to inspect it on chain
currently has no supported route.

## 9. wallet-sdk 2.0.0-beta.2: facade `unshielded.balances` misreports around a spend — **worked-around**

**Symptom.** `state().unshielded.balances[unshieldedToken().raw]`, read via a state emission that
already satisfies `dust.progress.isStrictlyComplete() && unshielded.progress.isStrictlyComplete()`,
disagrees with the chain. Measured in the Gate 0 run: immediately before a `stakeIn` of 5,000,000
the facade reported

```
genesis NIGHT before stake = 219,998,990,200,000
```

but the transaction the wallet then built spent a UTXO of `19,998,995,100,000` and returned change
of `19,998,990,100,000` — so the true pre-spend total was `219,998,995,100,000`. The facade was
**4,900,000 low**, and the "after" read was consistent with its own wrong "before", so the
apparent delta was **−100,000** for a 5,000,000 stake. An earlier run of the same code reported
the delta correctly, so it is intermittent rather than a fixed offset.

The same shape appeared in setup: after a 10,000,000,000,000 transfer out of a 250,000,000,000,000
balance the facade reported 200,000,000,000,000 — a whole 50,000,000,000,000 UTXO missing rather
than the transferred amount — presumably the spent input removed while the change output was not
yet credited.

**Root cause.** Not established. `isStrictlyComplete()` on both relevant sync progresses is
evidently **not** sufficient to guarantee the balance aggregate reflects the wallet's own
in-flight or just-settled spends. Most likely the aggregate is recomputed from the UTXO set at a
different point than the sync progress it is published alongside, so a spend can be visible in
one and not the other.

**Workaround — fixed-here.** Never use the facade's aggregate balance as evidence. Gate 0's Q1
findings are all derived from per-transaction UTXO movement read from the indexer
(`probes/gate0/tools/utxo-audit.mjs`): `unshieldedSpentOutputs` minus `unshieldedCreatedOutputs`
per token type, which is exactly what the ledger's own balance check uses. The facade's balance is
kept in the probe only for progress logging, and `docs/gate0-report.md` says so explicitly.

This was nearly a wrong result rather than a bug report: the probe originally reported the staker's
delta from the facade and it looked plausible.

**Intended upstream action.** Issue against `midnightntwrk/midnight-wallet` with both observations:
`FacadeState.unshielded.balances` should either be consistent with the progress markers published
in the same emission, or the docs should state that it is eventually-consistent and must not be
used for accounting. As it stands there is no documented predicate a caller can wait on to get a
balance that is safe to reason about, which makes the field a trap for exactly the use it looks
designed for.

## 10. compactc 0.34.0: `Uint<a..b>` excludes `b`, so `x as Uint<0..1>` throws on every `true` — **open**

**Symptom.** A `Boolean`-to-0/1 cast written the obvious way aborts at run time, 100% of the
time, on a value that is trivially in range:

```compact
pure circuit flag(x: Boolean): Uint<0..1> { return x as Uint<0..1>; }
```

```
CompactError: scoring-core.compact line 82 char 10:
  cast from Field or Uint value to smaller Uint value failed: 1 is greater than 0
```

"1 is greater than 0" for a cast whose declared target is `Uint<0..1>`. Nothing rejects it
earlier: `compact compile`, `compact compile --skip-zk`, full ZK key generation and
`compact format` all accept the source without a word. There is no diagnostic, no warning, and
the generated `.zkir` is well-formed — the defect surfaces only when a circuit is executed.

**Root cause.** In this compiler the range spelling `Uint<a..b>` is **exclusive** of `b`, so
`Uint<0..N>` is `{0 … N−1}` and `Uint<0..1>` is the single-value type `{0}`. The documentation
says the opposite — that `Uint<8>` and `Uint<0..255>` are the same type and the range is
inclusive.

Every observation is consistent with the exclusive reading, and inconsistent with the
documented one. `contract/repro/bug10-uint-range-upper-bound.compact` emits these bound checks
(read them out of the generated `contract/index.js`):

| Target spelling | Documented max | Emitted check | Executes 255/3/1? | Verdict         |
| --------------- | -------------: | ------------- | ----------------- | --------------- |
| `Uint<1>`       |              1 | `t1 > 1n`     | 1 → `1`           | correct         |
| `Uint<0..1>`    |              1 | `t1 > 0n`     | 1 → **throws**    | off by one      |
| `Uint<0..3>`    |              3 | `t1 > 2n`     | 3 → **throws**    | off by one      |
| `Uint<8>`       |            255 | `t1 > 255n`   | 255 → `255`       | correct         |
| `Uint<0..256>`  |            255 | `t1 > 255n`   | 255 → `255`       | **= `Uint<8>`** |

Two independent confirmations that this is the type and not the cast:

- `return 255;` in a circuit declared `Uint<0..255>` **does not compile**:
  `mismatch between actual return type Uint<8> and declared return type Uint<0..255>`. The
  compiler itself does not believe the two are the same type. Declared `Uint<0..256>`, the same
  `return 255;` compiles and returns 255.
- `1 as Uint<0..1>` on a literal — a value the compiler could constant-fold — still emits the
  run-time check and still throws. So the bound is wrong at the type level, not in a
  cast-specific code path, and constant folding does not happen early enough to turn it into a
  compile error where it would at least be visible.

Whether the compiler or the documentation is wrong is upstream's call. The hazard is the same
either way, and it is sharpened by the fact that `Uint<0..1>` is the _natural_ spelling for a
selector in a sum-of-products circuit — the shape bugs-found #1 forces on anyone writing a
multi-way dispatch. Cost here: the whole scoring core was written with it, and only the first
execution of the cross-check test found it.

**Workaround — worked-around.** **Use the bit-width spelling.** `Uint<1>` is correct, and for a
`Boolean` source the cast is recognised as statically safe so no check is emitted at all.
`contract/src/scoring-core.compact`'s `flag` carries a comment saying so, because the wrong
spelling looks more correct. Never write `Uint<a..b>` in this compiler; `Uint<N>` covers every
power-of-two bound, and a non-power-of-two bound is not worth the risk.

A silent bonus: the bogus checks were not free. Removing them cut **64 instructions** from
`takeTurn` (1 868 → 1 804) and 64 from `scoreTurn` (643 → 579) — about 10% of each — because
each one was a real `assert` in the circuit.

**Intended upstream action.** Issue against `LFDT-Minokawa/compact` with the repro, which is
self-contained and reads its own answer out of the generated JavaScript, so it needs no runtime
to demonstrate. Three asks: (1) fix the bound so `Uint<0..N>` includes `N`, or (2) if exclusive
is intended, say so in the documentation and fix the claim that `Uint<8>` is `Uint<0..255>`;
(3) either way, reject a statically-impossible cast (`1 as Uint<0..1>`, `true as Uint<0..1>`) at
compile time instead of emitting a check that can never pass — an unsatisfiable range cast is
always a bug in the source, and the compiler has the information to say so.

## 11. compact-runtime 0.19.0: the simulator does not model a contract's unshielded balance, so every balance guard is untestable — **worked-around**

**Symptom.** `unshieldedBalance(nativeToken())` returns **0** inside a circuit that has just
called `receiveUnshielded(nativeToken(), 500)` in the same call. Not a stale read — the receive
and both reads are three consecutive statements:

```compact
const before = unshieldedBalance(nativeToken()) as Uint<64>;   // 0, correctly
receiveUnshielded(nativeToken(), amt as Uint<128>);
const after  = unshieldedBalance(nativeToken()) as Uint<64>;   // 0, wrongly
```

`probe(500)` returns `[0n, 0n, 0n]` where a ledger that tracked the balance gives
`[0n, 500n, 1n]`; the third element is `unshieldedBalanceGte(nativeToken(), 500)`, which is
likewise **false immediately after receiving 500**. Repro:
`contract/repro/bug11-unshielded-balance-simulator.compact`, which carries the runner snippet.

Nothing reports a problem. `receiveUnshielded` and `sendUnshielded` both _succeed_; they simply
move nothing that any offline read can observe, and a contract can `sendUnshielded` an amount it
never received without the simulator objecting.

**Root cause.** `receiveUnshielded` / `sendUnshielded` lower to `kernel.incUnshieldedInputs` and
`kernel.incUnshieldedOutputs` + `kernel.claimUnshieldedCoinSpend`, and `unshieldedBalance` lowers
to `kernel.balance` (signatures in docs/gate0-report.md, Q1). The first two are _declarations
about the surrounding transaction_ — the real accounting is the ledger's transaction-wide
per-token balance check at admission (`ledger/src/verify.rs:820-888`), which is exactly the part
a local `CircuitContext` does not run. `kernel.balance` is served from a query context that no
in-circuit declaration ever updates, so it stays at its initial 0 for the whole simulated life of
the contract.

So this is arguably "working as specified" at the VM level, and it is still a defect at the tool
level: the same API is offered to a circuit as both an _effect_ and an _observation_, and only the
effect is modelled. Nothing in the type system, the docs or the runtime says the observation is
inert offline.

**Why it matters more than it looks.** The natural way to write a pot is the way
`probes/gate0/src/pot.compact` writes it:

```compact
assert(unshieldedBalanceGte(nativeToken(), total), "payOut: ledger balance too low");
```

That guard is **false for every honest call under the simulator**, so a test suite that exercises
a payout cannot go green while it is present. The only ways forward are to delete the guard or to
skip the tests, and both end with a contract whose custody invariant is first exercised on a real
node. The failure mode is inverted from the usual one: the safety check is what breaks, so the
pressure is to remove it.

**Workaround — worked-around.** `contract/src/table.compact` keeps its own `pot: Uint<64>` ledger
field, asserts against **that** everywhere, and never calls `unshieldedBalance`. Decision 4 in its
header says so and says why. The contract-vs-ledger cross-check does not disappear; it moves to
the E2E devnet run, where it is done from the indexer's per-transaction UTXO movement
(`probes/gate0/tools/utxo-audit.mjs`) rather than in-circuit — which Gate 0 already established is
the only trustworthy measure anyway (§9). `src/test/table.test.ts` names, in a comment on the
`token custody` block, exactly which four properties the simulator cannot check.

Note the residual risk this leaves, since it is the whole point of the entry: **no offline test in
this repo can fail if `receiveUnshielded` or `sendUnshielded` is given the wrong amount, the wrong
colour, or the wrong recipient.** Only devnet can.

**Intended upstream action.** Issue against `midnightntwrk/midnight-js` (compact-runtime). Two
asks, in order of preference: (1) have the simulator maintain a per-token unshielded balance from
the `incUnshieldedInputs` / `incUnshieldedOutputs` declarations it already executes, so
`kernel.balance` answers consistently with them — this is bookkeeping the runtime has all the
inputs for, and it would make custody logic testable offline; (2) failing that, document
prominently that `unshieldedBalance` is inert outside a real transaction, and consider making it
_throw_ under a simulated context rather than returning a plausible 0, since a wrong number that
looks right is worse than an unavailable one.

## 12. compact-runtime 0.19.0: `createCircuitContext` defaults block time to wall-clock, making every time-dependent test non-reproducible — **worked-around**

**Symptom.** A contract using the kernel's block-time predicates behaves differently on every run
and differently on every machine, with nothing in the test naming time as an input.
`createCircuitContext`'s ninth parameter is optional:

```js
const time = maybeTime ?? Math.floor(Date.now() / 1_000); // circuit-context.js:171
```

so a test that omits it silently pins the contract's clock to _now_. A timeout test written
against absolute seconds passes or fails depending on when it is run; one written against
`Date.now()` passes for the wrong reason and stops proving anything.

**Root cause.** The default is a convenience for the common case (a client building a real
transaction, where wall clock is the right guess) applied to an API that is also the only way to
execute a circuit in a test. There is no separate test constructor and no deterministic default.

This compounds with a second gap that is not a defect but shapes any contract with deadlines:
**the kernel exposes block-time PREDICATES and no accessor.** `blockTimeGt`, `blockTimeGte`,
`blockTimeLt` and `blockTimeLte` all exist with signature `(Uint<64>): Boolean` and are strict and
seconds-based (probed against compactc 0.34.0 and confirmed by execution: at block time 1000,
`blockTimeGt(999)` is true and `blockTimeGt(1000)` is false). There is no `blockTime()`, and
`kernel.blockTime` does not exist — `operation blockTime undefined for ledger field type Kernel`.
A contract that must _record_ when something happened therefore cannot read the clock; it has to
be told the time and pin the claim between two predicates. `table.compact`'s `stampTime` does
exactly that, and the pin is only meaningful if tests can set both sides of it — which is what
the default above quietly takes away.

**Workaround — worked-around.** Every simulator in `contract/src/test/simulator.ts` passes `time`
explicitly, defaulting to a fixed `DEFAULT_BLOCK_TIME`; the file header states that nothing in it
may call `createCircuitContext` without a time. `TableSimulator`'s mutating methods take the
declared `now` and the block time as **separate** arguments that default to being equal, so the
honest case is the easy one and the dishonest case — a caller lying about the clock — is
expressible. That is what `describe('the declared-time sandwich')` in `src/test/table.test.ts`
tests, on both sides of each boundary.

**Intended upstream action.** Issue against `midnightntwrk/midnight-js` (compact-runtime). Ask
that `time` be required, or that a `createTestCircuitContext` with a fixed default exist, or at
minimum that the JSDoc on `createCircuitContext` say the parameter defaults to wall clock and that
omitting it makes block-time-dependent execution non-reproducible. The parameter is currently
documented as "The current time. Used to execute the block time related kernel operations", which
does not hint that leaving it out is a correctness hazard in a test.

## 13. compactc 0.34.0 / proof-server 9.0.0-rc.5: a circuit's PLONK domain is never reported, so provability cannot be checked before proving — **worked-around**

**Symptom.** A contract compiles cleanly, generates prover and verifier keys, deploys
successfully, and is then **unprovable**. Every `/prove` hangs for ~366 s and fails with a
generic `BadInput`. Nothing between writing the circuit and losing six minutes to a hang tells
you which PLONK domain size the circuit needs, and §4's failure mode gives you no hint either —
the proof server's log names the missing degree only after it has finished retrying a download
that was never going to work.

This is §4 seen from the other end. §4 says "some SRS degrees are missing". This entry is that
**you cannot tell whether your circuit is one of them** until you try.

**Root cause.** `k` is a property of the compiled ZKIR and the compiler knows it, but it is
surfaced nowhere in the toolchain's output:

- `compact compile` prints only `Compiling N circuits:`.
- `<managed>/compiler/contract-info.json` carries every circuit's full type signature and no `k`.
- `<managed>/compiler/contract-manifest.json` carries sizes and hashes of the artifacts and no
  `k`.
- **Prover key size cannot be used as a proxy**, which is the trap, because it looks like one.
  It is a step function of the domain plus a constant that depends on the gate set, so it is not
  monotonic in circuit size and it is not comparable across circuits: in this project `settle`
  (1,584 instructions) had a prover key 1.5 MB **larger** than `claimTimeout` (1,608
  instructions), and `join` at 5,211,067 B and `abortTable` at 2,140,815 B were k=14 and k=13
  respectively — a 2.4× size ratio for one step.

There is exactly one accessor, and it is undocumented: `@midnight-ntwrk/zkir-v2` exports a
`Zkir` class whose `fromJson(json).getK()` reads the domain straight out of
`<managed>/zkir/<circuit>.zkir`. The package is a transitive dependency of the proof provider,
its entire `.d.ts` is 33 lines, and it appears in no guide. `--skip-zk` compilation is enough to
produce the ZKIR, so the check costs seconds.

**Impact here.** This was the E2E run's go/no-go. `table.compact`'s `resolveTurn` needed **k=17**
against a proof-server ceiling of **k=15**; the contract as designed could never have produced a
single transaction, and would have failed as a six-minute hang on the first turn of a
twenty-minute run. Reading `getK()` off the ZKIR answered it offline in about a second, before
anything was deployed, and turned "the demo silently doesn't work" into a design change made in
advance.

**Workaround — worked-around.** `cli/tools/circuit-k.mjs` (`npm run k -w cli`) reports every
circuit's `k` against the SRS degrees the proof-server image actually bundles, and exits non-zero
if any is out of range. The bundled set has to be enumerated by `docker export <container> | tar
-t` — the image is distroless, so there is no shell to ask and no endpoint that reports it.

**Intended upstream action.** Three separate issues, in decreasing order of value:

1. `midnightntwrk/compact` — have `compact compile` print `k` per circuit, and record it in
   `contract-info.json`. The compiler already computes it; not emitting it is the whole defect.
2. `midnightntwrk/proof-server` — expose the bundled SRS degrees on an endpoint (`GET /params`),
   and **fail fast** with a message naming `k` when a circuit needs one that is absent, instead
   of retrying an unreachable host for six minutes and returning `BadInput`.
3. `midnightntwrk/artifacts` — document `zkir-v2`'s `Zkir.getK()`, which is currently the only
   way any project can answer "will this deploy be usable?" ahead of time.

## 14. compactc 0.34.0: an exported circuit's array argument costs two public inputs per word and can dominate the proving domain — **fixed-here**

**Symptom.** Five circuits that do very different amounts of work all landed on exactly the same
PLONK domain, k=15, and their prover keys clustered at 8.5–10 MB regardless of what they
computed. `claimTimeout`, which forfeits a seat and writes three ledger fields, needed the same
domain as `join`, which hashes twice and takes custody of a token. Replacing one argument with a
compile-time constant — changing nothing the contract does and nothing about the resulting
transaction's size — moved them to k=11..14 and their keys to 0.58–5.2 MB.

Measured on the same contract, same 2 KB of padding, same behaviour:

| circuit            | padding as a `Vector<64, Bytes<32>>` argument | padding as a `pad(2048, …)` constant |
| ------------------ | --------------------------------------------: | -----------------------------------: |
| `claimTimeout`     |                             k=15, 8,458,853 B |                  **k=11, 575,520 B** |
| `abortTable`       |                             k=15, 8,458,463 B |                **k=12, 1,079,285 B** |
| `settle`           |                             k=15, 9,948,285 B |                **k=13, 2,824,864 B** |
| `join`             |                             k=15, 9,960,155 B |                **k=14, 5,209,319 B** |
| `takeTurn`         |                             k=15, 9,967,349 B |                **k=14, 5,215,077 B** |
| `resolveRoll1/2/3` |                         k=16 — **unprovable** |                  **k=15 — provable** |

A factor of fifteen on `claimTimeout`'s prover key, and on the resolve circuits the difference
between a contract that can be deployed and one that cannot.

**Root cause.** An exported circuit's parameters are **public inputs** to the proof. A
`Vector<64, Bytes<32>>` is 128 field elements after alignment — measured at exactly 2 public
inputs and 5 instructions per 32-byte word, flat across every circuit — and PLONK's domain has to
cover the public-input region, so on a small circuit the argument alone sets the domain. A
compile-time constant is folded into the ledger operation as a literal `StateValue` push and is
never an input at all.

Nothing here is wrong, exactly. It is a cost model that is invisible from the source: the two
versions of `padTransaction` differ by one word and look equally inert, and the expensive one is
the one the natural reading of "padding" suggests.

**Why it mattered.** This padding exists to work around §3 — a contract call must exceed ~7,984
bytes or the node refuses it — and §3's own workaround, from Gate 0, was argument-shaped. So the
two ledger constraints were being pushed against each other unnecessarily: the argument form
spent PLONK steps to buy transaction bytes, when the constant form buys the same bytes for free.
With the argument, the only padding width that kept the resolve circuits provable was 16 words
(512 B), which does not clear the admission floor — i.e. the contract had **no** feasible
configuration. With the constant, both bounds are satisfied with room to spare.

**Fix — fixed-here.** `table.compact` and `lobby.compact` take no padding argument at all;
`padTransaction()` writes `pad(2048, "yahtzee:v1:pad")` to a `Bytes<2048>` ledger cell after
`kernel.checkpoint()`. Documented as decision 8 in `table.compact`, with the measurements above.

**Intended upstream action.** Documentation issue against `midnightntwrk/compact`: state
explicitly that exported-circuit parameters are public inputs and that their **width** feeds the
proving domain, with the per-word figure. Ideally the compiler would also warn when public inputs
dominate a circuit's domain — it is the one cost that is entirely invisible in the source and
entirely avoidable.

## 15. node 2.0.0-rc.4 / ledger 9.1: a devnet can stop accepting every fee-paying transaction, permanently, reporting only client error 170 — **open**

**Symptom.** A devnet that had been serving a live game for five hours stopped including
transactions entirely. From block **3116** (2026-09-01 18:36:00 UTC) to the end of the session —
170+ blocks, ~17 minutes, verified by querying every block in the range through the indexer — the
chain contained **zero** transactions. Blocks continued to be produced on schedule.

Every submission after that point failed, from every wallet, regardless of what it was:

| Attempt                                  | Wallet             | Result                      |
| ---------------------------------------- | ------------------ | --------------------------- |
| contract deploy (15,462 B), x6           | genesis            | `1010: … Custom error: 170` |
| contract deploy, x6 (fresh process each) | fresh probe wallet | `1010: … Custom error: 170` |
| plain 1-NIGHT transfer                   | genesis            | `1010: … Custom error: 170` |
| plain 1-NIGHT transfer                   | fresh probe wallet | `1010: … Custom error: 170` |

The same genesis wallet had completed a transfer of the same shape **20 minutes earlier**, and
the same probe wallet had been funded and DUST-registered successfully at 18:35–18:36 — those
four transactions are the last four the chain ever accepted. The node log gives §6's message
every time:

```
Transaction malformed: dust spend proof failed to verify; this is just as likely a disagreement
on dust state on the declared time (Timestamp(1788288738)) as the proof being invalid: DustSpend { … }
Rejected transaction … : Transaction Error: Malformed(InvalidDustSpendProof)
```

The wallet was not short of DUST: the rejected deploy declared `v_fee: 6853510813656816`
(~6.9e15) against a wallet balance of 7.9e19, four orders of magnitude of headroom, and the
balance was growing throughout.

**Root cause.** Not established. This is the third distinct condition behind client error 170
(§0 #8/#22 lists the ledger-tag mismatch and the single-wallet spend race; §6 documents the
1-in-3 transient) and the only one that is **absorbing** — nothing clears it. The correlation
available is that it began immediately after two large NIGHT UTXOs were newly registered for DUST
generation on a chain that had also been under a sustained retry load: a client was re-submitting
into it at ~6 rejections per 35 s throughout. Whether either is causal or both are coincident
with something else is untested.

**Why it is worse than §6.** §6's transient is recoverable by retrying; this is not, and the two
are indistinguishable from the client, which sees the identical `1010: … Custom error: 170` in
both cases. Six retries with 12 s backoff, then across fresh processes, then from a different
wallet, all failed identically. A retry loop written against §6 will therefore spin forever
against this, and the operator gets no signal that the chain — rather than the transaction — is
what is broken.

**Second occurrence (2026-09-02, different chain, sharper correlation).** A fresh devnet wedged
identically ~3.5 h after genesis. The last transaction the chain ever accepted (block **2289**,
01:34:18 UTC, `010060c3…`) was a **fee-less DUST registration** submitted from the Moth browser
wallet — a self-send of a single 1,000,000-NIGHT UTXO whose only dust event is one
`DustInitialUtxo`, no `DustSpendProcessed`. The first rejection followed within 90 seconds
(01:35:46), and from then on every dust spend from every wallet failed — four Moth join attempts
and, decisively, a plain funding transfer from the **genesis wallet via the CLI stack whose
identical transfer had landed at 01:17** (`cli/src/probe-join.ts` is the probe that isolated
this). Both occurrences now share the same shape: a DUST registration lands, and the chain stops
reconciling anyone's dust state within a minute or two. Registration is not sufficient on its
own — the E2E runs register small wallets routinely — but two-for-two it is the immediately
preceding write, both times involving large newly-registered UTXOs. Practical guidance until
fixed upstream: **do not use Moth's manual "register for DUST" action on a devnet this project
owns** — funding transfers already auto-create `DustInitialUtxo` for their outputs (proven: the
Moth wallet paid a fee at 01:33 having never registered), so manual registration is unnecessary
risk.

**Third occurrence (2026-09-02, reproduced on demand — and the size theory killed).** On another
fresh chain, `cli/src/probe-join.ts` funded a fresh wallet with **300,000 NIGHT** and registered
it through this repo's own `prepare` path (no Moth anywhere). The registration landed, the wallet
computed a healthy DUST balance — and its very next spend, and **every other wallet's** including
genesis, failed `InvalidDustSpendProof` from that moment. Yet on the next fresh chain the same
code registering **10,000,000 NIGHT** (E2E's exact `PLAYER_FUNDING`) worked twice in a row, each
proven by a post-registration spend (`cli/src/mint-moth-wallet.ts`). So the trigger is a DUST
registration, wallet implementation is irrelevant, and UTXO size is not monotonic — 10M is fine
while 300k and 1M have each killed a chain. The remaining suspects are timing-shaped (chain age,
proximity of the registration to other dust events, or the registration fee's projected-dust
margin, which is far thinner on smaller UTXOs). Operational rule used by this project since:
fund and register wallets **CLI-side at 10,000,000 NIGHT via `mint-moth-wallet.ts`, prove a
spend, and import the seed into the browser wallet** — never register from the wallet UI, and
treat any first-spend-after-registration failure as a wedged chain (wipe, do not retry).

**Fourth occurrence (2026-09-02 15:52, and the size theory is dead).** A chain that had been
healthy for ~90 minutes wedged the moment a **10,000,000-NIGHT** registration landed — the same
size as every previously successful registration. The distinguishing variable this time: the
UTXO had been funded **39 minutes earlier** (by a provisioning run that hung between funding and
registering). Every registration known to have succeeded on this stack registered its coin
within seconds of the funding transfer; the failures now include 300k/22s, 1M/~60s and
10M/39min, so neither size nor delay alone explains it — but "fund, then register immediately"
remains the only pattern with zero failures, and this project's provisioning now does exactly
that (service/src/chain.ts `provisionLane` registers as soon as the funding is visible).

**Fifth occurrence (2026-09-02 21:08, probe chain — the recipe sharpens).** A wallet funded
with 10,000,000 NIGHT whose registration landed **~35 minutes later** (the provisioning run was
killed in between) wedged the chain within seconds of the registration, identically to the
fourth occurrence's 39-minute gap. The tally across every occurrence with known parameters:
registrations of a 10M-NIGHT coin submitted immediately (seconds) after the funding transfer
have succeeded every time (~10 runs); every deviation observed — 300k/22s, 1M/~60s, 10M/39min,
10M/35min — wedged its chain. The operational recipe is therefore exactly: **fund 10M, register
the moment the coin is visible, and treat a provisioning flow that was interrupted between the
two steps as radioactive — top up if needed and expect the registration to kill the chain.**
Self-healing provisioning that re-verifies balances on a cache hit (probes/concurrency
`ensureActor`, service `provisionLane`) narrows the window but cannot remove the underlying
defect.

**Sixth occurrence (2026-09-03 17:38, probe chain — the recipe is NOT sufficient, and a new
variable appears).** The probe chain from the fifth occurrence had run a full fast-turn E2E the
evening before (genesis + two players funded 10M and registered within seconds — fine). The
host then REBOOTED overnight; the node container came back on its persisted state and kept
producing blocks. This afternoon two more players were provisioned exactly by the recipe (10M
each, registration submitted within seconds of the coin being visible, both registrations landed
at 17:36:43 and 17:37:25), and the very next genesis spend — a lobby deploy at 17:38:02 — hit 170
on every attempt, still 170 from a fresh wallet instance at 17:48. Blocks kept coming. So either
(a) the recipe merely lowers the odds rather than removing them, or (b) a node restart on
persisted state is itself a trigger. **The main chain then answered (b):** it had survived the
same reboot with NO registration afterwards — the operator daemon restarted and only READ state
for four hours — and its first spend since the reboot (a table deploy from genesis at 17:51) hit
170 twelve times straight, with every recent block empty. Two chains, one reboot, one of them
with no DUST registration in the window: **a node restart on persisted state wedges the chain's
fee-paying transactions on this build.** (Whether registrations are an independent trigger or
were incidental all along is now the open question; occurrences 1–5 each also had a chain that
had been running a while.) Practical consequence: after any host reboot, assume both devnets are
dead and restart them from genesis before anything else — a `docker compose up` that reports the
old chain height is not a recovery.

**Diagnosis from a source-level investigation of midnight-node / midnight-ledger (2026-09-03,
by a separate agent working in the node repo; inference, repro written but not yet run).** The
wallet's `DustLocalState::spend` proves against the roots of its LIVE Merkle trees while the node
verifies against `root_history.get(ctime)` — the root as of the DECLARED time, exact-or-
predecessor, written once per block. Nothing couples the two (upstream has a `TODO: Fixme` on
exactly this). So a spend is valid only if `ctime` falls in `[t_block_N, t_block_N + 12)` for the
last block the wallet applied; a ctime one second earlier resolves to the previous block's root
and fails as "InvalidDustSpendProof". While the shared trees are static every root is identical
and any ctime works — which is why a chain plays fine for hours; a DUST registration inserts into
both shared trees and arms the mismatch for EVERY wallet, matching occurrences 1–5. Each rejected
retry also parks the UTXO (`pending_until = ctime + 3h`) before the tx is accepted, so retries
make it worse. A second, independent defect: ledger rc.3 backdates a registration's DUST to the
author-declared ctime (rc.4's one changelog entry fixes it: "dust registration accounting moved to
block time"), which is the fund→register-delay correlation — and a DUST-inflation hole. rc.4 also
adds nonce asserts to the spend circuit; its verifier key differs, so node and wallet must move
together. **Next step for this repo: pin ledger rc.4 (atomic node image + WASM bump).** The
sixth occurrence (a reboot, no registration) is a data point the diagnosis must still absorb —
either `root_history` does not survive a restart, or the wallets' post-restart ctime lags.

**Seventh data point (2026-09-04 09:00, main chain — the restart hypothesis narrowed).** The
host rebooted again overnight. The node container was brought back on its persisted state
(height 5032) and, TWO MINUTES later, genesis funded a wallet, that wallet registered and proved
a spend — all accepted. Same image, same chain, same restart shape as the sixth occurrence,
where the first spend came FOUR HOURS after the restart and every one was rejected. So a restart
on persisted state does not wedge a chain by itself; a restart followed by a long dormancy does.
That fits the source-level diagnosis two paragraphs down better than (b) did: the root snapshot
the node checks a spend against is looked up by the DECLARED time in a history that is pruned to
an hour, and the wallet's declared time comes from a view that a long-idle node's history no
longer covers — the window between "chain restarted" and "chain is dead to fee-payers" is the
retention window, not the restart. Operational rule stands: after a reboot, write to the chain
promptly; if it has sat idle for over an hour, treat it as wedged and start fresh.

**The rc.4 pin, attempted 2026-09-03 — BLOCKED upstream.** The pairing that exists: node
`2.1.0-beta.1` (release notes: ledger 9.1.0.0-rc.4), `@midnightntwrk/ledger-v9@1.0.0-rc.4` on npm
(forced through the SDK's twelve exact rc.3 pins with a root `overrides` entry and a clean
reinstall), proof-server `9.0.0-rc.6` (built in the ledger rc.4 release). Typecheck and all 187
contract + 70 service tests pass on the rc.4 WASM. But there is **no indexer built against ledger
rc.4**: `indexer-standalone` `4.4.0-rc.2` and `4.4.0-rc.3` BOTH lock
`crate-ledger-9.1.0.0-rc.3` in Cargo.lock, and the rc.3 image is not on Docker Hub anyway (its
release says "images published"; the tag 404s; GHCR denies). Executed result on a fresh probe
chain (node 2.1.0-beta.1 + indexer 4.4.0-rc.2 + proof-server rc.6 + WASM rc.4): the proof server
answered every `/prove` in ~0.37 s and the node rejected **every** dust spend from the very
first one, `InvalidDustSpendProof`, ten attempts over 2.5 minutes (the rc.3 fresh-chain
transient clears in one to two). The wallet SDK takes its dust state from the indexer
(`dustState` queries), so its Merkle tree is computed with rc.3 accounting — registration valued
at the declared ctime — while the node's is rc.4's block-time accounting: different generation
leaves, different root, every proof "invalid". That is also the mechanism behind the old README
warning that "newer node images reject every fee-paying tx". **Pin reverted to the rc.3 pairing;
re-attempt the moment an indexer tagged for ledger rc.4 is published** (the indexer's
`Cargo.lock` `midnight-ledger-v9` source tag is the thing to check, not the release notes).

**Workaround — worked-around.** Only a fresh chain clears it, which §0 #8/#22 already said and
this confirms with a clean before/after: an identical deploy from an identical wallet succeeded
on the **first attempt** on a newly started node with the same image and the same code.

Because tearing down the wedged stack would have destroyed the live game running on it,
`probes/concurrency/docker-compose.yml` instead brings up a second, isolated stack on host
ports offset by 10 (9954 / 8098 / 6310). Any probe that must be able to trust its own results
should default to a chain it owns; that probe's `src/config.ts` does, rather than making it an
opt-in flag, since a wedged chain otherwise renders as a result.

**Detection.** Cheaper than reading the node log: ask the indexer whether any block in the recent
range contains a transaction.

```graphql
{
  block(offset: { height: N }) {
    height
    transactions {
      hash
    }
  }
}
```

A run of empty blocks spanning several minutes on a chain that is being written to means the
chain is wedged, not that the transaction is malformed.

**Intended upstream action.** Issue against `midnightntwrk/midnight-node` / `midnight-ledger`
with the block range and the log excerpt: (a) `InvalidDustSpendProof` needs to distinguish "this
proof is wrong" from "the node's dust state cannot be reconciled with any client's", because as
it stands one error code covers a retryable race, a configuration mismatch and an unrecoverable
chain state; (b) a node whose dust state has diverged such that no wallet can pay a fee should
say so once at the node level rather than only per-rejected-transaction. Supersedes nothing —
§6's transient is real and separate.

## 16. node 2.0.0-rc.4: a contract's deploy ceiling is ~19-21 KB of verifier key, and the error names nothing — **worked-around**

**Symptom.** A contract that compiles cleanly, whose every circuit is provable (`npm run k -w
cli` all green, k in 13..15), and whose constructor is a few hundred bytes of state, cannot be
deployed. Every attempt is refused before it reaches a block:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

The node's own log shows the transaction being _validated for the mempool_ and then simply never
included — blocks continue at `extrinsics_count: 4` with `end: NoMoreTransactions`. Nothing
mentions verifier keys, contract size, or which limit was hit. The client sees only the string
above, from `submitAndWatchExtrinsic`.

Hit while adding two exported circuits to `table.compact` (8 -> 10). Cost: a demo run that
generated three wallets, funded two, waited out two DUST registrations and deployed a lobby
before failing on the table.

**Root cause.** A deploy carries **one verifier key per exported circuit** as part of the
contract's initial state. Measured by deploying real contracts and nothing else, on the same
node, same wallet, same session:

| exported circuits | verifier-key bytes | deploy                     |
| ----------------: | -----------------: | -------------------------- |
|                 8 |             15,416 | lands                      |
|                 9 |             19,071 | lands                      |
|                10 |             21,190 | **refused, every attempt** |

So the ceiling is between 19,071 and 21,190 bytes of verifier key. Reducing the constructor's
own work — moving eighteen `Map.insert`s out of it, including six 27-field scorecards — changed
nothing, which is what identifies the keys rather than the state as the driver.

**The sharp edge: it is bytes, and verifier-key size is a step function of `k`.** A verifier key
is **1,351 bytes at k <= 12** and **2,119 bytes at k >= 13**. So this limit is in direct tension
with §3's admission floor, which pushes small circuits UP to k >= 13:

|           | §3 admission floor           | this ceiling                  |
| --------- | ---------------------------- | ----------------------------- |
| `k <= 12` | risks `OutsideTimeToDismiss` | small key, deploy-friendly    |
| `k >= 13` | safe                         | 2,119 B of deploy budget each |

The previous revision of this contract fitted eight circuits partly _because_ two of them sat at
k=11 and k=12 with small keys — and the k=11 one is exactly what §3 recorded failing admission
1,610 times. A contract must choose which limit to pay; there is no free setting of `k`.

**Worse, the widely-repeated figure was wrong.** "A deploy ceiling of ~11-12 circuits" appears
throughout this project's earlier docs and was inherited from a neighbouring project without
ever being tested. Anyone budgeting circuits against it is over by two to three.

**Workaround — worked-around.** Keep every circuit at k >= 13 (so nothing is refused at
admission) and cap the contract at **nine** exported circuits, merging behaviour behind `kind`
discriminators instead of adding entry points. `table.compact` merges three player moves into
`playerMove` and two rerolls into `resolveReroll` for exactly this reason.

`cli/src/deploy-probe.ts` (`npm run deploy-probe -w cli`) answers "does this contract deploy?"
in about forty seconds, from the genesis wallet, with no game setup. It belongs next to
`npm run k -w cli` in any pre-flight: `k` answers whether each circuit can be _proved_, this
answers whether the contract can be _deployed_, and neither implies the other.

**Intended upstream action.** Issue against `midnightntwrk/midnight-node` /
`midnight-ledger`. Three asks: (1) the rejection should name the limit and the measured value —
"contract state of N bytes exceeds the per-transaction limit of M" — rather than a generic
`ExhaustsResources`, which is indistinguishable from a fee problem; (2) document the limit and
its relationship to verifier-key size, so a contract's circuit budget is knowable before it is
written; (3) ideally, let a large contract's verifier keys be deployed incrementally, since the
current shape makes the maximum useful contract size a function of how many circuits happen to
need k >= 13. Also worth filing against `midnight-js`: the SDK can measure the deploy's size
locally and refuse with a diagnosis, exactly as §3 asks for calls.

## 17. midnight-js 5.0.0-beta.7 / node 2.0.0-rc.4: two ADJACENT calls to the same entry point in one scoped transaction build an invalid transcript — **worked-around**

**Symptom.** `withContractScopedTransaction` with two consecutive calls to the SAME circuit
(same contract, same entry point, different arguments) submits a transaction the node rejects
with `1010: Invalid Transaction: Custom error: 104` — `TransactionInvalid(Transcript)`, "the
transaction transcript is invalid". Deterministic: measured twice on a fresh ledger-9.1 devnet
(probes/concurrency, `npm run compose`, experiment 2 — two `bumpShared` calls with distinct
random nonce arguments).

**What it is NOT.** Not a ledger prohibition on repeated entry points, and not a limit on
same-contract composition: the very next experiment composes `bumpShared`, `setCell`,
`bumpShared` — the same entry point twice, NON-adjacent — into one transaction that is
**accepted**, with the read-modify-write chain threading through all three calls (`touches`
+2 in one tx, three contract actions per the indexer; txs `1be46a4f…` block 44 and
`e57d20e6…` block 64 on the probe chain). Sequential same-contract composition per se is
CONFIRMED on the ledger-9.1 line, matching the `apply_actions` running-accumulator reading of
the ledger source.

**Root cause.** Not established; the shape of the evidence points at the SDK's scope builder
rather than the node: the accumulated call data inside `TransactionContextImpl` appears keyed
or cached in a way that mis-threads a call whose `(address, entryPoint)` equals its immediate
predecessor's, emitting a transcript the node correctly rejects. The node's own uniqueness
check keys on `(address, entry_point, communication_commitment)` and did not fire here.

**Workaround.** Order composed calls so no two adjacent ones share an entry point. The
fast-turn settlement (docs/fast-turn-design.md) alternates player and operator circuits
(`resolveRoll1, playerMove, resolveReroll, playerMove, resolveReroll, playerMove`) and never
hits the pattern. Where an adjacent pair is unavoidable, split into two transactions.

**Detection.** Client sees the generic `Transaction submission error`; only the node log (or
the RPC error detail) carries `Custom error: 104`.

**Intended upstream action.** Issue against `midnight-js`: minimal repro is two consecutive
same-circuit calls in one `withContractScopedTransaction` scope; expected either a working
transaction or a client-side error naming the limitation, not a node rejection of an
SDK-built transcript.

## 18. midnight-js 5.0.0-beta.7: every call transaction gets a RANDOM segment id, so multi-call composition executes in random order — **worked-around**

**Symptom.** Multi-call transactions built by the SDK — `withContractScopedTransaction`, or
manual `Transaction.merge` of single-call transactions — succeed or fail **at random** when the
calls are order-dependent. The same code produced two successes on one chain and three
rejections on the next (`Transcript(Execution(ReadMismatch))`, or error 104 via the scoped
path). Order-independent compositions (blind writes) always land, which is what makes the
nondeterminism look like anything but what it is.

**Root cause, found in source and confirmed by execution.** `createUnprovenLedgerCallTx`
(midnight-js-contracts) assembles every call transaction with `Transaction.fromPartsRandomized`
— documented as "randomizing the segment ID to better allow merging". A transaction's intents
execute in **ascending segment order**, so a merged transaction's cross-call state threading
holds or breaks by lottery over random segment ids in 1..65535. The two "successes" recorded
under the ledger-9.1 composition probe's first runs were lucky draws.

**Workaround — worked-around, and it is fully load-bearing for the fast turn.** Re-key each
part's single intent to an explicit segment before merging:

```ts
const tx = part.private.unprovenTx; // one intent per single-call tx
const [, intent] = [...tx.intents.entries()][0];
tx.intents = new Map([[desiredSegment, intent]]);
```

Probed on ledger-9.1 (probes/concurrency `npm run compose2`, experiments 7/8): with explicit
segments 1 and 2, a cross-party read-modify-write chain — alice's call built against live
state, bob's built against the PREDICTED post-alice state, merged, bob balancing and paying —
landed **3 of 3 times** (txs `8d8080b1…`, `23b3c1df…`, `5558f70c…`); with the segments
reversed it was rejected deterministically. Ordering is entirely the assembler's once segments
are explicit.

**Relation to #17.** The random ordering explains the nondeterminism observed there and in
every order-dependent composition since. Whether ADJACENT identical entry points additionally
carry a distinct defect (error 104, `TransactionInvalid(Transcript)`, rather than the plain
ReadMismatch seen for wrong-order distinct calls) remains open; explicit segmenting sidesteps
both.

**Intended upstream action.** Issue against `midnight-js`: `withContractScopedTransaction`
composes order-dependent calls whose execution order it does not control, so the feature's
output is randomly invalid; either thread scoped calls into ONE intent's ordered action array,
assign ascending segments explicitly, or expose the `SegmentSpecifier` the ledger already
defines (`{ tag: 'specific', value: n }`) through the call-transaction APIs.

## 26. Operational: the operator loads ZK artifacts LAZILY from `contract/src/managed` — compiling in-tree while it runs breaks live play — **worked around**

**Observed 2026-09-04.** A player opening a fast turn got
`ZKArtifactNotFoundError: No ZK artifact bundle matches the deployed verifier key … circuit
'resolveRoll1'` from the operator. Cause: a contract for an unrelated feature had just been
compiled in the SAME checkout; `compact compile` rewrote `contract/src/managed/table`, and the
daemon's providers (`createProviders(ctx, MANAGED_TABLE)`) read prover keys, verifier keys and
zkir from that directory on every call rather than at startup. The daemon kept running with a
build fingerprint the on-disk artifacts no longer matched. `contract/src/managed` is generated
and untracked, so the deployed build had to be regenerated by stashing the new source and
recompiling HEAD (compactc is deterministic: the fingerprint came back identical,
`a325f2ac3b21`).

**Rule.** Never compile contracts in a checkout whose `service/` is driving live tables. Do
feature work in a git worktree (`git worktree add ../yahtzee-<feature>`) with its own
`node_modules`, and only recompile in the live tree as part of a deliberate redeploy. A stronger
fix — the daemon loading artifacts once at startup and pinning them in memory — is worth doing;
not done yet.

## 27. Operational: the build fingerprint covers verifier keys only — constructor-only changes do not retire tables — **worked around**

**Observed 2026-09-04.** A build that changed only `timeoutSlackFactor()` (a constructor floor)
and added a per-tier fast round length produced the SAME fingerprint as the build before it, so
the daemon kept the existing lobby and tables and a rollout script that waited for a "new lobby"
line waited forever. Correct, in fact: the nine circuits' verifier keys — the only thing a
deployed table pins — were unchanged, and those tables remained playable. But the tables carried
the OLD sealed parameters (a 600 s fast round), which a redeploy would have replaced.

**Rule.** For a change to SEALED parameters (round lengths, early-start wait) without a circuit
change, rolling it onto the board is a manual step: stop the daemon, clear the affected tiers'
lobby slots (`lobbyTableFilled` with the operator wallet), mark those table records `retired` in
`service/.state/operator-state.json`, restart — the daemon re-opens them with the new values.
Only empty tables should be retired this way; a table with stakes is left to finish.
