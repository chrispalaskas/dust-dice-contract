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
