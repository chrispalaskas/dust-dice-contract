# Security audit — Dust Dice contracts, 2026-09-07

Scope: everything in this repository — `contract/src/table.compact`, `lobby.compact`, the three
included cores (`dice-core`, `scoring-core`, `policy-core`), the TypeScript mirrors and
witnesses, `api/`, `verifier/`, the CI/release workflows and the protocol docs. The private
operator daemon and the web UI are out of scope and are referred to only where the contract's
guarantees depend on them.

Focus, as asked: **can a malicious actor pretend to be a player, or otherwise leave a table with
NIGHT they did not earn?**

Method: full read of every contract and TypeScript source; attack modelling against the
authorisation, custody, timeout and settlement paths; every candidate finding was then either
**executed** against the compiled contract through the repo's own simulator and harness
(`docs/security-audit-2026-09-poc.test.ts`, 11 tests, all pass = all exploits reproduce), or
marked "by inspection". Baseline: the existing suite is green (199/199) on the same artifacts.
One Midnight-platform assumption the whole custody model rests on was checked against the
ledger source rather than trusted (§4).

## 0. Summary

| #   | Severity | Finding                                                                                                                | Status               |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| A   | **High** | A delinquent player manufactures an "operator stall" and aborts the table into a full, rake-free refund                | executed, fix tested |
| B   | Medium   | The resignation discount makes the final round a free option: every loser recovers ≈7.7 % of its stake from the winner | executed             |
| C   | Medium   | Six free join/leave cycles permanently burn every slot of a filling table (storefront denial of service)               | executed             |
| D   | Low      | The chain-only verifier reports VERIFICATION FAILED on any legitimate table that had a pre-start leaver                | by inspection        |
| E   | Low      | Release pipeline installs the compiler via an unpinned curl-pipe-sh installer and mutable action tags                  | by inspection        |
| —   | Info     | Six observations, none exploitable in-contract (§3)                                                                    |                      |

**The direct impersonation question has a clean answer: no.** A seat's moves, resignation and
nothing else are authorised by zero-knowledge proof of the seat's `sk_s`; the payout address is
recorded at `join` and never read from a caller; every payout circuit pays only that address.
Nobody can move, resign or redeem _as_ another seat, and nobody can redirect a seat's money.
Section 2 records what was checked. The money that CAN be misdirected is the _winner's_: A and
B are both ways for a player who is losing to take value out of the pot the rules assign to the
winner.

## 1. Findings

### A. HIGH — a delinquent player manufactures an operator stall and aborts into a full refund

**Where.** `abortTable`, `operatorStalled` branch (`table.compact` ≈ lines 2270–2285), and
`playerMove`, which has no deadline check.

**The claim the contract makes.** `abortTable`'s doc comment: _"THE WAITING-ON-THE-OPERATOR
CONDITION IS LOAD-BEARING … Without it, a player who is losing could simply stop playing, let the
round deadline and the table grace both pass, and abort the game into a full refund. With it, a
table where every seat's next move is its own has only one exit — eliminate the stragglers."_
The test `refuses to abort a live table where no seat is waiting on the operator` pins that.

**Why it does not hold.** The _player_ controls every transition into an operator-owed (odd)
stage — `open` (0→1) and `hold` (2→3, 4→5) — and `playerMove` checks no clock. So a seat that
is idle at 0, 2 or 4 when `roundDeadline + tableTimeoutSecs` has passed is not stuck behind the
guard: it sends one `playerMove`, is instantly "waiting on the operator", and `abortTable` is
legal in the same block time. Two calls, different entry points, from one wallet — exactly the
shape `withContractScopedTransaction` composes into ONE transaction (docs/fast-turn-design.md
"EXECUTED PROBE RESULTS", bugs-found #17/#18), so there is no race with the operator's resolve
at all.

**Executed** (PoC file, `FINDING A`, four tests):

| scenario                                  | result                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| on-chain, seat idle at stage 0 past grace | `abortTable` refused (`neither stalled`) → `open` accepted → `abortTable` OK    |
| on-chain, seat at stage 2 past grace      | `hold` accepted → `abortTable` OK                                               |
| fast table, stage 0 past grace            | identical                                                                       |
| money                                     | phase `aborted`, every seat `redeemable = tier`, pot 0, **no rake, no penalty** |

At `tier = 1 000 000` the leader's honest outcome (opponent eliminated in round 0, walkover)
was 1 066 154; after the manufactured abort it is exactly 1 000 000, and the delinquent seat
redeems its full stake instead of losing a thirteenth.

**Precondition, stated honestly.** The delinquent seat has been eliminable by _anyone_ since
`roundDeadline + 1` and nobody did it for `tableTimeoutSecs`. So the property the contract
actually provides is _"the penalty schedule holds if some honest party eliminates within the
grace window"_, not the unconditional in-contract guarantee the comment describes. Three
reasons that liveness assumption is weaker than it looks:

1. It is the operator daemon's policy in a private repo, not the contract, that eliminates. The
   public contract has no defence.
2. The daemon **deliberately** holds eliminations after an outage for one full `turnTimeoutSecs`
   on fast tables (table-interface.md "Outage grace"). Whenever `turnTimeoutSecs ≥
tableTimeoutSecs`, that hold _outlasts_ the abort window and the exploit is deterministic.
   Both are sealed constructor arguments; the constructor only requires each to exceed 240 s.
3. Other players have no incentive to pay a fee to eliminate a rival unless they are winning,
   and a UI need not expose the button.

A losing player therefore has a standing, zero-cost option: stop, wait, and if the table has
not eliminated them by the end of the grace, take everyone's stake back. The rake is skipped
too, so the operator loses its fee.

**Fix (tested).** Refuse any `playerMove` once the round deadline has passed — a seat that is
eliminable may not also act:

```compact
  const r = openRound;
  assert(r < roundCount(), "playerMove: the game is over");
  // a seat past the round deadline is eliminable and may no longer move
  assert(!blockTimeGt(roundDeadline), "playerMove: the round deadline has passed");
```

With that, an odd stage can only be entered _before_ the deadline, so `operatorStalled` at
`deadline + grace` really does mean the operator had at least `tableTimeoutSecs` to respond.
Verified on a scratch build (`compact compile --skip-zk`, no repo artifacts touched):

- ordinary play inside the round unchanged; a move exactly at the deadline is still accepted (the
  predicate is strict, matching `eliminate`'s `blockTimeGt`);
- both PoC variants (on-chain and fast) now fail at `playerMove` with the new message and the
  table stays `playing` — `eliminate` is the only exit;
- the _genuine_ operator stall (seat went odd before the deadline, operator never resolved) still
  aborts;
- ZKIR: `playerMove` 1 244 → 1 285 instructions (+41); every other circuit byte-identical in
  instruction count. `roundDeadline` is written only by `closeRound`, so the new read binds to
  nothing that moves within a round and conflict-freedom is preserved (re-run
  `src/test/ledger-access.ts`-backed tests to confirm). **k must be re-measured** (`npm run k -w
cli`): `playerMove` sits at k = 14 of 15 and +3 % instructions is unlikely but not certain to
  cross the boundary.

Side effect to accept: on a fast table the composed settlement must land before
`roundDeadline`. Fast rounds are 300 s and a fast turn ≈ 35 s, and a settlement that lands after
the deadline is in any case one the seat could have been eliminated ahead of.

### B. MEDIUM — the resignation discount makes the final round a free option for the loser

**Where.** `eliminate`, `charged = vol ? r : r + 1`; resignation is legal at any stage,
including _after_ the seat has scored the open round (test `a resignation is legal mid-resolve
and after scoring`).

**The problem.** The discount is meant to make "leaving loudly" cheaper than "leaving silently"
(timeout). But the comparison a rational player makes at the end of the game is resign vs _play
on and lose_, and losing pays 0. In round 12 — after every card is complete and public, before
`closeRound` — the loser resigns for `tier × 12 / 13` and gets `tier/13` back out of the pot.
Every rational loser does this in every game; the winner's payout is reduced by ≈ 7.7 % of
`tier` per losing opponent. More generally, at every round `r` a seat may play the whole round,
see everyone's result, and still leave at the round-`r` price, so each round is a free look.

**Executed** (PoC `FINDING B`): a complete 2-seat game, totals 42/32; the loser resigned after
its final score for penalty 923 076 and received **76 924** back; the winner was paid
**1 903 846 instead of 1 980 000**. Second test: seat 0 plays all of round 0, sees both
results, leaves for `q = 0` (full refund); seat 1 "wins" 990 000 of its own 1 000 000 — the
documented "free exit in round one" is also a free exit _after seeing round one_, and it costs
the honest opponent the rake every time.

**Is this intended?** The docs describe the mechanism (table-interface.md §`eliminate`, the
"leave loudly" incentive) but never the terminal-round consequence, and decision 3 of
simultaneous-rounds.md says the penalty for the round you failed in "goes to the winner". A
seat that has scored round `r` has not failed in it; it has consumed it.

**Fix options** (design call; cheapest first):

1. Charge the resigner `r + 1` whenever the open round is already consumed — the seat has
   opened its turn (`pend.stage != idle`) or scored it (`prog.round > r`) — and unconditionally
   at `r == finalRound()`. The discount then applies exactly to "I am leaving _before_ playing
   this round", which is what the incentive text describes. One extra comparison; no new reads.
2. Keep the discount but pay it from the _resigner's_ side: resign = `(r + 1)/13` penalty to the
   pot minus a fixed rebate that comes off the rake rather than the pot.
3. Drop the discount and keep only the timing benefit of resigning (immediate walkover, immediate
   redeem), which is already a real benefit.

Whichever is chosen, `verifier/src/verify.ts`'s penalty inference (`resignPenalty`) must move
with it.

### C. MEDIUM — six free join/leave cycles permanently burn every slot of a filling table

**Where.** `join` (`seatCount < maxSeats()`; slots are positional, a leaver keeps its slot),
`eliminate(voluntary)` while `filling` (charged `tier × 0 / 13 = 0`), `redeem` for a
`leftBeforeStart` seat in any phase.

**The problem.** Leaving a filling table is free and paid at once, and a fresh `sk` costs
nothing. An attacker joins and leaves six times: `seatCount = 6`, `activeSeats = 0`, and every
further `join` is refused with `no free slot`. The table holds no money and can never start; it
sits in the lobby as the tier's open table until the fill clock runs out and someone aborts it,
after which the operator has to deploy another — which can be killed the same way. Cost to the
attacker: twelve transactions' worth of DUST and a stake that is back in hand within a block.
The same join/leave also restarts `fillOpenedAt`, so it delays an early start for as long as
slots last.

**Executed** (PoC `FINDING C`): 2-seat public table, 6 × (join, resign, redeem) → honest join
refused; pot 0; phase still `filling`.

**Fix options.** (a) Make a vacated slot reusable: on `join`, if `activeSeats < seatCount`, seat
the joiner in the first slot whose `finishedAtRound == leftBeforeStart()` (six reads, all on the
already-serialised `join` path, so no new conflict; k to re-measure). (b) Price the exit: a
pre-start leaver pays the 1 % rake, which caps the attack at ≈ 6 % of `tier` per dead table and
is consistent with "the operator did work". (c) Both.

### D. LOW — the verifier fails legitimate tables that had a pre-start leaver

**Where.** `verifier/src/verify.ts`: the `join` branch asserts `led.pot === tier × (seat + 1)`
(false once an earlier slot left and took its stake back), and the `eliminate` branch asserts
`finishedAtRound === 65535` (a leaver carries `65534`). Both are reported as check failures on
a table that behaved correctly. By inspection; not executed (needs an indexer). The invariant
check it should use is already in the file — `pot + owed + paid == tier × seatCount` — and the
sentinel should accept `leftBeforeStart`.

### E. LOW — release pipeline supply chain

`.github/workflows/ci.yml` and `release.yml` run `curl … compact/releases/latest/download/
compact-installer.sh | sh` and then pin only the compiler version. The installer script itself
is unpinned and un-hashed, and `actions/checkout@v4` / `setup-node@v4` are mutable tags. The
release job produces the _proving keys and verifier keys_ that every deployed table pins, so a
compromised installer would ship a compromised build under a valid npm provenance attestation.
Pin the installer to a release tag and verify its checksum; pin actions to commit SHAs. (npm
trusted publishing and `npm ci` against the lockfile are done right.)

## 2. The impersonation surface — what was checked and held

Every item below was either executed (PoC "CHECKS THAT HELD" or the existing suite) or traced
in the compiled contract.

- **Authorisation is capability-based, not address-based.** `playerMove` (all three kinds) and
  `eliminate(voluntary)` assert `entropyKeyCommitment(tableId, sk) == seatIdentity[s].keyCommit`
  with `sk` a private witness; only the boolean is disclosed. Wrong secret → rejected (executed).
  There is no caller identity anywhere, so there is nothing to spoof.
- **Money is address-bound at join and never re-read from a caller.** `settle` pays
  `seatIdentity[winner].addr` and `rakeAddress`; `redeem` pays `seatIdentity[s].addr`. Both are
  permissionless: a stranger calling `redeem(s)` can only do seat `s` a favour. Stealing `sk_s`
  therefore yields _control of the seat's moves_ (throw the game, resign it) but never its money
  — the refund goes to the recorded address. (Client-side note in §3.)
- **The public `entropy` and the commitments leak nothing.** `C_s = H(tag, tableId, sk)`,
  `entropy_r = H(tag, sk, tableId, r)`, seed commitment and mix use five distinct 32-byte
  domain tags and fixed-width fields; nothing is concatenation-ambiguous and no value is
  hashed under two tags. Revealing thirteen `entropy_r` values is thirteen `persistentHash` outputs of a
  256-bit CSRNG secret (SHA-256 per security-review.md).
- **A seat cannot act twice, out of order, or for a stale round.** Opening needs
  `prog.round == openRound` and `stage == idle`; scoring returns the seat to idle and advances
  `round`; `resolveRoll1` pins `t.round == openRound`; stages 3/5 are reachable only through a
  `hold` that wrote the open round and `closeRound` refuses while any seat is mid-turn
  (executed).
- **Replay and front-running.** A landed transaction cannot be re-applied: its transcript binds
  the reads it made (`stage`, `seatCount`…) which the same transaction changed. Two `join`s in one
  block conflict on `seatCount`, so the loser's stake is never taken (documented, measured in
  concurrency-probe.md). A `playerMove` cannot be altered in flight — every argument is a
  public input to the proof.
- **Fast tables.** Pre-proven player moves are bound to the predicted intermediate state, so the
  operator can only submit them in the agreed order or not at all; it cannot change a mask or
  category. What is operator-attested is the _ordering_ of reveal vs hold, which the docs state
  plainly and which is the same trust the seed already requires.
- **Dice cannot be steered by any party without the seed.** Player entropy is forced; the round
  digest is frozen per round; the digest fold is by seat index. Sybil seats (one actor, many
  `sk`) buy nothing but a later look at other seats' dice within a round.
- **Arithmetic.** Every division is the unique Euclidean witness (`q·13 + rem`, `q·100 + r`);
  `penalty ≤ tier` is asserted; `tier ≤ 10^15` bounds every product; `pot − refund` cannot
  underflow because an active seat's stake is in the pot. Custody
  `pot + Σredeemable + Σpaid == tier × seatCount` re-checked on every terminal path including
  the pre-start-leaver combinations (§C's PoC exercised them).
- **Terminal states.** `eliminate`, `resign`, `playerMove`, `closeRound` all refuse at
  `openRound == 13`; `settle` is the sole exit and its seed waiver pays the winner computed from
  public state (executed: `eliminate`/`resign` refused after the last `closeRound`).
- **Lobby.** No funds, no cross-contract calls, operator-key authorisation by commitment; the
  worst case is a bad hyperlink, exactly as its header says.

## 3. Informational observations

1. **The public client code does not pin the build fingerprint.** README: "the hash of the nine
   verifier keys is what a deployed table pins". Only the private daemon does so; `api/` and
   `verifier/` accept any address. A hostile lobby entry pointing at a _modified_ table contract
   (e.g. one whose `settle` pays a different address) is indistinguishable to a client that does
   not compare verifier keys. Expose a fingerprint check in `@dust-dice/verifier` so the UI and
   third parties can use one implementation.
2. **`TablePrivateState` carries both parties' secrets** (`rollSeed`, `playerSecret`,
   `inviteCode`). Correct for the simulator; in production the type invites a daemon that also
   plays (forbidden by the threat model) to hold both in one record. Consider two types.
3. **`payoutTo` is whatever the UI puts in the transaction.** The wallet approval shows a
   32-byte public input; a compromised UI could seat a player with the attacker's payout address.
   Inherent to the platform; worth a line in the site's threat model and a UI-side "this is your
   address" confirmation.
4. **Fast tables: a rival can eliminate a stage-1 seat during the operator's outage grace.**
   Documented in table-interface.md. Finding A's fix does not change it.
5. **Declared-time slack** (C1 in security-review.md) is closed as documented; the same
   120 s shave applies to the last `join`, `closeRound` and `abortTable(starting)`.
6. **`api/src/policies.ts`** is dead contract-wise and still exported; harmless, but a
   consumer could mistake it for canonical.

## 4. Platform assumption checked against source

The custody model assumes that a transaction whose transcript records `receiveUnshielded(tier)`
cannot be valid unless it actually delivers `tier` to the contract, and that a `sendUnshielded`
cannot be omitted or redirected by whoever assembles the transaction. Neither can be observed
in the simulator (bugs-found #11) and the E2E runs only exercise the honest client, so this was
checked against `midnightntwrk/midnight-ledger` at tag `ledger-9.1.0.0-rc.5` and the Compact
standard library (`LFDT-Minokawa/compact`, main). Result: **both hold, and the mechanism is not
the one the contract comments describe.**

- `receiveUnshielded(color, amount)` is `kernel.incUnshieldedInputs` and lands in
  `Effects.unshielded_inputs` (`compiler/standard-library.compact` 320–322;
  `onchain-runtime/src/context.rs` 645–654). It carries no address.
- There is **no such thing as an unshielded output to a contract address**: `UtxoOutput.owner`
  is a `UserAddress` (`ledger/src/structure.rs` 3213–3220). What the ledger enforces instead is
  an aggregate per-token, per-segment balance: real offer inputs add, real outputs subtract, a
  contract's claimed receive subtracts, a contract's claimed send adds, and
  `balancing_check` rejects the transaction with `BalanceCheckOverspend` if any balance is
  negative (`ledger/src/verify.rs` 746–895, 1360–1375; `enforce_balancing` defaults to true). So
  a `join` that pays nothing cannot be valid: something for nothing is exactly what the
  equation forbids. The doc comments on `join` ("the offer must contain an output to the
  contract") should be reworded to this.
- `sendUnshielded(color, amount, right(addr))` additionally records
  `claimed_unshielded_spends` keyed by `(token, PublicAddress::User(addr), amount)`, and the
  transaction must contain a real output that matches the **full tuple, exact amount included**,
  as a multiset subset (`ledger/src/verify.rs` 1665–1727,
  `RealUnshieldedSpendsSubsetCheckFailure`). An assembler cannot omit, shrink, grow or redirect
  a payout. This is what makes `settle`, `redeem` and the fast-table settlement's single
  balancer safe.
- Scope nuance worth knowing: the **guaranteed-phase** balance is pooled across every intent in
  a transaction under segment 0; fallible-phase balances are per intent. Every table circuit
  ends with `padTransaction()`'s `kernel.checkpoint()`, so all of this contract's money
  movement is guaranteed-phase and pooled. In a merged multi-party transaction one party's real
  input can therefore satisfy another party's `receiveUnshielded`. That is the property the
  fast-turn design relies on (one balancer pays for both parties) and it is not exploitable
  here: every honest intent the SDK builds is self-balanced (inputs = outputs + change), and a
  contract send adds to the pool only against an exact real output, so merging someone else's
  intent never yields surplus to fund a `join`.

Caveat carried over from the check: the ledger tag was not cross-checked against
`midnight-node 2.0.0-rc.4`'s `Cargo.lock`, and the stdlib was read from `main` because the
compact repo has no tag for runtime 0.19.0 (the npm runtime package itself contains none of this
logic).

## 5. Recommendations, in order

1. Apply the `playerMove` deadline gate (A); re-measure k; re-run the UTXO release gate.
2. Decide the resignation schedule (B) and update `verify.ts` alongside.
3. Make vacated pre-start slots reusable or price the exit (C).
4. Fix the two verifier assertions (D).
5. Pin the compiler installer and the actions (E).
6. Correct `abortTable`'s doc comment and table-interface.md so the "load-bearing" guard is
   described with its real precondition until A is fixed.

## Appendix — reproducing

```sh
npm ci && npm run compact:fast -w contract        # or a full compile
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  --test docs/security-audit-2026-09-poc.test.ts   # 11 tests; passing == exploits reproduce
```

The fix for A was verified on a patched copy compiled to a scratch directory with a
40-line simulator; the patch is the two lines quoted in §A.
