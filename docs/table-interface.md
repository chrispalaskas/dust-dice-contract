# Table contract interface

Everything a client needs to drive `table.compact` without reading the Compact: the exported
circuit signatures, the argument encodings, the ledger fields to read, and what the client must
compute versus what the circuit derives for itself.

Written for the operator daemon (`service/`) and the website (`ui/`). The CLI demo (`cli/`) is a
client too and the same rules apply to it.

Contract source: [`contract/src/table.compact`](../contract/src/table.compact). Design notes:
[simultaneous-rounds.md](simultaneous-rounds.md), [table-contract.md](table-contract.md).
Measurements: [table-circuit.md](table-circuit.md).

---

## 1. The shape of a game

One deployment per table. A table fills, plays **thirteen rounds**, and settles.

```
filling ──(last join)──> playing ──(closeRound at round 12)──> playing, openRound == 13
                            │                                          │
                            │                                       settle ──> settled
                            │
                            ├─(all seats eliminated)──> abandoned ──(abortTable)──> aborted
                            └─(operator stalled)───────────────────> abortTable ──> aborted

settled / aborted ──(redeem, once per seat)──> money out
```

**Rounds are 0..12, thirteen of them, one scoring category each.** There is no pipelining and no
score-only round: a seat scores the dice it just rolled, in the round it rolled them.
`openRound == 13` means the game is over.

**Every seat plays every round independently.** There is no turn cursor. Six seats can open,
roll, hold and score in any interleaving, and six `playerMove` transactions land in one block —
measured at that width in [concurrency-probe.md](concurrency-probe.md). The round advances only
when `closeRound` is called, and `closeRound` refuses until every live seat has scored.

### One turn, in transactions

| #   | Who      | Call                           | Seat stage after |
| --- | -------- | ------------------------------ | ---------------- |
| 1   | player   | `playerMove(seat, 0, …)` open  | 1 `awaitRoll1`   |
| 2   | operator | `resolveRoll1(seat)`           | 2 `rolled1`      |
| 3   | player   | `playerMove(seat, 1, …)` hold  | 3 `awaitRoll2`   |
| 4   | operator | `resolveRoll2(seat)`           | 4 `rolled2`      |
| 5   | player   | `playerMove(seat, 1, …)` hold  | 5 `awaitRoll3`   |
| 6   | operator | `resolveRoll3(seat)`           | 6 `rolled3`      |
| 7   | player   | `playerMove(seat, 2, …)` score | 0 `idle`         |

**The player may score at stage 2, 4 or 6** — that is, after any resolved roll. Scoring early
skips the remaining holds and rolls entirely.

**Even stages are owed by the player; odd stages by the operator.** That is the whole of the
"whose fault is the stall" question, and it is what `eliminate` and `abortTable` divide on.

---

## 2. Exported circuits

Ten, against a deploy ceiling measured at 11–12 on this toolchain. Every argument to an exported
circuit is a **public input** to the proof, and its width feeds the proving domain
([bugs-found.md #14](bugs-found.md)), which is why the three player moves are one circuit rather
than three.

`Uint<8>` arrives from TypeScript as `bigint`, `Bytes<32>` as `Uint8Array`, `Vector<5, Boolean>`
as `boolean[]` of length 5, `UserAddress` as `{ bytes: Uint8Array }`.

### `join(payoutTo: UserAddress, now: Uint<64>): Uint<8>`

Take the next seat and stake `tier`. Returns the seat index.

- The joining wallet consents by balancing its own UTXO — `receiveUnshielded` names no payer.
- Requires the caller's private state to hold `playerEntropySecret` = this seat's fresh `sk_s`.
- `payoutTo` **must not be the zero address**; it is where this seat is paid, forever.
- **Declares a time.** See §5.
- The last join flips the table to `playing` and opens round 0.
- **Not conflict-free, deliberately**: two simultaneous joins bind to `seatCount` and one is
  rejected with a `ReadMismatch`. Retry after re-reading `seatCount`. If both landed they would
  take the same seat index and one player's identity would be silently overwritten.

### `playerMove(seat, kind, entropy, mask, category): Uint<8>`

```
seat:     Uint<8>            the seat index returned by join
kind:     Uint<8>            0 = open, 1 = hold, 2 = score
entropy:  Bytes<32>          forced entropy on open; 32 zero bytes otherwise
mask:     Vector<5, Boolean> the hold on a hold; all-false otherwise
category: Uint<8>            0..12 on a score; 0 otherwise
```

Returns the seat's **next stage**, so a client can drive the state machine off the return value.

**The unused arguments must carry exactly those sentinels.** They are part of the public log a
settlement verifier replays, and two encodings of one move would make it ambiguous. The circuit
rejects anything else with `only an open declares entropy` / `only a hold declares a mask` /
`only a score declares a category`.

| kind    | legal at stage                                 | `entropy`                   | `mask`        | `category` |
| ------- | ---------------------------------------------- | --------------------------- | ------------- | ---------- |
| 0 open  | 0, and `seatProgress[seat].round == openRound` | `H(sk, tableId, openRound)` | all-false     | 0          |
| 1 hold  | 2 or 4                                         | 32 zero bytes               | the five bits | 0          |
| 2 score | 2, 4 or 6                                      | 32 zero bytes               | all-false     | 0..12      |

**All three kinds prove knowledge of the seat's `sk_s`** against the `C_s` recorded at join.
Without it anyone could hold nothing and score a seat's dice into its worst category. The
caller's private state must hold `playerEntropySecret`.

**`mask[i] == true` means keep die `i`.** All-false is the canonical "reroll everything".
All-true is legal but pointless — score instead.

**Declares no time.**

### `resolveRoll1(seat: Uint<8>): Dice` — operator

Derives five fresh dice and latches this seat's mixed entropy. Requires stage 1 and
`seatTurn[seat].round == openRound`. Returns the dice.

### `resolveRoll2(seat: Uint<8>): Dice` — operator

Rerolls the positions `hold1` does not keep. Requires stage 3.

### `resolveRoll3(seat: Uint<8>): Dice` — operator

Rerolls the positions `hold2` does not keep. Requires stage 5.

All three require the caller's private state to hold `rollSeed` opening `seedCommitment`. That
is the operator's entire authority — there is no operator address in the contract. **The seat is
an argument**: several seats can be awaiting a roll at once, so the operator must say which.
Which seat it resolves first changes nothing about anyone's dice (§4). **No time check**: a
resolve is never late.

### `closeRound(now: Uint<64>): Uint<8>` — anyone

Advances the table one round: folds the new `roundDigest`, sets `openRound` to the next round,
stamps the next `roundDeadline`. Returns the new `openRound`.

Refuses unless every seat is done: `seat >= seatCount || eliminated || seatProgress.round >
openRound`. **Declares a time.** Permissionless, so a player whose operator has gone quiet can
advance the table.

### `eliminate(seat: Uint<8>, q: Uint<64>, rem: Uint<64>): Uint<64>` — anyone

Knocks out a seat that let `roundDeadline` pass while owing a move. Returns the seat's refund.

- Requires `blockTimeGt(roundDeadline)`, `seatProgress[seat].round == openRound`,
  `!eliminated`, and the seat's stage to be **even** (0, 2, 4 or 6 — the player's silence).
  An odd stage is the operator's and is refused.
- `q` and `rem` are the penalty split the client computes: `q * 13 + rem == tier * (round + 1)`
  and `rem < 13`. `q` is the penalty, which **stays in the pot**; `tier - q` becomes the seat's
  `seatRedeemable`.
- Pays the caller nothing. **Declares no time.**

### `settle(seed: Bytes<32>, q: Uint<64>, r: Uint<64>): Uint<8>` — anyone

Pays the winner `pot - q` and the rake `q`. Returns the winning seat.

- Requires `openRound >= 13` and at least one un-eliminated seat.
- `q * 100 + r == pot`, `r < 100`. The remainder goes to the winner.
- **`seed` is public here** and must open `seedCommitment` — unless
  `blockTimeGt(roundDeadline + tableTimeoutSecs)`, past which the check is waived and
  `revealedSeed` stays all-zero. See §7.
- Eliminated seats cannot win. **Declares no time.**

### `redeem(seat: Uint<8>): Uint<64>` — anyone

Pays seat `seat` its `seatRedeemable` to the address it recorded at join. Returns the amount.

- Requires `phase` to be `settled` (2) or `aborted` (3). **Refused while the table is live, and
  refused in `abandoned` (4)** — see §6.
- Requires `seatRedeemable[seat] > 0`; a second call finds nothing.
- Conflict-free: six seats can redeem in one block. **Declares no time.**

### `abortTable(q: Uint<64>, rem: Uint<64>): Uint<64>` — anyone

Ends a table that cannot finish and converts the whole pot into per-seat refunds. **Pays no
player directly** — it writes `seatRedeemable` and leaves the sending to `redeem`. Returns the
per-seat share.

Legal in exactly three situations:

| situation        | condition                                                                                          | rake |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---- |
| never filled     | `phase == filling && seatCount > 0 && blockTimeGt(roundDeadline)`                                  | none |
| operator stalled | `phase == playing`, some seat at an **odd** stage, `blockTimeGt(roundDeadline + tableTimeoutSecs)` | none |
| all eliminated   | `phase == abandoned`                                                                               | paid |

`q` and `rem` are the **per-seat** rake on `tier`, not on the pot: `q * 100 + rem == tier`,
`rem < 100`. Required unconditionally even on the two paths that pay no rake, so the encoding
stays canonical. Each seat gets `tier - q` on the all-eliminated path and `tier` on the others.

**Declares no time.**

---

## 3. What the client computes, and what the circuit derives

| Value                | Who computes it | How                                                                  |
| -------------------- | --------------- | -------------------------------------------------------------------- |
| `sk_s`               | player          | 32 fresh CSRNG bytes, **one per table**, never reused                |
| `C_s`                | circuit         | `entropyKeyCommitment(tableId, sk)` at join                          |
| `entropy` for a turn | **player**      | `forcedEntropyTs(sk, tableId, openRound)` — and re-proved in-circuit |
| `mixed`              | circuit         | `mixEntropy(entropy, roundDigest)`, latched by `resolveRoll1`        |
| the dice             | circuit         | from the seed; the client can only _predict_ them with the seed      |
| `mask`               | **player**      | free choice, after seeing the dice                                   |
| `category`           | **player**      | free choice, subject to the joker rules                              |
| penalty `q`, `rem`   | **caller**      | `tier * (round + 1)` divided by 13 — Compact has no division         |
| rake `q`, `r`        | **caller**      | `pot` divided by 100 at settle; `tier` by 100 at abortTable          |
| seed commitment      | operator        | `seedCommitmentTs(tableId, seed)` **before the table opens**         |

Mirrors live in `@yahtzee/contract`: `forcedEntropyTs`, `entropyKeyCommitmentTs`,
`seedCommitmentTs`, `mixEntropyTs`, `firstRollTs`, `rerollUnderMaskTs`, `mergeStreamTs`,
`replayTurnTs`, `genesisDigestTs`, `joinDigestTs`, `roundDigestTs`, `eliminateDigestTs`,
`redeemDigestTs`, `finalDigestTs`.

**Scorecard preview is client-side.** `rawScore(category, dice)` and the whole scoring core are
exported as pure circuits on the compiled contract (`pureCircuits.rawScore`,
`pureCircuits.applyScore`, `pureCircuits.placeScore`, `pureCircuits.grandTotal`,
`pureCircuits.isComplete`), and `api/src/rules.ts` is the reference implementation of the same
rules. Use either to show "what would these dice score in each box" without a transaction.

### The dice, exactly

```
mixed  = H("yahtzee:v1:mix",  entropy_s(r), roundDigest_r)
roll k = deriveDice(H("yahtzee:v1:roll", tableId, seed, mixed, r, k))     k = 0, 1, 2
```

Roll 1 is `roll 0` in full. Rolls 2 and 3 **merge left to right**: the positions the mask does
not keep consume the fresh roll's dice **in order**. If the player holds positions 0 and 3, the
two dice they get back are `fresh[0]` and `fresh[1]` — _not_ `fresh[1]` and `fresh[2]`. This is
`mergeStreamTs`, and a verifier that merged positionally would diverge on every non-prefix hold.

**Every seat's dice stream is distinct because of `sk_s` and nothing else.** The roll context has
no seat field; the separation is entirely in `mixed`. `join` refuses a second seat for a `C_s`
already registered, which is what makes that sound.

---

## 4. The frozen round digest

**Every seat in round `r` derives its rolls from `roundDigest` as it stood when round `r`
opened.** `closeRound` advances it exactly once, folding round `r`'s results **in seat order**:

```
roundDigest' = H("yahtzee:v1:round", roundDigest, r, seatCount, [ {dice, out} x 6 ])
```

All six slots are folded, including ones no player took — they carry `dice = [1,1,1,1,1]`,
`out = false`. A replay that folded only the seated rows produces a different hash.

Consequences for a client:

- **The order the operator resolves seats in cannot change anybody's dice.** A client may resolve
  in any order and may parallelise across wallets.
- **A verifier does not need to know the submission order.** Replay walks seats by index.
- Do not cache `mixed` across a round boundary — `playerMove(open)` clears it.

---

## 5. Time

The kernel exposes block-time **predicates** only; there is no `blockTime()` accessor. So a
circuit that stamps a deadline is told the time and pins the claim:

```
blockTimeGte(now)  and  blockTimeLt(now + 120)   =>   now in (blockTime - 120, blockTime]
```

**Only `join` and `closeRound` take a `now`.** Everything else compares real block time against a
stored deadline. A client should pass its best estimate of current block time in seconds; passing
a time ahead of the chain is rejected outright, and passing one more than 120 s behind is too.

`roundDeadline` is the single deadline field:

| field                              | meaning                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `roundDeadline`                    | while `filling`: the fill deadline. While `playing`: when the open round must be finished. |
| `roundDeadline + tableTimeoutSecs` | the operator's grace, and the settle seed-waiver point                                     |

`turnTimeoutSecs` covers a **whole round** — up to four player transactions and three operator
ones per seat, plus the operator's round trips. Size it accordingly and show the player the round
deadline, not a per-move one. The constructor refuses any timeout at or below `120 * 4 = 480 s`.

---

## 6. Money

```
contract balance  ==  pot  +  SUM(seatRedeemable)
```

- `pot` goes to the winner and the rake. `join` puts `tier` into it.
- `seatRedeemable[s]` is owed to seat `s` personally and is paid only by `redeem`, only to the
  address seat `s` recorded at `join`.
- `eliminate` moves `tier - penalty` from `pot` to `seatRedeemable[s]`.
- `settle` pays out exactly `pot`.
- `abortTable` moves the whole `pot` into `seatRedeemable`.

**`redeem` is refused while the table is live**, so nothing is paid out mid-game. An eliminated
player waits for the game to end. That is deliberate: it keeps the custody invariant to one line
and lets the all-eliminated waiver be applied uniformly with no claw-back.

**`abandoned` is a pending terminal state, not a redeemable one.** When the last seat is
eliminated the penalties are still in `pot` and each seat's `redeemable` is still net of its own
penalty. One permissionless `abortTable` call waives the penalties, pays the rake and moves the
table to `aborted`; only then does `redeem` pay the right number. A client that sees
`phase == abandoned` should call `abortTable` and then `redeem`.

---

## 7. Verifiability

`settle` publishes `revealedSeed`. **`revealedSeed == 0` on a settled table is a meaningful
state, not "not settled yet"**: it means the game was force-settled past the deadline without a
valid seed, and the rolls cannot be re-derived. A verifier must report such a game as
_unverified_ rather than as _verification failed_.

`finalDigest` is a closing certificate written by both `settle` and `abortTable`:
`H("yahtzee:v1:final", roundDigest, tableId, ending, winner, seatCount, paid, rake, perSeat,
verifiable)`. `winner == 6` means nobody won (an abort). Mirror: `finalDigestTs`.

`seatReceipt[s]` is a per-seat hash chain: `eliminate` folds in the penalty arithmetic, `redeem`
folds in the payout and the final scorecard. Mirrors: `eliminateDigestTs`, `redeemDigestTs`.

---

## 8. Ledger fields a client reads

Read with a one-shot `queryContractState`, never `contractStateObservable`, for read-after-write
— the observable misses rapid successive updates ([bugs-found.md](bugs-found.md) §0 #11).

### Sealed configuration

`tableId`, `tier`, `seatLimit`, `rakeAddress`, `seedCommitment`, `turnTimeoutSecs`,
`tableTimeoutSecs`.

### Table state

| field             | type         | notes                                                                                                                           |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `phase`           | enum         | 0 filling, 1 playing, 2 settled, 3 aborted, 4 abandoned. **Comes back as a `number`, not a `bigint`** — it is a Compact `enum`. |
| `seatCount`       | `bigint`     | seats taken; frozen once playing                                                                                                |
| `activeSeats`     | `bigint`     | seats not eliminated; 0 means abandoned                                                                                         |
| `openRound`       | `bigint`     | 0..12 while playing; 13 means the game is over                                                                                  |
| `roundDigest`     | `Uint8Array` | frozen for the round                                                                                                            |
| `roundDeadline`   | `bigint`     | see §5                                                                                                                          |
| `pot`             | `bigint`     |                                                                                                                                 |
| `revealedSeed`    | `Uint8Array` | zeros until an honest settle                                                                                                    |
| `winnerSeatIndex` | `bigint`     | meaningless before settle                                                                                                       |
| `finalDigest`     | `Uint8Array` | zeros until settle or abortTable                                                                                                |

### Per-seat maps, keyed `0..5` (all six pre-inserted, so no lookup ever aborts)

| map              | fields                                                         |
| ---------------- | -------------------------------------------------------------- |
| `seatIdentity`   | `addr`, `keyCommit`                                            |
| `seatCard`       | `scores[13]`, `filled[13]`, `yahtzeeBonuses`                   |
| `seatProgress`   | `round`, `total`, `finishedAtRound`, `eliminated`, `dice`      |
| `seatTurn`       | `stage`, `round`, `entropy`, `mixed`, `hold1`, `hold2`, `roll` |
| `seatRedeemable` | `bigint`                                                       |
| `seatReceipt`    | `Uint8Array`                                                   |

**Whether a slot is real is `seat < seatCount`, never map membership.**
`finishedAtRound == 65535` is the never-finished sentinel.

### Driving a UI off `seatTurn[seat].stage`

| stage | show                                               | next action   |
| ----- | -------------------------------------------------- | ------------- |
| 0     | "your turn" (if `seatProgress.round == openRound`) | player: open  |
| 1     | "rolling…"                                         | operator      |
| 2     | roll 1 dice; hold/score controls                   | player        |
| 3     | "rolling…"                                         | operator      |
| 4     | roll 2 dice; hold/score controls                   | player        |
| 5     | "rolling…"                                         | operator      |
| 6     | roll 3 dice; score controls only                   | player: score |

`seatTurn[seat].roll` is the current dice at stages 2, 4 and 6.

---

## 9. Transaction cost

The honest arithmetic, measured by the test suite
(`describe('the transaction cost of an interactive turn')`), not estimated.

**Per turn:**

| turn              | player tx | operator tx | total |
| ----------------- | --------: | ----------: | ----: |
| full, three rolls |         4 |           3 |     7 |
| stop after roll 2 |         3 |           2 |     5 |
| stop after roll 1 |         2 |           1 |     3 |

**Per game**, plus one `join` per seat, one `closeRound` per round, one `settle`, and one
`redeem` per seat that is owed money:

| table   |  every turn full | every turn stops after roll 1 |
| ------- | ---------------: | ----------------------------: |
| 2 seats | 104 + 2 + 13 + 1 |               52 + 2 + 13 + 1 |
| 6 seats | 546 + 6 + 13 + 1 |              234 + 6 + 13 + 1 |

At six seats: **552 transactions** if every player takes all three rolls, **240** if every player
stops after roll 1.

**Early scoring is the player's lever over the length of the game, and it is a big one** — a
table where everyone stops after roll 1 is well under half the traffic of one where everyone
rolls three times. A UI should make "score now" as easy to reach as "roll again", and may
reasonably tell the player that stopping early speeds the table up for everyone.

**This is more traffic than the pre-declared-policy design**, which was 1 player + 3 operator per
turn (4), because the player now transacts between rolls. The player-side transactions are
parallel across seats; the operator's are not — one wallet's spends must be sequential
([bugs-found.md](bugs-found.md) §0 #8/#22) — so at six seats the operator submits up to 18
transactions per round and that, at ~19 s to inclusion, is what sets the length of a game. An
operator that wants the full width of simultaneous rounds needs a pool of wallets, one per seat.

---

## 10. Client obligations

1. **One fresh `sk_s` per table**, from a CSRNG. Reusing one across tables makes the two seats
   linkable, and `join` refuses a `C_s` that already holds a seat at this table.
2. **Fresh `seed` and fresh `tableId` per table**, both from a CSRNG. `tableId` is a domain
   separator on every roll hash, so a reused id replays another table's dice. The contract cannot
   generate it — `kernel.self()` is zeros in a constructor.
3. **Persist the seed to disk at commit time, before the table opens.** Its loss is survivable
   (a force-settle still pays the winner) but the game becomes unreplayable.
4. **Retry by re-reading state, not by classifying errors.** A conflict loser sees only
   `SubmissionError: Transaction submission error`; only the node's log says `ReadMismatch`, and
   it is indistinguishable from the transient `InvalidDustSpendProof`
   ([bugs-found.md #6](bugs-found.md)). Confirm from the ledger that the move did not land, then
   resubmit.
5. **Do not seat the operator at a table it operates.** With interactive holds a seed-knowing
   player can compute all 32 hold outcomes before choosing — see the residual note in
   `table.compact`'s header. This is stronger than the old policy preview and the site's threat
   model should say so.
