# Backgammon

The second Dust Dice game. Two seats, one flat pot, Yacht's dust dice. The winner takes the
pot less a 1% rake — except at a practice table, which pays no winner ([below](#practice-tables)).
There is no doubling cube and there are no gammons: a win is a win.

**This is the ledger-9 build** (branch `ledger-9`). Every roll hashes a secret from **each
player** and nothing of the operator's: no VRF, no seed, no operator in the dice at all. Board,
rules and exits are the ledger-8 build's; the turn and the opening are new.

| File                                    | What it holds                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `contract/src/backgammon.compact`       | The table: ledger, the eight circuits, the time model. Its header is the design record.               |
| `contract/src/backgammon-dice.compact`  | The rolls: both players' forced secrets, `dice-core`'s byte ladder two dice at a time, the opening.   |
| `contract/src/backgammon-board.compact` | The board rules, **generated** by `contract/scripts/gen-backgammon-board.mjs`.                        |
| `contract/src/bg-mirror.ts`             | The off-chain halves: the mover's own roll, the opening, and the replay.                              |
| `api/src/backgammon.ts`                 | The rules engine: `applyPly` (the circuit's twin), `legalPlies` (the full rules), `plyRuleViolation`. |
| `verifier/src/backgammon.ts`            | The chain-only verifier. `dust-dice-verify <address>` picks it by the contract's entry points.        |

## The board

Each side is 26 counts from **its own** point of view:

- index 0 is borne off;
- indices 1..24 are points, and home is 1..6;
- index 25 is the bar.

A checker moves from p to p − die, and my point p is the opponent's index 25 − p. The contract
stores both sides in one ledger cell. A ply is one read and one write of that cell.

The board circuit never builds an intermediate board. Chaining four boards is the exponential
compile of bugs-found #1. Instead, every read at sub-move j is the ledger value plus the effect
of the earlier sub-moves ("delta form"). The generator's header explains why this is exact.

## Rules: what the chain enforces

The circuit (`applyPlyStrict`) checks every checker against the board as it stands when that
checker moves:

- you have a checker on the point it leaves;
- a checker on the bar enters first;
- the landing point does not hold two or more of the opponent's checkers;
- a single opponent checker on the landing point is hit to the bar;
- bearing off needs all fifteen home;
- a die larger than the point bears off only from the highest occupied point;
- the dice used are the dice rolled, and doubles play four of one value;
- a die the ply leaves unplayed must be unplayable on the final board.

**The chain does not enforce** the full "play as many dice as you can" rule (a different
_order_ might have played both), nor the rule that a lone playable die must be the larger.
Both need a search over orders, which is too large for a circuit. The website offers only plies
from `legalPlies`. The verifier reports any ply that broke either rule as a _finding_ (exit
code 2), separate from the chain's checks.

## The turn: one transaction, and the operator is not in it

| Stage | Who owes                                  | Circuit                        |
| ----- | ----------------------------------------- | ------------------------------ |
| —     | filling, two or more joined: anyone       | `start(now)`                   |
| 0     | both seats owe their share of the opening | `reveal(seat, now)`, each      |
| 0     | then the higher opening die owes ply 0    | `openingMove(ply, count, now)` |
| 1     | the player to move owes the ply           | `move(ply, count, now)`        |

With `sk` each seat's secret, committed at join (only `H(sk, tableId)` is public), every value
below is forced from it and proven in the circuit:

```
o_s    = bgOpeningSecret(sk_s)        a seat's share of the opening, revealed after the start
v_s(t) = bgRollSecret(sk_s, t)        the mover's secret for ply t, revealed by its move at t

opening = ladder(H(tableId, o_0, o_1))           a die per seat, never a double
ply t   = ladder(H(tableId, v_mover(t), e, t))   e = the secret the previous move revealed
```

- **Every ply's roll needs a secret from each player.** Nobody but the mover can compute it
  before the mover's move reveals `v_mover(t)` -- not the opponent, not the operator, not the two
  together. The mover itself can compute it only once the opponent's move has revealed `e`, which
  is when its turn begins. Nobody can choose it: both inputs are fixed by keys committed before
  the game began.
- **No roll transaction.** The mover computes its own roll the moment the opponent's move lands
  and plays it; its move reveals `v` and the chain derives the dice from `v` and `e`. A ply is one
  transaction, which the website hands to the operator to pay for (no wallet prompt).
- **The opening's shares come after the start**, not at join: a share public at join would let
  the second joiner try keys until it liked the opening. Seat 0's die is uniform on 1..6 and seat
  1's on the other five faces, so the opening is never a double. The higher die plays ply 0
  (`openingMove`, a circuit of its own so that `move` stays at k=15).
- **A pass is a move.** It reveals its secret like any other ply, and the other seat's next roll
  hashes it. A shut-out player's forced pass is sent by the website by itself.
- The board is deliberately not in any roll: it would let a player choose among legal moves to
  steer the next one.

This replaced the blind VRF on 2026-09-29. With the opponent's secret in every roll, the table
key added nothing, and "the operator must not play at its own tables" stopped being a condition
of fairness.

## Joining: two players at once

A proof is bound to every ledger value its transaction read, so a join that counted seats could
never land in the same block as another join (seen live: the second player was turned away and
had to approve again). Since 0.4.6 a join claims one of **eight seat slots**, at random, and
reads only `phase`, constants and that slot:

- Joins to different slots touch nothing in common and land together. Measured on the ledger-8
  devnet on 2026-09-27: two wallets, built against one state, landed in one block (slots 3 and 1).
- Joins to the same slot (1 in 8 for two at once) both read it: one lands, the other is refused
  (`ReadMismatch`; on ledger 8 an included `FailFallible`, fee spent, stake untouched) and the
  client retries with another free slot.
- Nothing is counted while filling: no seat counter, no pot, no set of keys (the growing set is
  what ran concurrent joins out of gas in docs/order-independent-join.md). One secret may hold
  two slots.
- `start` -- anyone may send it; the operator does -- seats the two earliest joiners (by
  declared join time, the lower slot breaking a tie) as seats 0 and 1, refunds anyone else and
  sets the pot. A join commits only to its key; nothing of the dice is public until the reveals.
- The slots are ONE map of records (`joinSlots`) rather than one map per field: each map entry
  carries its own overhead, and on ledger 9 four maps of eight put the deploy over the node's
  block limit.
- A filling table's clock is its latest join: `abortTable` refunds every slot once nobody has
  joined for a table timeout. `eliminate(slot, true)` leaves and frees the slot.

`bg-slots.ts` is the one reading of the slots for every client (the operator, CLI, website,
verifiers): `bgPlayerCount`, `bgHeldSlots`, `bgRandomFreeSlot`, `bgSlotHeldBy`, `bgLastJoinAt`.

## Time

The kernel has block-time predicates only.

- **Declaring time:** `join`, `start`, `reveal`, `openingMove` and `move` declare `now`, pinned
  within 120 s of block time.
- **Every clock is a guaranteed minimum.** A call that hands the game to a seat stamps
  `deadline = now + 120 + moveTimeout`, a slack ahead of what it declared, so that seat has at
  least `moveTimeout` from the block the call landed in, whatever the caller declared. The floor
  is two minutes, the time to prove and land a move.
- **Both reveals stamp the deadline blind** (they read nothing the other writes, so they can land
  in one block): the later one's stamp stands, and the starter's clock runs from the second share.

Operator defaults: 180 s to move, 900 s table timeout (the fill clock, and the grace before a
table nobody opened is refunded).

| Exit                     | When                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `eliminate(seat, false)` | past `deadline`, the seat that owes: the one to move, a share missing while the other's is in, or the starter's ply 0 |
| `eliminate(seat, true)`  | resign while playing (the opponent wins), or leave a filling table (full refund)                                      |
| `abortTable()`           | filling, a table timeout after the latest join; or neither share revealed past `deadline + tableTimeout`: refunds     |
| `settle(q, r)`           | decided: pays the winner pot - 1% and the rake. Nothing to reveal                                                     |

A player cannot stall its way into a refund: once one share is in, silence is answered by
`eliminate`.

## Practice tables

The constructor's last argument, `house: UserAddress` (sealed as `house`), makes a practice
table when it is not all zero: the site's bot deploys it and sits as `house`, and a person plays
it. The person's stake is a fee for the DUST the house spends on their game, and the bot must
never gain or lose NIGHT. Argument order: `(id, stake, rakeTo, seedCommit, moveTimeout,
tableTimeout, invite, house)`; all zero is an ordinary table, unchanged.

Every send of a stake goes through `payeeOf` (`backgammon.compact` section 7): a stake recorded
at `house` goes back to it, exactly `tier`; any other goes to the rake address, whole. So:

| Exit                                              | house seat / slot | person | rake address        |
| ------------------------------------------------- | ----------------- | ------ | ------------------- |
| `settle`, whoever won (play, timeout, resign)     | `tier`            | 0      | the person's `tier` |
| `eliminate(slot, true)` while filling (leave)     | `tier`            | 0      | the leaver's `tier` |
| the start's refund of a third joiner              | `tier`            | 0      | a person's `tier`   |
| `abortTable` (never filled, never started, stall) | `tier`            | 0      | every other `tier`  |

`q` and `r` are still required by `settle`, so the encoding is the same at every table. The
closing certificate records `paid = 0` and `rake` = what the rake address took. A person who
records `house` as their payout address is paid as the house, and a practice table the house
never sat at sends every stake to the rake.

## Randomness: what is left

No one -- player, operator, or any two of them together -- can choose a roll, and no one but the
mover can compute one before the move that plays it. Trying keys at join buys nothing: every roll
also needs the other player's secret, which is not known then.

What is left is the order of revealing, and it only ever hurts the one who uses it. The later of
the two opening shares sees the opening first; a mover sees its roll before it moves. Either can
decline to act, and declining loses the game on the clock. Neither can change what it reveals.

## Measured

compactc 0.34.0 (ledger 9), full keys, 2026-09-29:

| Circuit       |   k | Prover key |
| ------------- | --: | ---------: |
| `join`        |  14 |     5.2 MB |
| `start`       |  12 |     1.1 MB |
| `reveal`      |  14 |     5.2 MB |
| `openingMove` |  15 |    10.0 MB |
| `move`        |  15 |    10.0 MB |
| `eliminate`   |  15 |    10.0 MB |
| `settle`      |  13 |     2.8 MB |
| `abortTable`  |  14 |     5.2 MB |

- The deploy writes 26,171 bytes (cli/tools/deploy-cost.mjs), under the Yacht table's 28,920,
  which the node admits.
- `move` is k=15, down from the VRF build's k=16: it proves no curve arithmetic, and the opening's
  hash lives in `openingMove`, used once a game.
- `start` is k=12, the lower edge of the node's proof-size admission floor (table.compact section
  3), which k=12 has always cleared.

Practice tables (`house`, merged from the ledger-8 line 2026-11-08) cost no k on ledger 8;
re-measure on this build with `npm run k` after the mainnet toolchain bump.
