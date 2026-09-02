# Simultaneous rounds — design note

A redesign of the turn model: instead of a seat cursor that makes five players wait while one
plays, every seat plays each round independently and the round advances when they have all
finished. Elimination becomes economic rather than absolute — a player who stops responding
forfeits a share of their stake that grows with how far the game has run, and redeems the rest.

Status: **design, not built.** The current contract is the cursor model
([table-contract.md](table-contract.md)). This note is what replaces it.

## What it buys, and what it does not

It buys ergonomics, and they are worth a lot: players think and act in parallel instead of
idling through everyone else's turns, and a two-browser test stops requiring a wallet switch
between every move.

It does **not** shorten a game. The chain work is identical — six players still submit six
`takeTurn`s and the operator still submits eighteen resolves per round, all serialised on one
chain at ~19 s each (docs/e2e-report.md). A six-seat game stays near 100 minutes. Judge the
change on ergonomics; anything else would be a claim the measurements do not support.

## Decisions taken

1. **All seats eliminated ⇒ penalties waived, everyone redeems in full, except the 1% rake,
   which is still paid to the dev address.** Penalties exist to compensate the players who kept
   playing; when nobody did, there is no one to compensate. The rake is unconditional because
   the operator did its work regardless.
2. **Elimination is permanent.** A seat that misses a round is out of the game — the round
   advances without it, and its scorecard stands as-is for the record. It does not resume.
3. **The penalty is `stake × r / 13`** where `r` is the round the seat failed in: 1/13 for
   round 1, all of it for round 13. The more you have played, the more you cost the others by
   leaving. The forfeited share stays in the pot and goes to the winner.
4. **Turns must not conflict.** See "Concurrency" below — this is the constraint that shapes
   the whole state layout.

## Concurrency: why the state layout looks the way it does

A circuit's proof commits to the contract state it was built against. The transaction carries a
transcript — "given this state, these reads returned these values, these writes follow" — and
the node applies it against whatever state exists at inclusion time. It is optimistic
concurrency, not a lock: if what the transcript depended on has moved, the transaction fails.

Two consequences, and only the first is the platform's:

- **Binding granularity** decides whether two seats writing different map keys collide.
  **Measured** ([concurrency-probe.md](concurrency-probe.md)): binding is **per-read** — a
  transaction is rejected only if a ledger value its transcript actually _read_ has changed
  since it was proved. Six wallets writing six different map keys all landed in a single block.
  A blind write binds to nothing; a read-modify-write on a shared scalar binds to that scalar
  and exactly one of the racers survives (`ReadMismatch`); a `Counter.increment` commutes and
  both land.
- **Shared cells collide regardless of granularity.** If two players' turns both write "how many
  seats have finished this round", they conflict no matter how fine the binding is. That part is
  ours to design away, and it is why the layout below has no shared mutable cell on the player's
  path.

### The rule

**A player's `takeTurn` writes only that seat's own entries, and reads shared state read-only.**

- No `roundDoneCount`. **And the round is NOT derived by reading every seat** — that was the
  first draft of this note and the probe shows it is wrong: `Map.lookup` binds exactly as a
  scalar read does, so a turn that reads all six seats' progress collides with all five other
  turns. Instead the open round is a single scalar written **only** by `closeRound`. Reading a
  shared value is free of conflict as long as it does not change during the round — which is
  precisely the property `openRound`, `roundDigest` and `roundDeadline` have.
- No digest fold on the player path. The once-per-round fold is the operator's (see below), and
  the operator is serialised on one wallet anyway.
- `pot` is not touched by `takeTurn`; stakes move only at `join`, `eliminate`, `settle` and
  `redeem`.
- Nothing on the player path may read-modify-write a shared scalar. `stampTime()` does exactly
  that to `lastActionAt` today, in 7 of 8 circuits, and would serialise every turn on its own.
  The per-round `roundDeadline`, written once by `closeRound`, replaces it.
- Where a shared accumulator is genuinely wanted, use `Counter` — measured to commute, because
  it compiles to a native add that never reads the value back.

**One silent hazard:** two transactions writing the _same_ map key both land, last-write-wins,
with no error — a lost move rather than a rejection. Seat keys must therefore be derived from
the actor's proven secret, never from anything two actors could compute identically.

## The operator can no longer choose the dice

This is the security regression the change would introduce if done naively, and the reason the
digest handling changes.

Today resolves happen in fixed seat order, so the operator has no ordering discretion. Under
simultaneous rounds, transactions land in whatever order the chain picks — and if the running
`gameDigest` keeps folding results as they land, the operator chooses that order for its own
resolves, and the digest feeds every subsequent roll. That hands it exactly the influence over
outcomes the commit–reveal scheme exists to deny it.

**Fix, which ships with the change or not at all: freeze the digest per round.**

- Every seat in round `r` derives its rolls from `roundDigest[r]`, fixed when the round opened.
- `roundDigest[r+1] = H(roundDigest[r], round r's results in SEAT order)` — computed once, at
  the round boundary, from data that is complete and ordered by seat index rather than by
  landing time.

Then no participant's dice depend on who submitted first, and the operator's only remaining
power is the one it already had: to stall, which the timeout path converts into a refund.

## State (sketch)

Per seat: `payoutTo`, `keyCommit`, scorecard, `seatRound` (the next round this seat owes),
`eliminated`, `redeemable`. Per table: `roundDigest`, `roundDeadline`, `pot`, plus the existing
sealed config.

**Custody invariant, checkable from outside:** the contract's unshielded balance equals
`pot + Σ redeemable`. `settle` pays only out of `pot`; `redeem` pays only out of a seat's own
`redeemable`. Keeping the two separate is what makes an eliminated player's money impossible to
award to the winner by accident.

## Circuits

`join`, `takeTurn`, `resolveRoll1/2/3`, `closeRound`, `eliminate`, `settle`, `redeem`,
`abortTable` — **ten exported**, against a ceiling measured at 11–12 on this toolchain. That is
real but tight, and it is a reason not to add an eleventh casually.

> **Corrected by measurement.** The 11–12 figure was inherited and untested. The real ceiling on
> midnight-node 2.0.0-rc.4 is **nine** exported circuits: 9 deploys, 10 is refused with
> `Transaction would exhaust the block limits`. It is really a limit on total verifier-key bytes
> (19,071 lands, 21,190 does not), which couples it to `k` — a verifier key is 1,351 bytes at
> k ≤ 12 and 2,119 at k ≥ 13, so clearing the admission floor costs deploy budget. As shipped the
> contract has nine circuits: the three player moves are merged into `playerMove` and the two
> rerolls into `resolveReroll`. See [bugs-found.md](bugs-found.md) #16 and
> [table-circuit.md](table-circuit.md) §0.7.

`closeRound` is separate rather than folded into a resolve for a hard reason:
`resolveRoll1/2/3` already sit at **k=15 with zero headroom**, and the proof server has no SRS
above 15. Anything that grows the roll path makes the contract unprovable rather than slow.
Measure `k` for every circuit before writing the rest of this.

### Every circuit has a k FLOOR as well as a ceiling

Found the hard way in live play, and it invalidates the advice previously written into
`table.compact`'s decision 8. `claimTimeout` (k=11) is rejected by the node with
`OutsideTimeToDismiss`: measured at 7,455–7,463 bytes against a required 8,269. Nothing else
ever fails — `abortTable` at k=12 and everything above land every time — and across the whole
run `claimTimeout` is the _only_ circuit that has ever hit the floor, 1,610 times.

**Raising the ledger padding does not fix it.** It was raised 2 KB → 4 KB and the transaction
grew by a few hundred bytes, not 2,048: `pad(n, "…")` is a short tag followed by zero fill, so
it costs almost nothing once serialised. The byte that matters is the **proof**, whose size
scales with k. The admission floor is therefore effectively a _proof-size_ floor, and the only
reliable lever is k — give a too-small circuit real cryptographic work until it clears k=12,
with margin, while staying at or under 15.

For this redesign: `eliminate` and `redeem` are both small circuits doing little work, exactly
the shape that lands under the floor. Measure their k before assuming they are fine, and give
them ballast if they come in below 13.

## Timeouts

`roundDeadline` is stamped when a round opens. After it passes, anyone may call `eliminate(seat)`
for any seat whose `seatRound` is still the open round. It is permissionless and pays the caller
nothing, so there is no incentive to grief and no reason to race.

Penalty arithmetic uses the witness-and-assert trick the rake already uses, because Compact has
no division: the caller supplies `q` and `rem` with `q * 13 + rem == stake * r` and `rem < 13`;
`q` is the penalty, `stake - q` becomes the seat's `redeemable`, and `pot` is reduced by
`stake - q` so the winner can never be paid an eliminated player's refund.

## When may an eliminated player redeem? — decided: only once the table finishes

`redeem` is refused while the table is live and allowed once it reaches a terminal phase
(settled, aborted, or all-eliminated). Nothing is paid out mid-game, so decision 1's waiver can
be applied uniformly at the end with no claw-back and no top-up, and the custody invariant stays
a single line: balance == pot + Σ redeemable, with `settle` paying only from `pot` and `redeem`
only from a seat's own `redeemable`.

The cost is latency for the eliminated player: someone knocked out in round 2 waits for the game
to end before withdrawing. Accepted deliberately — the alternative needs per-seat withdrawal
history and delta payments, which is more state and more ways to get custody wrong, for money
that is not at risk either way.

## Future version: off-chain interactivity, one settlement transaction per turn

Sketched by the product owner and analysed here so v1 keeps the seam for it. The goal: the
player's whole turn — both hold decisions and the category — lands on chain as **one**
transaction instead of four.

Why one transaction cannot simply carry the hold masks today: the second mask must be **bound
before roll 3 is revealed**, and roll 2 must be revealed before the first mask can be chosen.
A list like `[mask1, mask2, category]` cannot be written before the information it reacts to
exists — the transactions in v1 are not an encoding, they are the interaction itself.

The v2 shape moves that interaction off-chain and keeps only settlement on-chain:

1. Player opens the turn on-chain (entropy commitment, as today).
2. Off-chain, with the operator: player sends `C1 = commit(mask1)` (a hash commitment — a full
   ZK proof per step is unnecessary weight; the one settlement proof verifies every opening);
   operator replies with roll 2; player sends `C2`; operator replies with roll 3.
3. Player submits ONE transaction opening `C1, C2` plus the category; the operator's resolves
   verify the dice against those masks exactly as v1's do.

What makes it sound, and what it leans on:

- **The operator's one-shot reveal discipline is load-bearing.** Roll 2's values depend on
  which positions mask1 rerolls, so a player allowed to probe multiple masks reconstructs the
  whole stream and plays perfectly. An honest operator reveals once per commitment; a colluding
  operator could allow probing — but a colluding operator can already leak the seed outright,
  which is strictly stronger, so this adds nothing NEW to the collusion residual.
- **Deception at decision time** (operator shows false dice off-chain; the on-chain truth then
  makes the player's committed masks retroactively bad) is the new vector. Two mitigations, in
  order of strength: have the operator hand over the same ZK proof it will later submit, and
  verify it locally in the browser before deciding (trustless, but needs browser-side proof
  verification — the real engineering cost of v2); or accept operator honesty here with
  after-the-fact detectability, which is weaker than v1 and must be said plainly if chosen.
- Cost: full turn drops from 4 player + 3 operator to **2 player + 3 operator**, and the
  interactive part becomes instant instead of ~19 s per step. The operator's three resolves
  remain the floor; they no longer interleave with the player.

v1 keeps the seam deliberately: hold masks live in the seat's own ledger cells and the resolves
read them from there, so v2 replaces one player circuit and touches nothing else.
