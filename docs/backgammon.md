# Backgammon

The second Dust Dice game. Two seats, one flat pot, Yacht's dust dice. The winner takes the
pot less a 1% rake. There is no doubling cube and there are no gammons: a win is a win.

| File                                    | What it holds                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `contract/src/backgammon.compact`       | The table: ledger, the six circuits, the time model. Its header is the design record.                 |
| `contract/src/backgammon-dice.compact`  | The rolls: `dice-core`'s byte ladder, two dice at a time, and the opening.                            |
| `contract/src/backgammon-board.compact` | The board rules, **generated** by `contract/scripts/gen-backgammon-board.mjs`.                        |
| `contract/src/bg-mirror.ts`             | TypeScript mirror of the rolls and the forced entropy.                                                |
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

## The turn: two transactions, entropy pipelined

| Stage | Who owes                        | Circuit            |
| ----- | ------------------------------- | ------------------ |
| 0     | the operator owes the roll      | `resolveRoll(now)` |
| 1     | the player to move owes the ply | `move(ply, count)` |

- `roll(t) = H(tableId, seed, e_mover(t), e_opponent(t+1), t, stream)`, where `e_s(t) = H(sk_s, tableId, t)` is forced.
- `join` reveals e(1). A `move` at ply t reveals the mover's own e(t+2).
- Nobody posts a "roll" transaction.

The **opening** (ply 0) hashes both seats' e(1) on stream 1 and gives one die to each seat:

- Seat 0's die is uniform on 1..6.
- Seat 1's die is uniform on the other five faces, so the opening is never a double and needs no re-throw.
- The higher die moves first and plays both numbers.
- The fairness test checks all 30 ordered pairs against a χ² bound.

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
- The operator's opening `resolveRoll` is the **start**: it seats the two earliest joiners (by
  declared join time, the lower slot breaking a tie) as seats 0 and 1, refunds anyone else, sets
  the pot and throws the opening, all in the one transaction it sent anyway.
- A filling table's clock is its latest join: `abortTable` refunds every slot once nobody has
  joined for a table timeout. `eliminate(slot, true)` leaves and frees the slot.

`bg-slots.ts` is the one reading of the slots for every client (the operator, CLI, website,
verifiers): `bgPlayerCount`, `bgHeldSlots`, `bgRandomFreeSlot`, `bgSlotHeldBy`, `bgLastJoinAt`.

## Time

The kernel has block-time predicates only.

- **Declaring time:** `join` and `resolveRoll` declare `now`. `join` is pinned within 120 s of block time, for the wallet prompt. The operator's `resolveRoll` is pinned within 60 s.
- **The move clock is a guaranteed minimum.** The roll stamps `deadline = now + 60 + moveTimeout`, a slack ahead of what it declared. However far behind the operator declares, the player has at least `moveTimeout` from the block its dice landed in. An honest operator trails by a few blocks, so in practice it is a little more. This is why the clock can be three minutes; the Yacht table's 240 s floor exists because its deadlines are not stamped ahead. The floor here is two minutes, the time to prove, approve and land a move.
- **`move` is time-checked but declares nothing:** it is refused once a whole move timeout has passed since the deadline. That guarantees the operator at least `tableTimeout − moveTimeout` to roll. The constructor requires that margin to exceed the 240 s floor.

Operator defaults: 180 s to move, 900 s table timeout (the fill clock and the operator's grace).

| Exit                     | When                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `eliminate(seat, false)` | stage 1, `seat` is to move, block time past `deadline`: the opponent wins                                           |
| `eliminate(seat, true)`  | resign while playing (the opponent wins), or leave a filling table (full refund)                                    |
| `abortTable()`           | one seat, past the fill clock; or stage 0 (the operator owes) past `deadline + tableTimeout`: full refunds, no rake |
| `settle(seed, q, r)`     | decided: the seed must open the commitment until `deadline + tableTimeout`, then it is waived                       |

A player cannot stall its way into a refund. When the player owes the move, the only exit is
`eliminate`.

## Randomness residual

The operator cannot choose or change a roll:

- the seed is committed before either player exists;
- every entropy is forced.

The operator _can_ stall, and a stall ends in a full refund with no rake.

The table assumes, as Yacht's does, that the operator neither plays at its own tables nor leaks
the seed. If the operator colludes with one player anyway:

- **One roll ahead:** the pair knows the honest player's next roll when making its own move. That is knowledge one roll ahead, never a choice of the roll.
- **The opening:** if the colluding player joins second, it can grind its key to pick the opening.

The board is deliberately not in the roll hash. With it, the pair could steer the honest
player's roll by choosing between legal moves.

## Measured

compactc 0.31.1 (ledger 8):

- `--skip-zk` compile: 2.6 s.
- Six verifier keys: 12,714 bytes, against about 19 KB measured to deploy.

| Circuit         |   k | Instructions |
| --------------- | --: | -----------: |
| `join`          |  14 |          851 |
| `resolveRoll`   |  15 |          795 |
| `move` (strict) |  14 |        3,196 |
| `eliminate`     |  13 |          841 |
| `settle`        |  14 |          970 |
| `abortTable`    |  13 |        1,130 |

The maximality check costs `move` about 490 instructions and no k.

Adding Backgammon changed none of Yacht's artifacts. The Table and Lobby verifier keys are
byte-identical to the deployed build, and the fingerprint is still `f815b5d063f9adc3`.
