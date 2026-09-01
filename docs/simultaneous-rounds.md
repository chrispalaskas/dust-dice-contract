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
  Measured by probe: [concurrency-probe.md](concurrency-probe.md).
- **Shared cells collide regardless of granularity.** If two players' turns both write "how many
  seats have finished this round", they conflict no matter how fine the binding is. That part is
  ours to design away, and it is why the layout below has no shared mutable cell on the player's
  path.

### The rule

**A player's `takeTurn` writes only that seat's own entries, and reads shared state read-only.**

- No `roundDoneCount`. The round is **derived**: `min(seatRound[s])` over seats that are still
  active. Six reads, no write.
- No digest fold on the player path. The once-per-round fold is the operator's (see below), and
  the operator is serialised on one wallet anyway.
- `pot` is not touched by `takeTurn`; stakes move only at `join`, `eliminate`, `settle` and
  `redeem`.

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

`closeRound` is separate rather than folded into `resolveRoll3` for a hard reason:
`resolveRoll1/2/3` already sit at **k=15 with zero headroom**, and the proof server has no SRS
above 15. Anything that grows the roll path makes the contract unprovable rather than slow.
Measure `k` for every circuit before writing the rest of this.

## Timeouts

`roundDeadline` is stamped when a round opens. After it passes, anyone may call `eliminate(seat)`
for any seat whose `seatRound` is still the open round. It is permissionless and pays the caller
nothing, so there is no incentive to grief and no reason to race.

Penalty arithmetic uses the witness-and-assert trick the rake already uses, because Compact has
no division: the caller supplies `q` and `rem` with `q * 13 + rem == stake * r` and `rem < 13`;
`q` is the penalty, `stake - q` becomes the seat's `redeemable`, and `pot` is reduced by
`stake - q` so the winner can never be paid an eliminated player's refund.

## Open question: when may an eliminated player redeem?

Two options, and this is the one thing still worth deciding before implementation.

**A. Only once the table reaches a terminal phase.** Simple and safe: nothing has been paid out
while the game is live, so decision 1's waiver ("penalties waived, everyone redeems in full") can
be applied uniformly at the end without having to claw back or top up anyone. The cost is that a
player eliminated in round 2 waits for the game to finish before seeing their money.

**B. Immediately on elimination.** Better for the player, but decision 1 then has to reconcile
with money already out the door: a seat that redeemed a penalised remainder in round 2 is owed a
top-up if the table later ends all-eliminated. That means tracking what each seat has already
withdrawn and paying deltas — more state, more paths, more ways to get custody wrong.

**Recommendation: A.** The simplicity is worth more than the latency, and it keeps the custody
invariant to a single line. Revisit if playtesting says otherwise.
