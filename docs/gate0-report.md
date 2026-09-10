# Gate 0 report

Answers to the two blocking questions for the staked-NIGHT Dust Dice design, from **executed**
probes on the local devnet. Every number below was produced by a transaction that landed in a
block; nothing here rests on compilation alone.

Probe code and re-run instructions: [`../probes/gate0/`](../probes/gate0/README.md).

## Environment

| Component          | Version / endpoint                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| midnight-node      | `2.0.0-rc.4` (vendors ledger `9.1.0.0-rc.3`), `ws://127.0.0.1:9954`                               |
| indexer-standalone | `4.4.0-pre-alpha.16-l91r3-n2r3-…`, `http://127.0.0.1:8098/api/v4/graphql`                         |
| proof-server       | `9.0.0-rc.5_experimental`, `http://127.0.0.1:6310`                                                |
| Compact            | CLI `0.5.1`, compactc `0.34.0`, language `0.26.0`                                                 |
| SDK                | `@midnight-ntwrk/midnight-js-* 5.0.0-beta.7`, `wallet-sdk 2.0.0-beta.2`, `compact-runtime 0.19.0` |
| networkId          | `undeployed`                                                                                      |

Probe contract: `03ea73862c271c112c243ac29bd820279ae6f3f97e8bf33cf0aeabf9b4e5e4f2`

---

## Q1 — Native unshielded NIGHT custody: **PROVEN**

A Compact contract **can** take custody of native unshielded NIGHT and pay it out to two
distinct user addresses in one circuit call. This was executed end to end, with two separate
wallets staking into one contract-held pot and the pot drained to a winner and a rake recipient.

### The API

`nativeToken()` is not a special case. The unshielded-token stdlib is generic over a
`Bytes<32>` colour, and the native colour is simply 32 zero bytes.

| Function                                     | Signature                                                                                              | Lowers to                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `nativeToken`                                | `(): Bytes<32>`                                                                                        | `pad(32, "")` — 32 zero bytes                                     |
| `receiveUnshielded`                          | `(color: Bytes<32>, amount: Uint<128>): []`                                                            | `kernel.incUnshieldedInputs`                                      |
| `sendUnshielded`                             | `(color: Bytes<32>, amount: Uint<128>, recipient: Either<ContractAddress, UserAddress>): []`           | `kernel.incUnshieldedOutputs` + `kernel.claimUnshieldedCoinSpend` |
| `unshieldedBalance`                          | `(color: Bytes<32>): Uint<128>`                                                                        | `kernel.balance`                                                  |
| `unshieldedBalanceLt` / `Lte` / `Gt` / `Gte` | `(color: Bytes<32>, amount: Uint<128>): Boolean`                                                       | comparison on `kernel.balance`                                    |
| `mintUnshieldedToken`                        | `(domainSep: Bytes<32>, amount: Uint<64>, recipient: Either<ContractAddress, UserAddress>): Bytes<32>` | `kernel.mintUnshielded` + claim                                   |
| `tokenType`                                  | `(domainSep: Bytes<32>, contract: ContractAddress): Bytes<32>`                                         | `persistentCommit(…, "midnight:derive_token")`                    |

**Do not exist** at language 0.26.0 (confirmed absent, not merely unfound): `unshieldedToken`,
`ownAddress`, `ownUnshieldedAddress`, and `claimUnshieldedCoinSpend` as a stdlib circuit (it is
a `Kernel` native, `kernel.claimUnshieldedCoinSpend`).

Sources: signatures read out of compactc 0.34.0 by triggering arity errors
(`probes/gate0/discovery/sig.sh` — the stdlib is embedded in the `compactc.bin` Chez boot image,
so `strings` yields nothing), cross-checked against `LFDT-Minokawa/compact` @ `compactc-v0.34.0`
`compiler/standard-library.compact:90-349`. `nativeToken()`'s value is byte-identical to the
ledger's `pub const NIGHT: UnshieldedTokenType = UnshieldedTokenType(HashOutput([0u8; 32]))`
(`midnight-ledger` @ `ledger-9.1.0.0-rc.3`, `coin-structure/src/coin.rs:556`).

### Semantics that matter for the design

**`receiveUnshielded` does not name a payer.** It declares "this contract's balance of `color`
rises by `amount`". The ledger then enforces a transaction-wide per-token-type balance
(`ledger/src/verify.rs:820-888`), which forces the surrounding transaction to supply a matching
real unshielded input. So a contract cannot pull funds from an arbitrary caller — the caller's
wallet consents by balancing the transaction. For Dust Dice this is exactly right: a player's
`stakeIn` is authorised by that player's own signature over their own UTXO.

**A circuit cannot learn its caller's address.** The only self/identity accessor is
`kernel.self(): ContractAddress`. `ownPublicKey()` is the _shielded_ (Zswap) key of the
transaction submitter, not an unshielded address. Payout recipients must therefore be **public
circuit arguments**, as `payOut` has them — which means the table contract has to be told who
won rather than inferring it, and that binding needs its own authorisation design.

**The `Either` nesting is inverted relative to the shielded API.** Unshielded recipients are
`Either<ContractAddress, UserAddress>` (left = contract, right = user); shielded ones are
`Either<ZswapCoinPublicKey, ContractAddress>`.

**Exported-circuit parameters are witness-tainted.** Passing one to `receiveUnshielded` /
`sendUnshielded` or to a ledger write is a "potential witness-value disclosure" and needs an
explicit `disclose()`. Correct for a pot — stake and payout amounts move public UTXOs and are
inherently public — but it is not the default and the compiler error does not say "your own
argument".

**`mintUnshieldedToken` cannot mint NIGHT.** Its colour is `persistentCommit(domainSep,
contractAddress)`, which cannot practically collide with the all-zero constant. This is a
structural consequence of the hash derivation, **not** an explicit assert or ledger rejection —
no NIGHT-specific carve-out exists anywhere in `verify.rs`, `semantics.rs` or `structure.rs`.
Contract-minted "chip" tokens are therefore a genuinely different token from NIGHT, which is why
the fallback design was not needed and would not have been equivalent.

### Evidence

The run below is the one the committed code reproduces (`node src/run-probe.ts`), contract
`03ea73862c271c112c243ac29bd820279ae6f3f97e8bf33cf0aeabf9b4e5e4f2`. An earlier run on a
different contract, with a different throwaway player-2 wallet, gave identical amounts and the
same verdict — **the result reproduced twice, end to end**.

All figures are read from the **indexer** (the chain's view), never from the wallet that built
the transactions. That distinction turned out to matter: the wallet facade's aggregate
`state().unshielded.balances` misreported genesis's pre-stake balance by 4,900,000 in this very
run (§9 of `bugs-found.md`), which would have made the staker's apparent delta −100,000 instead
of the true −5,000,000. **Per-transaction UTXO movement is the only trustworthy measure**, and
that is what `probes/gate0/tools/utxo-audit.mjs` prints:

| Step                       | Block | Native NIGHT spent by users | Native NIGHT created for users | Net into contract |
| -------------------------- | ----- | --------------------------- | ------------------------------ | ----------------- |
| `stakeInPadded` (genesis)  | 711   | 19,998,995,100,000          | 19,998,990,100,000 (change)    | **+5,000,000**    |
| `stakeInPadded` (player 2) | 715   | 10,000,000,000,000          | 9,999,995,000,000 (change)     | **+5,000,000**    |
| `potBalance`               | 721   | 0                           | 0                              | 0                 |
| `payOut`                   | 725   | **0**                       | 10,000,000                     | **−10,000,000**   |

Transaction hashes: `e8ed8e2a4497cd68c491880ddd322a5562b1835ba0762fa54a9e0704935c2c1b`,
`48fd83d807e519ddb7616c26a331dc7217007dce185b6bf664b5015149175082`,
`4a9add1cc89f16cf72e57d03661d420a8c7d9d22c723763a307bc82fc9492f58`,
`41c56266018dba9023278432f8b8dc92c49f1ae21fb4741ebf4d2adb397f78e3`.

**The `payOut` row is the decisive one: it spends zero user inputs and creates 10,000,000 of real
native NIGHT.** The value can only have come from the contract's own balance. That is custody,
demonstrated rather than asserted.

Corroborating reads:

- Contract's native-NIGHT balance as the ledger reports it: `0 → 5,000,000 → 10,000,000 → 0`.
- `potBalance` returned **10,000,000** from an in-circuit `unshieldedBalance(nativeToken())` —
  the contract can see its own native balance.
- Final Compact ledger fields `pot=0`, `stakeCount=2`, `payoutCount=1` — all asserted.
- `payOut`'s two created outputs:

| Owner                  | Value     | Token type           | `registeredForDustGeneration` |
| ---------------------- | --------- | -------------------- | ----------------------------- |
| player 2 (winner, 99%) | 9,900,000 | `0000…0000` (native) | **true**                      |
| genesis (rake, 1%)     | 100,000   | `0000…0000` (native) | **true**                      |

Two wallets, one pot, one settle transaction paying two distinct recipients: **the planned
design's core mechanic works.**

### The designation question

The payout arrives as a **completely normal spendable UTXO**. The ledger's `Utxo { value, owner,
type_, intent_hash, output_no }` has no contract-origin variant (`ledger/src/structure.rs:3193`),
and a contract's `sendUnshielded` is balanced against a real `UtxoOutput` indistinguishable from
one produced by a wallet-to-wallet transfer.

DUST generation, however, is **conditional on the recipient having already registered**. From
`ledger/src/dust.rs:1280-1306`, `apply_offer` registers a new NIGHT output for DUST generation
only if `state.generation.address_delegation.get(&output.owner)` already holds a night-key →
dust-address delegation; otherwise the UTXO is created and fully spendable but generates no
DUST. Both recipients in the run above had registered, hence `true` in both rows.

**This is a real trap for Dust Dice.** A winner who has never registered receives their winnings
and _cannot pay a transaction fee with them_, because fees are DUST — and registering itself
costs DUST. We hit exactly this bootstrap on the throwaway second wallet: a freshly funded
wallet's `registerNightUtxosForDustGeneration` failed with `Insufficient generated dust to cover
registration fee (have 214942000000000, need 510950455244571)`. The remedy is the SDK's own
`estimateRegistration` → `waitForGeneratedDust(utxos, fee)` → register sequence, and it gets
faster the more NIGHT is held (1,000 NIGHT needed a long wait; 10,000,000 NIGHT was immediate).
Any onboarding flow must register a new player for DUST generation **before** they can act.

---

## The blocker we had to solve: `OutsideTimeToDismiss`

This is the most important operational finding in the report, and it is **not** about tokens.

The first `stakeIn` attempts were rejected by the node. The client reported only
`1010: Invalid Transaction: Custom error: 231`. The node log named the real cause:

```
Transaction malformed: exceeded the maximum time to dismiss for transaction size;
this transaction would take 15.968ms to dismiss, but given its size of 7146 bytes,
it may take at most 15.000ms
Rejected transaction … : Transaction Error: Malformed(FeeCalculation(OutsideTimeToDismiss))
```

### The rule

From `midnight-ledger` @ `ledger-9.1.0.0-rc.3`:

```
allowance    = max(min_time_to_dismiss, time_to_dismiss_per_byte × est_size())   [structure.rs:2373-2376]
dismiss_cost = guaranteed_transcript_gas + validation_cost                        [structure.rs:2358-2363]
```

with `INITIAL_LIMITS` (`structure.rs:1237-1285`): `min_time_to_dismiss = 15_000_000_000 ps`
(**15.000 ms**), `time_to_dismiss_per_byte = 2_000_000 ps` (**0.002 ms/byte**),
`transaction_byte_limit = 1 MiB`.

`validation_cost` is dominated by **fixed cryptographic constants**, not by the contract:
`proof_verify` 5.825 ms and `verifier_key_load` 3.407 ms per contract call, plus another
`proof_verify` per DUST spend, plus signature verifications and a doubled baseline
(`onchain-vm/gen/const_declaration.rs`, `ledger/src/structure.rs:1958-2047`). That is where the
~15.97 ms comes from.

`enforce_time_to_dismiss` is **hard-coded `true`** at `ledger/src/verify.rs:662`. The only lax
path is genesis-block processing (`enforce_balancing = false`), and the node toolkit's
`update_ledger_parameters` command does not expose these limits. **It cannot be configured
away.**

### Consequence: a contract call must be _big enough_

Rearranged: a transaction is admissible only if `size ≥ 500 bytes per ms of dismiss cost`. At
~15.97 ms of fixed cost that is **≥ 7,984 bytes**. A minimal Compact contract call is smaller
than that, so **it is unconditionally inadmissible** — the fixed verification cost of one proof
plus one DUST spend cannot be paid for by a small transaction.

Confirmed by two rejections whose numbers fit the formula exactly:

| Size (bytes) | Allowance                     | Dismiss cost | Verdict  |
| ------------ | ----------------------------- | ------------ | -------- |
| 7,146        | 15.000 ms (the floor)         | 15.968 ms    | rejected |
| 10,282       | 20.564 ms (`= 10282 × 0.002`) | 21.698 ms    | rejected |

The second row is instructive: adding wallet UTXOs grew both size _and_ cost, and cost grew
faster. Padding is only useful because it grows size **without** growing cost.

### What did and did not work

| Attempt                                                                                         | Result                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel.checkpoint()` at the top of the circuit, moving all contract work to the fallible phase | **No effect** — 15.967 → 15.968 ms. Confirms the contract transcript is not what is being measured.                                                                  |
| 2 KB `persistentHash` padding                                                                   | **Unprovable** — pushed the circuit to k=17; the proof server lacks `bls_midnight_2p17` and cannot reach `srs.midnight.network`. Every `/prove` failed after ~366 s. |
| 2 KB struct written to the ledger **after** `kernel.checkpoint()`                               | **Works.** A fallible-phase write counts toward `est_size()` but lands in `f_cost`, which `time_to_dismiss` never sums.                                              |

Measured sizes after padding — all admitted:

| Transaction                | Bytes  | Allowance |
| -------------------------- | ------ | --------- |
| deploy                     | 9,742  | 19.48 ms  |
| `stakeInPadded` (genesis)  | 9,565  | 19.13 ms  |
| `stakeInPadded` (player 2) | 9,577  | 19.15 ms  |
| `potBalance`               | 9,035  | 18.07 ms  |
| `payOut`                   | 10,185 | 20.37 ms  |

(`probes/gate0/tools/tx-sizes.mjs` prints this table; sizes vary by a few bytes run to run with
the number of wallet UTXOs consumed.)

**Controlled experiment.** The same deployed contract exposes `stakeIn` (unpadded) and
`stakeInPadded` (identical token semantics, 2 KB of padding). `stakeIn` was rejected on 6/6
attempts with `OutsideTimeToDismiss`; `stakeInPadded` was admitted first try. The blocker is
transaction **size**, categorically not native-NIGHT custody.

**Transaction bytes and circuit size are independent levers**, and this environment constrains
both from opposite directions: too small a transaction is inadmissible, too large a circuit is
unprovable. `ctl.compact` — a single `Counter` increment, the cheapest contract call that can be
written — needs **k=5**, which the proof server also lacks, so it could not be proved at all.

---

## Q2 — Measured transaction budget

Four distinct circuit calls plus one deploy, wall clock, instrumented per phase
(`probes/gate0/src/providers.ts` wraps `proveTx`, `balanceTx` and `submitTx`).

| Transaction                | Prove  | Balance+sign | Submit→inclusion | Total       | Block |
| -------------------------- | ------ | ------------ | ---------------- | ----------- | ----- |
| deploy                     | 0.00 s | 1.08 s       | 15.98 s          | **26.17 s** | 707   |
| `stakeInPadded` (genesis)  | 1.49 s | 0.39 s       | 19.09 s          | **22.04 s** | 711   |
| `stakeInPadded` (player 2) | 1.39 s | 0.36 s       | 17.34 s          | **20.17 s** | 715   |
| `potBalance`               | 1.50 s | 0.39 s       | 16.48 s          | **19.44 s** | 721   |
| `payOut`                   | 1.50 s | 0.42 s       | 19.02 s          | **22.03 s** | 725   |

**Per-transaction averages over the 4 circuit calls:**

| Phase                            | Average     |
| -------------------------------- | ----------- |
| Client-side proving              | **1.47 s**  |
| Balancing + signing + finalizing | **0.39 s**  |
| Submission → inclusion           | **17.98 s** |
| **Total per transaction**        | **20.92 s** |

Deploy wall time: **26.17 s** (a deploy carries no proof — `prove` is ~0 — so it is almost
entirely inclusion latency; the gap between `submit` and `total` is the retry of one transient
`InvalidDustSpendProof`, §6).

The earlier independent run averaged **20.26 s** per transaction over the same four calls, so
these figures are stable to within ~3%.

The dominant term is **inclusion, not proving**: ~18 s of the ~21 s is waiting for the chain.
Proving is only 7% of the budget. At the devnet's ~6 s block time, ~18 s is roughly three
blocks — submission, inclusion, and the indexer catching up. **Optimising circuits will not
move this number**; only reducing the number of transactions will.

### Yahtzee turn-shape arithmetic

Serial wall time = transaction count × 20.92 s. Serial is the right model for a single table:
every call mutates the same contract state, so calls cannot be pipelined without state-conflict
failures, and each player has one wallet whose spends must be sequential.

| Shape                                              | Transactions | Serial wall time      |
| -------------------------------------------------- | ------------ | --------------------- |
| **per-roll** — 6 players × 13 rounds × 4 tx        | 312          | **6,527 s ≈ 109 min** |
| **per-turn** — 6 players × 13 rounds × 1 tx        | 78           | **1,632 s ≈ 27 min**  |
| **2-player manual** — 2 players × 13 rounds × 4 tx | 104          | **2,176 s ≈ 36 min**  |

**Read on the design:** per-roll on-chain is not viable — a 109-minute six-player game is not a
game. Per-turn at 27 minutes is playable but slow, and it is the only shape of the three that is
defensible for a six-player table. The 2-player manual demo at 36 minutes is workable for a
scripted demonstration but too long for a live one; a 2-player _per-turn_ variant would be
2 × 13 × 20.92 s ≈ **9 minutes**, which is the shape to aim a demo at.

Note these are devnet numbers with a ~6 s block time and a local proof server. Inclusion
latency is the whole budget, so any change in block time moves every figure above
proportionally.

---

## What this means for the planned design

**One Table contract holding a pot and paying winner + rake at settle: CONFIRMED VIABLE.**
Nothing found invalidates it. Specifically confirmed working: multiple distinct wallets staking
native NIGHT into one contract; the contract reading its own native balance in-circuit; and one
transaction paying two different user addresses from the contract's custody.

Four constraints the design must absorb:

1. **Every circuit call must produce a ≥ ~8 KB transaction.** Real game circuits (dice, scoring)
   will likely clear this on their own, but it must be _verified per circuit_, not assumed — and
   a circuit that is too small needs deliberate padding. Conversely, circuits must stay small
   enough that their k is one the proof server has. Both bounds need a test.
2. **Budget ~20 s per transaction, essentially all of it inclusion latency.** Design for
   per-turn, not per-roll. Optimising proof cost buys ~9% at most.
3. **Winner and rake recipients must be public circuit arguments** — a circuit cannot learn its
   caller. Authorising "who won" is a separate design problem the contract cannot solve by
   itself.
4. **A player must be registered for DUST generation before they can act**, and their winnings
   generate no DUST unless they were registered when the payout landed. Onboarding has to do
   this explicitly, and it is not free.

Open question not answered here: whether **batching** several calls into one transaction is a
usable lever. It would cut inclusion waits (the dominant cost) and each extra call adds bytes,
but it also adds ~9.2 ms of fixed dismiss cost per call, and the neighbouring project recorded
client-side gas under-declaration on multi-call transactions (~15% failure at 2 calls, 60% at 3
— `bugs-found.md` §0 #21). Worth its own probe before the design commits to it.

---

Defects found while producing this report are logged in
[`bugs-found.md`](bugs-found.md) §§3–9.
