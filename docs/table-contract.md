# Table contract design

One deployment per table. This document is the state-machine and randomness design as **shipped**.

> **This document was rewritten.** It previously described the SEAT-CURSOR model with
> PRE-DECLARED HOLD POLICIES, in which five players waited while one played and each turn's
> rerolls were driven by one of six deterministic rules chosen before any dice existed. Both are
> gone. The redesign that replaced the cursor is
> [simultaneous-rounds.md](simultaneous-rounds.md), which is still the authoritative note on
> _why_; interactive holds landed on top of it. What survived unchanged: the commit–reveal
> randomness scheme, forced per-round entropy, native unshielded NIGHT custody, the
> witness-checked rake, and the rule that every reachable state has a permissionless exit.

Companion documents:

- [table-interface.md](table-interface.md) — the exact circuit signatures and argument
  encodings. **If you are writing a client, read that, not this.**
- [table-circuit.md](table-circuit.md) §0 — measured k, instruction counts, key sizes.
- [simultaneous-rounds.md](simultaneous-rounds.md) — why the round model looks like this.
- [concurrency-probe.md](concurrency-probe.md) — the measured platform behaviour it rests on.

---

## The shape of a game

Thirteen rounds, numbered 0..12, one scoring category each. **Every seat plays every round
independently**; the round advances when all of them have finished. There is no turn cursor and
no waiting.

Within a round, a seat's turn is:

1. **open** — the player proves knowledge of their seat secret and declares this round's forced
   entropy.
2. **roll 1** — the operator derives five dice, proving them against a seed commitment made
   before any player existed.
3. **hold** — the player names the dice to keep, having seen them.
4. **roll 2** — the operator rerolls the rest.
5. **hold**, **roll 3** — again.
6. **score** — the player takes a category.

**The player may score at any point after a roll has resolved**, skipping the remaining holds and
rolls. That is a full three-roll turn at 4 player + 3 operator transactions, and a stop-after-roll-1
turn at 2 + 1. The arithmetic is in [table-interface.md](table-interface.md) §9.

### Why the category is no longer pipelined

The cursor model made `takeTurn` at round _r_ score the dice resolved at round _r−1_, and it
bought a fourteenth score-only round plus two sentinel cases at the ends. That existed for a
compiler reason, not a game reason: a circuit that both derived dice and scored them could not be
compiled at all ([bugs-found.md #1](bugs-found.md) — cost is re-reads × DAG size, and a merged die
read forty times by `applyScore` never terminates).

An interactive turn already splits derivation from scoring across transactions: a resolve writes
the dice to the ledger and `playerMove(score)` reads them back as a ledger **leaf**. So the
constraint is satisfied without the pipeline, and a seat scores the dice it just rolled. Thirteen
rounds, no sentinels, no round without a category.

### Why the holds are interactive

Pre-declaring the reroll rule cost the game its most-played decision. It also cost the contract a
witnessed modal face and a canonical-modality check that existed purely because a 6-way argmax
over face counts could not be computed in-circuit. All of that is deleted. A hold is five bits
the player sends after looking at the dice.

The price is transactions — see the residual on collusion below, and the cost table in the
interface note.

---

## Randomness: commit–reveal, hardened against operator–player collusion

The operator commits `H("seed", tableId, seed)` at table open, before any player exists.
`tableId` is inside the commitment: `settle` publishes the seed by design, so without the binding
a seed accidentally reused at two tables would carry one commitment for both, and the first
table's reveal would hand any observer the second, still-live table's entire future randomness.
The seat's join-time key commitment is bound the same way, `C_s = H("entkey", tableId, sk_s)`,
which closes cross-table seat linkability for a client that reuses a secret.

**The attack the naive scheme misses:** a player colluding with the operator knows the seed, and
if players choose per-turn entropy freely, they grind it for perfect dice. Fixes, layered:

1. **Entropy is non-grindable at turn time.** At `join` each player registers `C_s`, and turn
   entropy is forced: `entropy_s(r) = H(sk_s, tableId, r)`, proven in-circuit against `C_s` on
   every `playerMove`. A player cannot pick their entropy at all.
2. **Entropy is non-grindable at join time.** Rolls mix in a running digest that absorbs every
   `join` and every completed round, so a player choosing `sk_s` at join time cannot know the
   digest their later rolls will hash against.
3. **The operator alone can never steer:** with the seed but no player's `sk`, every roll is
   fully determined the moment the round opens.

### The digest is frozen per round — a requirement, not a simplification

This is the one thing simultaneous rounds _had_ to change. Under the cursor, resolves happened in
fixed seat order and a running digest gave the operator no ordering discretion. With six seats
live at once, transactions land in whatever order the chain picks — and a digest that kept
folding results as they landed would let the operator choose that order for its own resolves,
feeding every subsequent roll. That is exactly the influence the commit–reveal scheme exists to
deny it.

So every seat in round _r_ derives its rolls from `roundDigest` **as it stood when round _r_
opened**, and `closeRound` advances it once, at the boundary, folding the round's results **in
seat order**:

```
roundDigest' = H("yahtzee:v1:round", roundDigest, r, seatCount, [ {dice, out} × 6 ])
```

All six slots are folded, seated or not. No participant's dice depend on who submitted first, and
an offline verifier does not need to know the submission order at all.

**Every seat's dice stream is distinct because of `sk_s` and nothing else.** The roll context has
no seat field; separation is entirely in the mixed entropy. `join` refuses a second seat for a
`C_s` already registered, which is what makes that sound rather than merely likely.

### The reroll consumes the fresh roll left to right

If the player holds positions 0 and 3, the two dice they get back are `fresh[0]` and `fresh[1]`,
not `fresh[1]` and `fresh[2]`. This closes a divergence the previous design documented and lived
with: `api/src/policies.ts` always modelled rerolls as a left-to-right stream while the circuit
merged positionally, and only one of the two could be the settlement verifier. They now agree.
Cost: ten conditional selects, measured before being accepted because the resolve circuits sit at
the SRS ceiling.

### Residual, and it GREW

A seed-knowing player with interactive holds can compute roll 2 and roll 3 for **all 32 hold
masks** before choosing, and again after roll 2. That is an optimal decision under perfect
information about the future, taken twice a turn, thirteen times a game — strictly stronger than
the pre-declared design's best-of-eleven policy preview, whose "bounded" framing no longer
applies and has been removed from the contract header.

It still requires the seed, so it still falls under the assumption the design already relies on:
**the operator must not seat itself at tables it operates, and must not leak the seed.** Under
that assumption the exposure is zero. If it is violated, interactive holds make the violation
worth substantially more, and the site's threat model should say so.

The operator's own residual is unchanged: it can _selectively withhold_ resolution when upcoming
dice displease it. It cannot alter an outcome, only freeze the table, which the timeout path
converts into a refund.

**Never** per-roll outcome commitments (N commitments can all open to the same value).

### Settlement past the table deadline — the seed check is waived

A game that runs to completion lands in (`playing`, `openRound == 13`). Every other circuit
refuses that state, so `settle` is the only exit — and an operator that vanished, or simply lost
its seed file, would lock every stake permanently. Once
`blockTimeGt(roundDeadline + tableTimeoutSecs)` holds, `settle` no longer requires the seed to
open the commitment.

Sound because nothing about the payout ever depended on the seed: the winner is a function of
public ledger state built up by circuits that each already proved their dice against the
commitment as they ran. The seed reveal is load-bearing for **verifiability**, not soundness.

What is lost, plainly: a force-settled game is **unverifiable after the fact**. `revealedSeed`
stays all-zero, and that zero is the marker — the verifier must report the game as _unverified_,
never as _verification failed_. Consumers must treat `revealedSeed == 0` on a settled table as a
meaningful state, never as "not settled yet".

It pays the winner rather than refunding because a refund would be strictly worse: an operator
that had also seated a player could watch that seat lose and decline to settle, converting the
loss into a refund.

---

## Elimination is economic, not absolute

A seat that lets the round deadline pass while owing a move is eliminated by anyone, permanently.

- **Penalty `stake × (r + 1) / 13`**, where `r` is the contract's 0-based round. A thirteenth for
  a seat that never played at all, the whole stake for one that quits in the last round. The
  forfeited share **stays in the pot** and goes to the winner; the rest becomes the seat's
  `redeemable` and leaves the pot, so the winner can never be paid an eliminated player's refund.
  Compact has no division, so the split is a witness-and-assert Euclidean identity with exactly
  one solution.
- **Eliminated seats cannot win.** They have already been handed back `tier − penalty`; letting
  one also take the pot would pay it twice. This is a change from the cursor model, where a
  forfeited seat still competed with what it had scored.
- **Only the player's silence counts.** A turn has seven sub-states; the even ones are the
  player's to discharge and the odd ones the operator's. `eliminate` covers all four even
  states — never opened, and abandoned after each of the three rolls — and refuses all three odd
  ones. Punishing a player for the operator's failure to resolve would punish the wrong party;
  `abortTable` is the remedy for that, and it refunds everyone.
- **All seats eliminated ⇒ penalties waived.** Penalties exist to compensate the players who kept
  playing; when nobody did there is nobody to compensate. Every seat redeems its full stake less
  the 1% rake — and the rake **is** still paid, because the operator did its work regardless.
  Applied by a single permissionless `abortTable` call, which is why `abandoned` is a _pending_
  terminal state rather than a redeemable one.

---

## Custody

```
contract balance  ==  pot  +  SUM(seatRedeemable)
```

`pot` is the winner's; `seatRedeemable[s]` is seat `s`'s personally and is paid only by `redeem`,
only to the address recorded at `join`. Keeping the two apart is what makes an eliminated
player's money impossible to award to the winner by accident. Asserted in-circuit by `settle`
and `abortTable`, which are the two circuits that zero the pot, and by `eliminate`, which is the
one that moves money between them.

**`redeem` is refused while the table is live.** Nothing is paid out mid-game, so decision 1's
waiver can be applied uniformly at the end with no claw-back and no top-up. The cost is latency
for an eliminated player; accepted deliberately, because the alternative needs per-seat withdrawal
history and delta payments — more state and more ways to get custody wrong, for money that is not
at risk either way.

`abortTable` **pays nobody directly**: it converts the pot into per-seat refunds and leaves the
sending to `redeem`. One payout path instead of two, and no risk of sending to a pre-inserted
zero address.

The contract never asserts its own token balance. `unshieldedBalance(nativeToken())` returns 0
under compact-runtime 0.19.0 whatever `receiveUnshielded` was handed
([bugs-found.md #11](bugs-found.md)), so custody is tracked by the contract's own bookkeeping and
the ledger-vs-bookkeeping cross-check moves to the E2E devnet run.

---

## Concurrency

The constraint that shapes the whole state layout, and it is measured rather than assumed
([concurrency-probe.md](concurrency-probe.md), 96 real transactions):

- Binding is **per-read**. A transaction is rejected only if a ledger value its transcript
  actually _read_ has changed since it was proved.
- **A `Map.lookup` binds exactly as a scalar read does.** Per-seat storage is necessary but not
  sufficient — a circuit that writes one seat but reads all six collides with all six.
- Two transactions writing the **same** map key both land, last-write-wins, silently. So a seat's
  entries are only ever written by a transaction that proved knowledge of that seat's `sk_s`.

**The rule: a player's move writes only its own seat's entries and read-modify-writes no shared
scalar.** It reads `phase`, `openRound`, `seatCount` and `tableId` — all sealed or frozen for the
duration of a round — plus its own four map entries. `stampTime()`'s shared `lastActionAt`, which
seven of the eight old circuits wrote, is gone; the per-round `roundDeadline`, written once by
`closeRound`, replaces it. Only `join` and `closeRound` declare a time at all.

This is checked **mechanically against the compiled transcript** on every test run
(`contract/src/test/ledger-access.ts`), not asserted in prose — a simulator runs one circuit at a
time and can never observe a conflict.

`pot` and `activeSeats` are the only shared accumulators, both written by `eliminate` only. Two
concurrent eliminations conflict and one retries, which is correct and off the player's path.

---

## Timeouts, and the exit from every state

Deadlines are exact: `blockTimeGt(stored)` is evaluated by the kernel against real block time.
Only the two circuits that _stamp_ a deadline are told the time, and they pin the claim between
`blockTimeGte(now)` and `blockTimeLt(now + 120)`.

`closeRound` stamps the deadline the **next** round's players are judged against, and it is
permissionless, so a hostile caller can shave up to the slack off everyone's window for free.
That is [security-review.md](security-review.md)'s Critical C1, closed the same way as before:
the slack is 120 s and the constructor refuses any timeout not strictly greater than
`120 × 4 = 480 s`, so the most a hostile declarer can take is a quarter of the window. The
attack surface shrank from seven circuits to two.

`turnTimeoutSecs` covers a **whole round**, not a move — up to four player transactions and three
operator ones per seat. An operator SLA has to be written against that.

| state                                    | permissionless exit                                  |
| ---------------------------------------- | ---------------------------------------------------- |
| filling, never fills                     | `abortTable` past `roundDeadline`                    |
| playing, a seat owes a move              | `eliminate` past `roundDeadline`, then `closeRound`  |
| playing, every seat has finished a round | `closeRound` — not gated by any deadline             |
| playing, a seat awaits the operator      | `abortTable` past `roundDeadline + tableTimeoutSecs` |
| abandoned (all eliminated)               | `abortTable`, no waiting                             |
| playing, `openRound == 13`               | `settle`, with the seed waived past the deadline     |
| settled / aborted                        | `redeem`, per seat                                   |

**`abortTable` while playing requires some seat to be waiting on the operator**, and that
condition is load-bearing rather than decoration. Without it a losing player could stop playing,
let both deadlines pass and abort the game into a full refund. With it, a table where every
seat's next move is its own has only `eliminate` and `closeRound` as exits — both permissionless
and both available a whole table-timeout earlier — so the stall is answered by the remedy that
costs the staller a penalty, not by the one that gives them their money back.

---

## Operator service consequences

- The seed is persisted to disk at commit time, before the table opens, keyed by table address.
  Since the deadline-bypass fix its loss is survivable rather than fatal, but the game becomes
  unreplayable, so the discipline stands.
- Fresh `seed` and fresh `tableId` per table, both from a CSRNG. `tableId` is a domain separator
  on every roll hash; the contract cannot generate it because `kernel.self()` is zeros in a
  constructor.
- **The operator is now the bottleneck, and more so than before.** Player transactions are
  parallel across seats; the operator's are not — one wallet's spends must be sequential. At six
  seats it submits up to 18 resolves per round. An operator that wants the full width of
  simultaneous rounds needs a pool of wallets, one per seat.
- The operator never holds discretion over an outcome: resolves are mechanical, the seat it
  resolves first changes nobody's dice, timeouts are permissionless, and settlement is verifiable
  by anyone.
