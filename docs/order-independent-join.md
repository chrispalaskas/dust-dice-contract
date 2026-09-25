# Order-independent joins — design note

Make concurrent `join`s to one table all land, instead of one per block with the rest rejected.
Status: **design, not built, not probed.** Target: the next ledger-9 table contract (the
`dust-dice-vrf` line and `fast-dleq-check`, whose `join` differs from `dust-dice-vrf` by one line —
it also stamps `roundOpenedAt`). Not for ledger 8: nothing about contention has been measured
there, and ledger 8's tables would all have to be redeployed for it.

## Why bother

On dustdice.xyz (preprod, ledger 8) on 2026-09-25, two browsers joined the same empty table
15 s apart. Both joins were built against `seatCount == 0`. One landed; the other was
rejected, and the join panel rebuilt it — a second proof and a **second wallet approval** — and
the player waited 50 s instead of 25 s. The join panel now warns before that second prompt,
but the conflict itself remains: **at most one join per table per block**,
and every loser proves twice and approves twice.

That's a nuisance with a handful of players. On a public launch it is the first thing everyone
touches: the lobby offers one open table per tier, so a crowd arriving together storms the same
contract, and all but one per block get "approve again". A free-play mainnet launch is the case
this is for.

## Why joins conflict — the measured rule

A transaction's proof commits to every ledger value its transcript READ; the node re-executes the
transcript at inclusion and rejects it if any read value has moved (`ReadMismatch`). Binding is
**per read** — not per write, and not whole-state. Measured on ledger 9.1, isolated devnet, 96
attempts ([concurrency-probe.md](concurrency-probe.md)):

- Disjoint map keys, no read in common: both land in one block (A, F), and six wallets writing
  six keys landed 6/6 in one block, three rounds running (G).
- A shared read-modify-write: exactly one survivor, every time (C).
- `Counter.increment` commutes — both increments apply (E).
- **The same key written twice with no guarding read: both land, last write wins, no error (B).**
- `Map.lookup` emits a `popeq`, i.e. it binds exactly like a scalar read.

[security-review.md §4](security-review.md) calls a join storm "opaque whole-state proof-mismatch
rejections… Not fixable in-contract". That was written the day _before_ the probe; the probe
measured per-read binding. The conclusion was right for the contract as written — every join
does read-modify-write shared fields — but the stated cause is not, and with it goes "not
fixable". §4 should be amended when this is built.

What today's `join` (`contract/src/table.compact`, `export circuit join`) reads and writes, and
what each costs:

| Field                                        | Today                                         | Conflicts with another join?   | In this design                                       |
| -------------------------------------------- | --------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `phase`                                      | read                                          | no — only start/abort write it | read, unchanged                                      |
| `seatCount`                                  | read-modify-write; `seat = seatCount` (:1505) | **yes**                        | not touched until the start                          |
| `activeSeats`                                | read-modify-write; auto-start test (:1530)    | **yes**                        | not touched until the start                          |
| `pot`                                        | `pot = pot + tier` (:1518)                    | **yes**                        | not touched; the start sets it                       |
| `roundDigest`                                | folded per join, in landing order (:1523)     | **yes**                        | not touched; the start folds all seats in slot order |
| `seatIdentity[seat]`                         | inserted at `seatCount`                       | via `seatCount`                | lookup + overwrite of the claimed slot only          |
| `seatCard`, `seatReceipt`, `vrfAnswer[seat]` | inserted                                      | gas, see "risks"               | created by the start instead                         |
| `joinedKeys`                                 | `member` + `insert` of the commitment         | untested for distinct keys     | unchanged — must be probed                           |
| `fillOpenedAt`, `roundDeadline`              | written                                       | no — write-only                | written, last write wins (harmless)                  |

## The design

**1. Claim a slot, not "the next seat".** `join(slot, payoutTo, now)`. The constructor
pre-inserts `seatIdentity[0..seatLimit)` with the zero address, meaning "free". `join` asserts
`seatIdentity.lookup(slot).addr == default<UserAddress>` and overwrites that one cell. The
lookup is the guard: two joins claiming the same slot both read it, so exactly one survives with
a `ReadMismatch`. **The read is mandatory.** Without it, two joins to one slot would both land
and one player's identity would silently overwrite the other's — probe experiment B, the hazard
today's `join` comment exists to prevent. Two joins to different slots read nothing in common
and both land.

**2. Capacity is structural.** Slots run `0..seatLimit`, so a table cannot take more than
`seatLimit` joins without anyone counting them: `assert(slot < seatLimit)` plus "the slot is
free" replaces both `seatCount < maxSeats()` and `activeSeats < seatLimit`.

**3. Nothing shared is read-modify-written while filling.** `pot`, `seatCount`, `activeSeats`
and `roundDigest` stay at their constructor values until the start. The stake still arrives at
each join (`receiveUnshielded`); the pot _field_ is the ledger's account of it, and the start
sets it to `tier × seated`, which the invariant `pot + Σredeemable + Σpaid == tier × seatCount`
then holds from.

**4. The start computes everything from the slots, in slot order.** `abortTable`'s start branch
(the "fourth case", :2434) already starts a filling table "with whoever is there". It gains the
work `join` used to do incrementally:

- count the occupied slots → `seatCount`, `activeSeats`;
- set `pot = tier × seated`;
- fold `roundDigest` over the occupied slots **in slot order** — the same principle as
  `closeRound`'s round digest, which is ordered "by seat index rather than by landing time"
  precisely so that no participant's dice depend on who submitted first (header §2);
- create the heavy per-seat cells (see "risks");
- mark each empty slot the way a seat that left before the start is marked, so every
  share-out and every loop that already skips such seats (`leftBeforeStart`, :697) skips it too.
  That reuse is what keeps this from touching every loop in the file.

**5. A full table starts through that branch, not through the last join.** A join can no longer
know it is the last, because knowing would mean reading a shared count. The branch accepts a
full table at once (no early-start clock), and the operator's daemon calls it the moment every
slot is taken; so can any seated player (the lobby's "Start now"). Cost: one more transaction per
table, paid by whoever starts it, and a few seconds. No new circuit: the table stays at the
nine-circuit deploy ceiling.

**6. The client picks a random free slot.** Two joiners picking at the same moment collide with
probability 1/f, where f is the number of free slots — 1/6 on a fresh six-seat table instead of
certainty. The last free slot is still contested by everyone who wants it; that is inherent in
there being one seat left. The join panel's race retry stays, and now retries with another free
slot.

## What it keeps

- **The stake is never at risk.** Every assert and substantive write of `join` is in the
  guaranteed phase (security-review.md §4), and a guaranteed-phase read conflict is rejected
  before inclusion (measured, ledger 9) — so a join that loses a slot race, or races a start,
  applies nothing. A join racing a start:
  if the start lands first, the join's `phase` read fails; if the join lands first, the start's
  read of that slot fails and it is retried. Neither half-applies.
- **One seat per key.** `joinedKeys` still refuses a second seat for a commitment already
  registered — provided `Set.member` behaves like `Map.lookup` (see "open questions").
- **The digest property.** Today no joiner can know the digest their rolls will hash against,
  because it absorbs every later join. Folding at the start preserves that: the digest is fixed
  only once every seat is in. The last joiner knows every earlier seat's commitment in both
  designs. Choosing a slot adds a few orderings to the last joiner's options, next to the
  unbounded choice of `sk` it already has. Whether either buys anything depends on the dice
  scheme that ships — the blind VRF on `dust-dice-vrf`, seat-contributed reveals on
  `fast-dleq-check` — and **the review has to redo this argument for that scheme**, not take this
  paragraph's word for it.

## Risks, in the order they could kill it

1. **Two `receiveUnshielded` calls into one contract in one block — untested.** Every join
   receives its stake. If the contract's balance update binds like a read, concurrent joins
   conflict on it and this design buys nothing. Probe this first; everything else is moot if it
   fails.
2. **Gas, not reads (bugs-found #36).** Measured on ledger 9: two settlements built on one state
   touched disjoint cells, the first landed, and the second failed `OutOfGas` three times,
   because the first had made a map heavier than the second's budget declared. Concurrent joins
   inserting _new_ keys into the same maps are exactly that shape. Overwriting pre-inserted
   cells should keep the cost flat, which is why `seatIdentity` is pre-inserted in (1) — but the
   guaranteed transcript cannot be inflated by the `MIDNIGHT_GAS_FACTOR` patch, so this needs a
   measurement, not an argument.
3. **Pre-inserting everything does not fit.** The deploy transaction was rejected ("would
   exhaust the block limits") when the constructor wrote all six scorecards (27 fields each),
   identities and receipts — the reason those three maps are inserted at `join` today (see the
   constructor). So only the small cell is pre-inserted here: six `SeatIdentity`s, 64 bytes
   each; check the deploy still lands. The heavy cells (`seatCard`, `seatReceipt`, `vrfAnswer`)
   move to the start. The start is serialised, so it has no concurrency problem — but it becomes
   the heaviest transaction the table makes: it must fit a block, and `abortTable` must stay
   within the proof server's SRS (`playerMove` is already k=16 on `dust-dice-vrf`).
4. **Sparse slots after an early start.** A table started with two players might hold slots 0
   and 3. Anything that assumes seats `0..seatCount` are dense must use "occupied and not left"
   instead. Point (4) keeps that to the places that do not already skip leavers.
   `contract/src/test/ledger-access.ts` re-derives each circuit's reads from the compiled transcript and
   should gain an assertion that `join` reads only `phase`, its own slot, its own `joinedKeys`
   entry and constants.

## Open decisions

1. **A seat that leaves before the start** — does its slot free up? Today a leaver keeps its slot
   and the table may use more slots than its limit. Here slots are the limit: keeping the slot
   shrinks the table by one; freeing it means moving the leaver's refund out of the per-slot
   `seatRedeemable` into something keyed by commitment, which `redeem` (slot-indexed today)
   would have to read. The simplest is to keep the slot.
2. **Who starts a full table.** Proposed: the operator immediately, and any seated player.
3. **Slot choice.** Proposed: uniform over free slots, in the client. A deterministic choice
   (e.g. from the commitment) collides no less and is easier to predict.
4. **Whether to do this at all** before a public launch needs it. The UI warning already removes
   the surprise; this removes the second approval and the one-per-block cap.

## Verification plan

1. **Probe first** — extend `docs/concurrency-probe.md`'s harness on the ledger-9 devnet, before
   editing `table.compact`: (a) two concurrent `receiveUnshielded` into one contract; (b)
   `Set.member` + `insert` on distinct keys; (c) concurrent inserts of new keys into one map vs
   overwrites of pre-inserted keys, for the #36 gas failure; (d) the constructor with six
   pre-inserted `SeatIdentity`s still deploys. Stop at the first failure of (a).
2. **Contract** — compile and execute through `/midnight-verify:verify`; `npm run k -w cli`
   (no circuit above today's maximum, and `abortTable` is the one to watch); `ls
src/managed/table/keys/*.verifier | wc -l` still 9; the `ledger-access` assertion from risk 4.
3. **On chain** — two joins to different slots in one block: both seated. Same slot: one
   `ReadMismatch`, the stake untouched. Join racing a start, both orders. A full table started by
   the daemon. Then a six-seat game end to end.
4. **Review** — amend security-review.md §4 (the cause and "not fixable"), client-rules.md rule 3,
   and redo the digest argument in "What it keeps" for the dice scheme that ships.

## Rejected alternatives

- **`Counter` for `seatCount` / `activeSeats` / `pot`.** Increments commute (E), but `join` must
  still _read_ the count to pick a seat and enforce capacity, and that read is the conflict.
- **The operator sequences joins.** It cannot: each join's proof binds the state it was built
  against, and the operator holds no player's secret to rebuild one. Merging two players'
  proven calls into one transaction does not help either — the second call's reads still assume
  the state before the first.
- **Doing nothing.** Viable for a demo, which is where the table is today. The cap is one seat per
  block per table, and every loser approves twice.
