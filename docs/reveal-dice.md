# Dice nobody can see early — the on-chain table's randomness

**Status: BUILT on `fast-dleq-check` (contract, mirrors, simulator, 139 table tests). Not yet
driven by the operator or the website, not yet played on a devnet.** Written 2026-09-24.

This replaces the blind VRF on **on-chain tables** with a commit–reveal scheme in which every seat
contributes to every roll, and the operator contributes nothing. The fast table keeps the VRF
(`docs/vrf-dice.md` in the private dust-dice repo); one contract serves both, and the sealed `fastMode` picks the path.

## The problem this closes

The VRF made the operator unable to _see_ a roll on its own. It did not make the operator plus a
player unable to see one. A player who is handed `x` holds every secret behind its own dice — `sk`
is its own, `x` is now its own — and can compute its roll 2 and roll 3 for all 32 holds before
choosing, offline, asking nothing. Nothing on chain can count a question that is never asked.
vrf-dice.md said the leak "yields nothing"; that is true of _other_ players' dice
and false of the accomplice's own.

Any fix therefore needs randomness from a party the colluding pair does not control. That party
is the other players.

## The construction

Every seat already commits to a secret `sk_s` at join. It now also serves as the seed of the
seat's **contributions**, one per roll:

```
v_s(r, k) = H("dust-dice:v3:contrib", tableId, r‖k, sk_s)        k = 0, 1, 2
```

A roll on an on-chain table is a hash of one contribution per live seat, in seat order, with a
fixed zero for a slot that is absent or out:

```
D(r, k)      = H("dust-dice:v3:roll", tableId, r‖k, v_0(r,k) .. v_5(r,k))
dice_s(r, k) = ladder( rollContext(tableId, D(r,k), mixed_s(r), r, k) )
```

`mixed_s` is the seat-separating value the open already latches (`H(H(sk_s, tableId, r),
roundDigest)`), so six seats hashing the same `D` still roll six different hands, exactly as
before. The ladder in dice-core is untouched: only where its 32 bytes come from moves.

**The whole property is in when a contribution is revealed.** `v_s(r, k)` may go on chain only
once **every seat still rolling has fixed the hold before roll k**. Until then the honest seats'
contributions exist nowhere but in their browsers, so nobody — not a seat, not the operator, not
the two together — can compute any seat's roll k before the decision it would have informed is on
chain. One honest seat protects the whole table.

Two things make this cheap:

- **Nothing is chosen at reveal time.** A contribution is a deterministic function of the
  join-time secret, proven in-circuit against the join commitment (the same shape as
  `forcedEntropy`). There is nothing to grind, and nothing for a browser to store between the
  move that fixes a hold and the move that reveals — a reload recomputes it.
- **Roll 1 needs no extra transaction.** The decision before roll 1 is the previous round's
  category, and an open is legal only once `closeRound` has run, i.e. once every seat has scored.
  So the open publishes `v_s(r, 0)` and `closeRound` is its barrier.

Rolls 2 and 3 get one new circuit, `revealEntropy(seat, rollIndex, value)`, whose only job is the
barrier. It is the **ninth export, which is the deploy ceiling** (table.compact §8) — and it had to
be a circuit of its own: the barrier binds to every seat's turn and progress, reads that every
other seat's decide writes. On `playerMove` that would have made six simultaneous decides collide;
in a reveal phase no decide is legal, so the reads are free.

### A round, phase by phase

```
open        every live seat: playerMove(open) — publishes v(r,0)          [slot 1]
            → roll 1 is public the moment the last open lands
decide 1    every seat still rolling: hold, or score and stop             [slot 2]
reveal 2    EVERY live seat, scored or not: revealEntropy(1)              [slot 3]
            → roll 2 is public
decide 2    hold or score                                                 [slot 4]
reveal 3    every live seat: revealEntropy(2)                             [slot 5]
            → roll 3 is public
score       the seats still rolling score                                 [slot 6]
closeRound  permissionless, as before
```

A seat that has scored still owes its contribution to the rolls the others take. A reveal that
nobody needs (no seat is asking for that roll) is not owed. A repeat reveal rewrites the same
value and is harmless.

### The operator's role

None, on the dice. The operator deploys tables, and drives the permissionless steps
(`closeRound`, `eliminate`, `settle`, `redeem`) because it is watching anyway. `resolveRoll` is
refused on an on-chain table. `settle` needs no key: `revealedVrfSecret` is meaningless there
and the closing certificate records the game as verifiable regardless, because every roll was a
hash of public reveals. `abortTable`'s operator-stalled branch is fast-only: on an on-chain table
whoever is silent is `eliminate`'s business.

## Timeouts: the phase schedule

A round on an on-chain table is **six slots of `phaseSecs`** (sealed, a new constructor argument,
zero on a fast table) from `roundOpenedAt`, stamped by whatever opens a round. A seat is
eliminable for exactly one thing: an obligation that is **unblocked** — the reveals or holds it
was waiting on are in — and whose slot has ended. A seat blocked behind another's silence owes
nothing; the silent one does. The rule, as `eliminate` computes it and `seatObligation`
(contrib.ts) mirrors it:

| slot | obligation                           | unblocked when                                                        |
| ---- | ------------------------------------ | --------------------------------------------------------------------- |
| 1    | open                                 | always                                                                |
| 2    | hold or score on roll 1              | every contribution to roll 1 is in                                    |
| 3    | reveal for roll 2 (scored seats too) | every seat still rolling has held, and some seat is asking for roll 2 |
| 4    | hold or score on roll 2              | revealed, and every contribution to roll 2 is in                      |
| 5    | reveal for roll 3                    | as 3, one roll later                                                  |
| 6    | score on roll 3                      | revealed, and every contribution to roll 3 is in                      |

**An elimination re-stamps the schedule.** Whoever was blocked behind the eliminated seat is
unblocked by it and must get a whole slot, not be due at once — otherwise one silence would
cascade through the table. That is why `eliminate` now declares a `now` (pinned like
`closeRound`'s).

**No caller can start the clock in the past.** Every writer of `roundOpenedAt` declares its time,
and the sandwich lets a declaration trail block time by up to the slack (120 s). Stamped at the
declared time, a hostile `closeRound` or `eliminate` — both permissionless — could start the next
round two minutes early and eliminate whoever had not opened in what was left of the slot. So
the origin is stamped a slack AHEAD of the declared time (`scheduleOrigin`), which puts it in
`(blockTime, blockTime + slack]` whatever the caller declares: the worst case is a full slot, and
an honest stamp gives the table a minute or so extra at the start of each round. The round
deadline prices the same attack in with a 240 s floor; a slot no longer has to. Its floor is the
slack itself — the time a move is budgeted to land in — so `phaseSecs > 120 s`, six slots inside
`turnTimeoutSecs`.

**The house rule is three minutes** (`DEFAULT_PHASE_SECS` in the operator): a seat that does
not make the move it owes within three minutes of that move becoming possible is out, and
forfeits the elimination penalty, `tier * (round + 1) / 13`. A straggler costs the others at
most one slot per phase, and a slot is a maximum: a table of attentive players moves at
transaction speed, and a round then takes a few minutes; the eighteen-minute budget is reached
only by a seat stalling in every phase.

The one trade-off of a fixed schedule: deadlines are absolute from the origin, so a seat that
moves _after_ its own slot has ended, before anyone eliminates it, eats into the next seat's
slot. It is always eliminable at that point — by any player, not only the operator — which is
what keeps the trick from paying.

## Cost

|                            | fast (VRF)            | on-chain, before      | on-chain, now                              |
| -------------------------- | --------------------- | --------------------- | ------------------------------------------ |
| full turn                  | 4 player + 3 operator | 4 player + 3 operator | **4 player moves + 2 reveals, 0 operator** |
| early stop after roll 1    | 2 + 1                 | 2 + 1                 | 2 + 0 (reveals only if someone rerolls)    |
| lockstep barriers per roll | none                  | none                  | two (holds in, reveals in)                 |
| who pays                   | player + operator     | player + operator     | the player, all of it                      |

Every player transaction is a wallet approval, so a full on-chain turn is six prompts where it
was four. The barriers mean a round runs at the pace of its slowest seat, twice per roll.

Circuit sizes: no circuit changed its k. `playerMove` was already k=16 under the VRF (the two
`ecMul` of the unblinding), `eliminate` k=14, `revealEntropy` lands at k=14, `resolveRoll` stays
at k=12. The deploy carries nine verifier keys, the measured ceiling.

## What it does not close, stated plainly

**The last revealer.** Once every other seat has revealed for roll k, the last one holds every
input and can compute everybody's roll k — its own included — before it reveals. Its only
alternative is not to reveal, which is elimination: the pot is gone and the round's penalty is
paid. So a colluding pair can sacrifice one seat to choose the better of two outcomes for one
step, once per sacrificed seat, and nothing else. It is a priced, one-shot, one-bit lever; a VRF
layer on top would not remove it against an operator-colluding pair (the operator computes the
alternative for them), which is why `x` was dropped rather than kept as belt and braces. The
penalty for a missed reveal is the same schedule as for a missed move; making it steeper is a
tunable, not a redesign.

**Fast tables are unchanged**, and the reason is the barrier: "every seat still rolling has fixed
its hold" is a fact the chain can state about on-chain moves and only the operator can state
about a fast turn. A fast table therefore keeps the VRF, its DLEQ check in the browser, and its
documented trust in the operator's ordering.

**Information asymmetry within a round** (a seat that acts later sees the others' dice) is
unchanged and is not a randomness leak, as table.compact's header already says.

## Verification

A replay needs no key: every contribution is on chain, `D(r, k)` is a hash of six public cells,
and the dice follow. `contrib.ts` derives everything through the contract's own pure circuits
(`contribution`, `revealRollDigest`), as vrf.ts does, so the browser, the operator, the verifier
and the tests cannot drift from the proof. `chainRevealFor` turns a ledger view into the dice a
seat is looking at, without any secret — a spectator sees every seat's roll the moment the reveals
complete.

## Where things are

- `contract/src/reveal-core.compact` — the primitives and their rationale.
- `contract/src/table.compact` — `seatReveal`, `phaseSecs`, `roundOpenedAt`; `revealEntropy`;
  the mode split in `playerMove`, `eliminate`, `settle`, `abortTable`, `resolveRoll`.
- `contract/src/contrib.ts` — the mirror, `chainRevealFor`, `seatObligation`.
- `contract/src/test/table-harness.ts` — `playRoundChain`, the lockstep driver; `replayGame`
  on-chain.
- `contract/src/test/table.test.ts` — `describe('the reveal scheme')`, and every default
  (on-chain) differential game.
