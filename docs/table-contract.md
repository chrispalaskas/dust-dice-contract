# Table contract design

One deployment per table. This document is the state-machine and randomness design; custody
mechanics follow the Gate 0, Q1 verdict (see architecture.md).

## Who computes the dice — the two-step turn

The contract holds only `H(seed)`; no circuit can derive dice from a commitment, and the
player must not know the seed. So a turn is a player step and an operator step, by two
different parties (four transactions as built — see the amendment below):

1. **`takeTurn` (player):** submits their per-round entropy (see below), a hold-policy choice,
   and the scoring category **for their previous turn's dice** (pipelined — see next section).
2. **`resolveRoll1` / `resolveRoll2` / `resolveRoll3` (operator):** supplies the seed as a
   **witness** (private — never disclosed mid-game), each circuit asserts
   `H(seed) == seedCommitment`, and between them they derive the three rolls with holds applied
   per the declared policy and write the resulting dice into the turn log.

This is the one place ZK genuinely works in the base game: the dice are _proven_ correct
against the seed commitment without revealing the seed while the game is live.

> **Amendment, after the E2E run** ([e2e-report.md](e2e-report.md)). The operator's move was
> designed as ONE transaction, `resolveTurn`, and is built as **three**. The one-circuit version
> compiles to a PLONK domain of k=17 and the proof server bundles only k=9..15, so it could
> never have produced a transaction. The cut is one roll per transaction, which the existing
> measurements already forced: one roll is k=15, two are k=16. The dice, the digest chain and the
> settlement verifier are **unchanged** — the same three roll hashes in the same order under the
> same latched mask. What changes is throughput (a turn is four transactions, not two) and that
> the intermediate hands are public, which is exploitable by nobody because the only player
> choice in a turn is made in `takeTurn`, before any roll exists. Full rationale in
> `table.compact`, decision 9.

The player experiences 13–14 wallet prompts per game; the operator automates three resolves per
turn from its own wallet (strictly sequential — one wallet per process).

## Pipelined category choice — keep the skill

Pre-declaring the category before seeing the dice (naive shape (a)) costs too much skill
expression. Instead, `takeTurn` k carries:

- the **category choice for turn k−1's dice** (which the player has seen — they were resolved
  on-chain), and
- the **entropy + hold policy for turn k**.

Concretely: `takeTurn` for round r carries the category for round r−1 (omitted at r=0) and
the entropy + hold policy for round r (omitted in the final score-only round 13). Per seat:
14 `takeTurn`s, 13 resolves. Category choice — the dominant skill decision in Yahtzee —
stays fully manual; holds are policy-driven and latched from roll 1.

**Hold-policy set, as built and measured** (docs/table-circuit.md): all six policies from
api/src/policies.ts shipped — Stand, RerollAll, KeepModal, KeepFace(1–6), ChaseStraight,
KeepPairsPlus — encoding mirrored exactly. Modal-face cannot be _computed_ in-circuit
(compiler defect #1: re-reads × DAG size), so KeepModal is witness-checked: the operator
witnesses the modal face `m`, the circuit verifies canonical-modality via counts, the mask
is `die == m` — proven equivalent to the reference over all 252 sorted hands. Whole-hand
count-based masks (ChaseStraight, KeepPairsPlus) compile fine: fan-in alone was never the
trigger, fan-in × re-reads is.

**Residual, stated honestly (policy grinding):** entropy is forced, but the policy is a free
per-turn choice made after the digest is public — so a _seed-knowing_ player can preview all
eleven legal policy choices and pick the best. Bounded (best-of-11, not best-of-2^256),
inherent to any design that preserves turn-time choice, and it requires the seed — i.e. it
falls under the existing "operator must not play / collude" assumption. Documented in
table.compact's header.

## Randomness: commit–reveal hardened against operator–player collusion

Base scheme: operator commits `H("seed", tableId, seed)` at table open, before any player
exists. `tableId` is inside the commitment (a post-review fix — see
[security-review.md](security-review.md) §2's High): `settle` publishes the seed by design, so
without the binding a seed accidentally reused at two tables would carry one commitment for both
and the first table's reveal would hand any observer the second, still-live table's entire future
randomness. The seat's join-time key commitment is bound the same way, `C_s = H("entkey",
tableId, sk_s)`, which closes cross-table seat linkability for a client that reuses a secret.

**The attack the naive scheme misses:** a player colluding with the operator knows the seed,
and if players choose per-turn entropy freely, the colluding player grinds their entropy at
turn time for perfect dice. Fixes, layered:

1. **Entropy is non-grindable at turn time.** At `join`, each player registers
   `C_s = H(tableId, sk_s)` for a fresh secret `sk_s`. Turn entropy is forced:
   `entropy_s(r) = H(sk_s, tableId, r)`, proven in-circuit against `C_s` (sk is a witness,
   entropy is disclosed). A player cannot pick their entropy per turn at all.
2. **Entropy is non-grindable at join time.** Rolls also mix in a **running game digest**:
   `gameDigest' = H(gameDigest, <event>)` updated by every `join` and every completed turn
   (`resolveRoll3`).
   As built, the digest is folded into the entropy one hash early
   (`mixEntropy(entropy_s(r), gameDigest)` feeding the measured `RollContext`) rather than
   widening the roll-hash input set — same security argument, keeps the measured dice
   circuits and their cross-check corpus intact. Because seat
   order = join order, every player's first roll digest includes joins that happened _after_
   theirs (or, for late seats, earlier turns' resolutions), so no one — even knowing the
   seed — can simulate their own future dice while still free to choose `sk_s`.
   A cheater would need to control **every** seat at the table, at which point they are
   playing themselves.
3. **The operator alone can never steer:** with the seed but no player's `sk`, every roll is
   fully determined the moment the turn comes up; there is nothing left to choose.

**Residual, documented honestly:** a seed-knowing operator can _selectively withhold_
resolution (griefing) when upcoming dice displease it. It cannot alter an outcome — only
freeze the table, which the timeout path converts into a refund. The operator must not seat
itself at tables it operates; the site says so, and anonymous seating (stretch) does not
change this analysis.

**Verifiability:** `settle` takes the seed as a **public** argument (asserted against the
commitment, disclosed on-chain). Anyone re-derives all rolls from the public log: joins,
entropies, digests, seed. The browser "verify this game" panel and the CLI verifier both
replay it with the same TS mirror of the dice ladder.

### Settlement past the table deadline — the seed check is waived

**The trap this closes.** A game that runs to completion lands in
(`Playing`, `WaitPlayer`, `round >= 14`). `claimTimeout` refuses it (it requires `round < 14`),
`abortTable` refuses it (`operatorStalled` requires `WaitResolve`), and `takeTurn` refuses it. So
`settle` was the only exit and `settle` needed the operator's seed — an operator that vanished, or
that simply lost its seed file, locked every stake **permanently**. That contradicted the design's
own core invariant, that every reachable state has a permissionless exit. Found by the security
review as its second Critical.

**The rule as built.** Once `blockTimeGt(lastActionAt + tableTimeoutSecs)` holds, `settle` no
longer requires the supplied seed to open the commitment. Everything else is unchanged: the winner
is still `winnerOfSeats` over the seats' public totals and finish times, the rake is still the
unique `q*100 + r == pot, r < 100`, the payouts still go to the addresses recorded at `join`.
Before the deadline the seed check is mandatory, exactly as before.

**Why that is sound.** Nothing about the payout ever depended on the seed. The winner is a function
of public ledger state that was built up by circuits which each already proved their dice against
the commitment as they ran. The seed reveal was never load-bearing for **soundness** — it is
load-bearing for **verifiability**.

**What is lost, stated honestly.** A force-settled game is **unverifiable after the fact**.
`revealedSeed` stays all-zero, and that zero is the marker: nobody — including the players — can
re-derive the rolls from the log, and the verifier must report the game as _unverified_ rather than
as _verification failed_. The dice were still proven correct one transaction at a time while the
game was live; what is missing is the ability to re-check that offline, later, without trusting the
chain's own verification. That is a real loss, and it is the right trade against losing the money.

**Why it pays the winner rather than refunding.** A refund would be strictly worse. An operator
that had also seated a player — which the threat model forbids but the contract cannot detect —
could watch that seat lose and then decline to settle, converting the loss into a refund. Paying
the winner the game already produced removes every incentive to reach the timeout at all.

Consumers must therefore treat `revealedSeed == 0` on a settled table as a meaningful state, never
as "not settled yet". See [client-rules.md](client-rules.md) rule 4.

**Never** per-roll outcome commitments (N commitments can all open to the same value).

## Ledger state (sketch — final layout follows circuit measurements)

- Constructor args: `tableId: Bytes<32>` (fresh random — `kernel.self()` is zeros in
  constructors), `tier: Uint<64>`, `maxSeats: Uint<8>`, `rakeAddress`,
  `seedCommitment: Bytes<32>`, timeout params `turnTimeoutSecs`, `tableTimeoutSecs`.
- `phase: enum { Filling, Playing, Abandoned, Settled, Aborted }` — **Abandoned** is entered
  when the last unforfeited seat forfeits: `settle` refuses it and `abortTable` refunds every
  seat with nothing to rake. (Paying the last seat standing was rejected: it would make
  _timing out last_ profitable.) A partial forfeit is deliberately asymmetric — the stake
  stays in the pot and the forfeited seat still competes with what it scored.
- `tier >= 100` is enforced at construction, so the 1% rake is never zero and no conditional
  payment path exists in `settle`.
- Per seat (≤6): player payout address, `C_s` entropy-key commitment, scorecard (13 packed
  category scores + filled bitmap), `upperTotal`, `total`, `yahtzeeBonuses`,
  `finishedAtTurn`, `forfeited: Boolean`
- `currentSeat`, `round` (0–12), `turnIndex` (global), `pendingTurn` (entropy, policy,
  awaiting-resolve flag, resolved dice of previous turn per seat)
- `gameDigest: Bytes<32>`
- `lastActionAt: Uint<64>` — **declared, not read**: the kernel exposes block-time
  _predicates_ only, no accessor, so each state-advancing call declares `now` and the circuit
  traps it in `(blockTime − timeSlackSecs(), blockTime]` plus monotonicity against the stored
  value. Deadlines stay exact; predicates are strict and seconds-based with no tolerance widening.
  `timeSlackSecs()` is **120 s** (it was 600) and the constructor refuses any `turnTimeoutSecs` or
  `tableTimeoutSecs` that is not strictly greater than `timeSlackSecs() * 4` = **480 s**. Both
  halves are a security fix, not tuning: on a hand-off transition (`takeTurn`, `resolveRoll3`,
  `claimTimeout`) the deadline a caller stamps belongs to the **next** actor, so under-declaring is
  free to the declarer and shrinks someone else's window. With a timeout comparable to the slack,
  the victim's deadline is already expired when they receive the turn and a permissionless
  `claimTimeout` forfeits them on the spot, cascading seat by seat. See
  [security-review.md](security-review.md) §2's Critical.
- `tier` is bounded **above** as well as below: `100 <= tier <= 10^15`. The upper bound keeps
  `abortTable`'s `tier * seatCount` inside `Uint<64>`, so an overflow can never deny the refund
  path while leaving `settle` working.
- `join` refuses a zero `payoutTo`. Both terminal circuits pay the address recorded at join and
  nothing else, so a seat that records zeros has staked into a burn.
- Pot custody: **native unshielded NIGHT, proven by Gate 0** — `join` calls
  `receiveUnshielded(nativeToken(), tier)` (the joining wallet consents by balancing);
  `settle`/`abortTable` call `sendUnshielded` to the payout addresses **recorded at join**,
  so no circuit ever needs to learn its caller and no external "who won" assertion exists —
  `settle` computes the winner in-circuit and pays that seat's stored address.
- Transaction-size floor: every circuit call must produce a ≥ ~8 KB transaction
  (`OutsideTimeToDismiss` — gate0-report.md). Real turn circuits likely clear it; `join`
  and `claimTimeout` may need fallible-phase padding writes. Verified per circuit in tests.

## Exported circuits (8 — deploy ceiling is ~11 circuits, measured upstream)

| circuit        | caller   | does                                                                                                                                                                                                                                                 |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join`         | player   | stake in, register `C_s`, take next seat; last join flips to Playing and stamps `lastActionAt`                                                                                                                                                       |
| `takeTurn`     | player   | score previous dice (category, joker rules), declare entropy `H(sk,tableId,r)` + policy for this turn; advances `lastActionAt`                                                                                                                       |
| `resolveRoll1` | operator | witness seed; derive roll 1; check the witnessed modal face; latch the mixed entropy and the hold mask                                                                                                                                               |
| `resolveRoll2` | operator | witness seed; reroll once under the latched mask                                                                                                                                                                                                     |
| `resolveRoll3` | operator | witness seed; reroll again; write the turn's dice, update the digest, advance the turn pointer                                                                                                                                                       |
| `settle`       | anyone   | all seats finished/forfeited; seed disclosed + checked (check **waived** past `tableTimeoutSecs`, leaving `revealedSeed` zero — see above); winner via tie-break; pay winner (pot − q) and rake (q) with witness-checked `q*100 + r == pot, r < 100` |
| `claimTimeout` | anyone   | only while waiting on a **player** (`WaitPlayer`): `blockTimeGt(lastActionAt + turnTimeoutSecs)` forfeits the stalled seat (remaining categories score 0, stake stays in the pot), advance turn                                                      |
| `abortTable`   | anyone   | `blockTimeGt(lastActionAt + tableTimeoutSecs)` while waiting on the **operator** (`WaitResolve`) or while `Filling` never completed: refund `tier` to every seated player, nothing to rake                                                           |

Authorisation is structural, not address-based: each `resolveRoll`'s authority is knowledge of
the seed (only the operator has it), re-checked at every step because every step derives a roll
from it; `takeTurn`'s is knowledge of the seat's `sk_s`;
`settle`/`claimTimeout`/`abortTable` are permissionless because their outcomes are fully
determined by on-chain state. No circuit ever needs the caller's address.

Turn sub-state: `WaitPlayer(currentSeat)` → takeTurn → `WaitResolve` → resolveRoll1 →
resolveRoll2 → resolveRoll3 → advance (skip forfeited seats; bounded scan over ≤6). The three
resolve steps are sequenced by a `rollStep` counter, each asserting the value it is the successor
of, so the operator cannot skip, repeat or reorder a roll. A stall at any of the three is still
`WaitResolve`, so `abortTable` covers them all without a new case — tested at all three stop
points. One consequence of the split is worth writing down: **every one of the three steps stamps
`lastActionAt`**, so an operator that takes each step at the last legal second holds a table for
roughly `3 × tableTimeoutSecs`. That is correct (each step is a genuine state advance) but it means
the parameter bounds one step's silence, not one turn's, and an operator SLA has to be written
against that. No division anywhere: `currentSeat`
and `round` advance incrementally, never derived from `turnIndex`.

Timeout deadlines use the sandwich discipline from the field notes: the claim is a
refund/forfeit, never compensation, so a tight deadline can't be farmed.

Scoring in-circuit: the 13-category mux over 5 dice, upper bonus at 63, Yahtzee bonus.
Whether the full forced-joker placement rule fits the circuit budget is decided with
measurements; if it must simplify (extra Yahtzee = +100 + any open category at full joker
value, no forced placement), the TS rules engine and the site rules text change with it —
the two must never diverge.

## Operator service consequences

- The seed is the thing whose loss costs a table its verifiability: persisted to disk at commit
  time, before the table opens, keyed by table address. Since the deadline-bypass fix its loss is
  survivable rather than fatal — the table can still be force-settled and the winner still paid —
  but the game becomes unreplayable, so the persistence discipline stands unchanged.
- Fresh `seed` and fresh `tableId` per table, both from a CSRNG. `tableId` is a domain separator on
  every roll hash, so a reused id replays another table's dice; the contract cannot generate it for
  itself because `kernel.self()` is zeros in a constructor.
- Timeout parameters must clear the constructor's floor of `timeSlackSecs() * 4` = 480 s. Full
  client and operator obligations are in [client-rules.md](client-rules.md).
- One wallet per daemon; resolves strictly sequential — and there are now three per turn, so an
  operator serves ~3× the transaction rate the original design assumed.
- The operator never holds discretion over an outcome — resolves are mechanical, timeouts are
  permissionless (anyone can call), and settlement is verifiable by anyone.
