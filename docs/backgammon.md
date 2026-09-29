# Backgammon

The second Dust Dice game. Two seats, one flat pot, Yacht's dust dice. The winner takes the
pot less a 1% rake. There is no doubling cube and there are no gammons: a win is a win.

**This is the ledger-9 build** (branch `backgammon-vrf`, off `dust-dice-vrf`). Its rolls come
from the table's blind VRF (`vrf-core.compact`, the same primitives as Yacht's here) instead of
the ledger-8 build's committed seed. Board, rules, time model and exits are unchanged.

| File                                    | What it holds                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `contract/src/backgammon.compact`       | The table: ledger, the six circuits, the time model. Its header is the design record.                 |
| `contract/src/backgammon-dice.compact`  | The rolls: the blind VRF's inputs, `dice-core`'s byte ladder two dice at a time, and the opening.     |
| `contract/src/backgammon-board.compact` | The board rules, **generated** by `contract/scripts/gen-backgammon-board.mjs`.                        |
| `contract/src/bg-mirror.ts`             | The off-chain halves: the seat's queries and unblinding, the operator's answer, and the replay.       |
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

## The turn: two transactions, queries pipelined

| Stage | Who owes                        | Circuit                          |
| ----- | ------------------------------- | -------------------------------- |
| 0     | the operator owes the roll      | `resolveRoll(now, S, a1, a2, z)` |
| 1     | the player to move owes the ply | `move(ply, count, nextQuery)`    |

A seat's roll for ply t, with `sk` its committed secret and `x` the table's VRF key
(`PK = x*G` sealed at deploy):

```
v     = bgRollSecret(sk, t)          forced; secret until the move at t reveals it
P     = bgVrfInputPoint(tableId, t, v)
B     = rho*P, rho = bgBlindingFor(sk, t)      posted two plies ahead (join posts ply 1)
S     = x*B                           the operator's answer; the DLEQ is checked on chain
Gamma = rho^-1 * S = x*P              unblinded in the mover's browser
dice  = ladder(H(8*Gamma, e, t))      e = the secret the previous move revealed
```

- `join` reveals the seat's join entropy and posts its query for ply 1 (only the seat that does
  not start uses it). A `move` at ply t reveals `v` and posts the query for ply t+2.
- The **opening** (ply 0) is thrown in the clear: `S = x*P_open`, `P_open` hashed from both
  join entropies, DLEQ checked on chain, one die per seat from `8*S`. Seat 0's die is uniform on
  1..6 and seat 1's on the other five faces, so it is never a double. The higher die moves first
  and plays both numbers.
- After the opening, the resolve only answers a blinded point. The dice exist once the mover
  unblinds them, and become public with the move, which proves the unblinding: the query on
  chain is `rho*P` for this seat's forced `v`, and `S == rho*Gamma`.
- **`rho` is derived in the circuit, not witnessed.** With `rho` a witness, a player can post
  the identity as its query, get the identity back with a valid DLEQ, and reveal with `rho = 0`
  (or any multiple of r): `S == rho*Gamma` then holds for any Gamma, and the player picks its
  dice. Measured at proof level on 2026-09-27 against the Yacht reveal on this line, which takes
  `rho` as a witness.
- **The cofactor is cleared, as defence in depth.** `S == rho*Gamma` alone fixes Gamma only up to
  a point of order dividing 8. The same measurement found the stack refuses every point outside
  the prime-order subgroup as an EC operand (runtime, VM and circuit), so none can be supplied
  today; the dice hash `8*Gamma` so they stay unique if that changes.
- `settle` reveals `x` (checked against `PK`), so anyone can replay every roll from the public
  log: each move revealed its `v`, so `Gamma = x*P` is computable after the fact.

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
- The operator's `start` circuit is the **start**: it seats the two earliest joiners (by declared
  join time, the lower slot breaking a tie) as seats 0 and 1, refunds anyone else, sets the pot
  and throws the opening, all in one transaction. On ledger 9 it is a circuit of its own (k=16,
  once a game) rather than a branch of `resolveRoll`, which would otherwise be k=16 for every
  roll; `resolveRoll` is k=12.
- On ledger 9 a slot also holds the joiner's blinded query for ply 1, and the slots are ONE map
  of records (`joinSlots`) rather than one map per field: four maps of eight put the deploy over
  the node's block limit.
- A filling table's clock is its latest join: `abortTable` refunds every slot once nobody has
  joined for a table timeout. `eliminate(slot, true)` leaves and frees the slot.

`bg-slots.ts` is the one reading of the slots for every client (the operator, CLI, website,
verifiers): `bgPlayerCount`, `bgHeldSlots`, `bgRandomFreeSlot`, `bgSlotHeldBy`, `bgLastJoinAt`.

## Time

The kernel has block-time predicates only.

- **Declaring time:** `join`, `start` and `resolveRoll` declare `now`. `join` is pinned within 120 s of block time, for the wallet prompt. The operator's `resolveRoll` is pinned within 60 s.
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

- the VRF key is sealed before either player exists, and every answer carries a DLEQ;
- every input is forced from a committed seat secret.

After the opening, **nobody sees a roll before the player to move**: the operator sees only a
blinded point, and a colluding opponent cannot form the mover's input point. A colluder cannot
see its own next roll early either, since that roll hashes the secret the honest move in between
reveals. This closes the ledger-8 build's "one roll ahead" residual.

The operator _can_ stall, and a stall ends in a full refund with no rake.

What remains is the opening. The operator knows it the moment it throws it, and an operator
colluding with the second joiner can grind that joiner's key to pick it. The board is
deliberately not in any roll: it would let a player choose among legal moves to steer the next.

A player who posts a malformed query cannot unblind its answer and cannot move: it times out
and loses, which harms only itself.

## Measured

compactc 0.34.0 (ledger 9), full keys:

| Circuit       |   k | Prover key |
| ------------- | --: | ---------: |
| `join`        |  14 |     5.2 MB |
| `resolveRoll` |  15 |    11.0 MB |
| `move`        |  16 |    21.6 MB |
| `eliminate`   |  13 |     2.8 MB |
| `settle`      |  13 |     3.1 MB |
| `abortTable`  |  13 |     2.8 MB |

- Six verifier keys: 13,290 bytes.
- `move` carries the VRF reveal (a hash-to-curve and two scalar multiplications), so it sits at
  k=16 like Yacht's `playerMove` on this line: about five seconds more to prove than the
  ledger-8 build's k=14 move, and a 21.6 MB key to fetch once.
- `resolveRoll` checks one DLEQ and derives the opening pair in every call (a circuit pays for
  both sides of a branch).
