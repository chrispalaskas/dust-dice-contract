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

One deployment per table. A table fills, plays **thirteen rounds**, and settles. The
constructor's final argument, `fast: Boolean`, fixes the table's PLAY MODE for life in the
sealed ledger field `fastMode`: `false` is the on-chain interactive mode this document mostly
describes; `true` is the fast table (docs/fast-turn-design.md) whose turns happen off-chain
against the operator and land as one composed settlement transaction of these same circuits.
Joining is consent to the mode — it is public state any client can read before staking.

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
| 4   | operator | `resolveReroll(seat)`          | 4 `rolled2`      |
| 5   | player   | `playerMove(seat, 1, …)` hold  | 5 `awaitRoll3`   |
| 6   | operator | `resolveReroll(seat)`          | 6 `rolled3`      |
| 7   | player   | `playerMove(seat, 2, …)` score | 0 `idle`         |

**The player may score at stage 2, 4 or 6** — that is, after any resolved roll. Scoring early
skips the remaining holds and rolls entirely.

**Even stages are owed by the player; odd stages by the operator.** That is the whole of the
"whose fault is the stall" question, and it is what `eliminate` and `abortTable` divide on.

---

## 2. Exported circuits

**Nine, and nine is the measured hard limit** — see §11. Every argument to an exported circuit is
a **public input** to the proof, and its width feeds the proving domain
([bugs-found.md #14](bugs-found.md)), which is one reason the three player moves are one circuit
rather than three; the deploy ceiling is the other, and it is the binding one.

`Uint<8>` arrives from TypeScript as `bigint`, `Bytes<32>` as `Uint8Array`, `Vector<5, Boolean>`
as `boolean[]` of length 5, `UserAddress` as `{ bytes: Uint8Array }`.

### `join(payoutTo: UserAddress, now: Uint<64>): Uint<8>`

Take the next seat and stake `tier`. Returns the seat index.

- The joining wallet consents by balancing its own UTXO — `receiveUnshielded` names no payer.
- Requires the caller's private state to hold `playerEntropySecret` = this seat's fresh `sk_s`.
- `payoutTo` **must not be the zero address**; it is where this seat is paid, forever.
- **Declares a time.** See §5. It is also recorded as `fillOpenedAt`, the early-start clock's
  origin (see `abortTable`).
- **Private tables.** If the sealed `inviteHash` is non-zero, the caller's private state must
  hold the invite code: `inviteCommitment(code) == inviteHash`, proven in zero knowledge (only
  the boolean is disclosed; a wrong guess reveals nothing). The creator's browser makes the code,
  the operator seals only its hash at deploy, and the code travels in the table link's URL
  fragment. A zero `inviteHash` skips the check.
- The join that brings `activeSeats` to `seatLimit` flips the table to `playing` and opens round 0. **Slots and players differ**: a seat that left while filling keeps its slot (indices are
  positional), so `seatCount` counts slots taken and `activeSeats` counts players present. A
  table is "full" when `activeSeats == seatLimit`; the hard ceiling on slots is six.
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

### `resolveReroll(seat: Uint<8>): Dice` — operator

Rerolls the positions the seat's pending mask does not keep. Requires stage 3 **or** 5, and
reads which reroll it is from that stage: at 3 it applies `hold1` with roll hash 1, at 5 it
applies `hold2` with roll hash 2.

**One circuit for both rerolls**, because they are the same computation and the deploy budget has
room for nine circuits, not ten (§11). A useful side effect: skipping, repeating or reordering a
roll is now _unrepresentable_ rather than merely refused.

Both require the caller's private state to hold `rollSeed` opening `seedCommitment`. That
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

### `eliminate(seat: Uint<8>, q: Uint<64>, rem: Uint<64>, voluntary: Boolean): Uint<64>` — anyone / the seat itself

Knocks out a seat. Returns the seat's refund. Two modes on one circuit (the deploy ceiling is
nine and nine exist):

- **`voluntary == false` (timeout)** — anyone. Requires `blockTimeGt(roundDeadline)`,
  `seatProgress[seat].round == openRound`, `!eliminated`, and the seat's stage to be **even**
  (0, 2, 4 or 6 — the player's silence). An odd stage is the operator's and is refused —
  **except on a fast table** (`fastMode == true`), where resolves are off-chain and a seat
  parked at stage 1 past the deadline is a stalled fast turn, so the stage-parity rule is
  waived. Penalty split: `q * 13 + rem == tier * (openRound + 1)`, `rem < 13`.
- **`voluntary == true` (resignation)** — the seat itself: the `playerEntropySecret` witness must
  open `seatIdentity[seat].keyCommit`, the same authorisation `playerMove` demands. The deadline,
  stage-parity and played-this-round guards are all waived — resign any time while the table is
  playing, even mid-resolve or right after scoring. **Also legal while the table is FILLING**
  (only voluntarily: nobody owes anything before the start): `openRound` is 0, so the
  schedule below charges `tier * 0 / 13` — a full refund, with `q = 0, rem = 0`. Such a seat is
  marked with `finishedAtRound == 65534` (`leftBeforeStart`), keeps its slot, and may `redeem`
  at once in any phase. If the last player leaves a filling table it stays `filling` — empty
  again, still joinable — rather than becoming `abandoned`. **Charged one round less**:
  `q * 13 + rem == tier * openRound` — the open round does not count, so resigning always
  returns strictly more than timing out at the same point (and resigning in round one is free).
  This is the deliberate incentive to leave loudly; with the walkover in `settle`, a two-player
  resignation pays the survivor and unlocks the resigner's redeem within about a minute.

In both modes `q` is the penalty, which **stays in the pot**; `tier - q` becomes the seat's
`seatRedeemable`. Pays the caller nothing. **Declares no time.**

### `settle(seed: Bytes<32>, q: Uint<64>, r: Uint<64>): Uint<8>` — anyone

Pays the winner `pot - q` and the rake `q`. Returns the winning seat.

- Requires `openRound >= 13` **or `activeSeats == 1` (the walkover)**, and at least one
  un-eliminated seat. The walkover: a playing table cannot be joined and eliminated seats cannot
  win, so with one active seat the outcome is decided — settling early pays the survivor and
  unlocks every eliminated seat's `redeem` instead of making one person play out the remaining
  rounds. It cannot be forced (`eliminate` fires only on genuinely timed-out seats), and the
  operator's policy prefers eliminating a delinquent survivor (reaching `abandoned`, where every
  penalty is waived) over crowning them.
- `q * 100 + r == pot`, `r < 100`. The remainder goes to the winner.
- **`seed` is public here** and must open `seedCommitment` — unless
  `blockTimeGt(roundDeadline + tableTimeoutSecs)`, past which the check is waived and
  `revealedSeed` stays all-zero. See §7.
- Eliminated seats cannot win. **Declares no time.**

### `redeem(seat: Uint<8>): Uint<64>` — anyone

Pays seat `seat` its `seatRedeemable` to the address it recorded at join. Returns the amount.

- Requires `phase` to be `settled` (2) or `aborted` (3) — **or the seat to have left before the
  start** (`seatProgress[seat].finishedAtRound == 65534`), which is paid in any phase. Otherwise
  **refused while the table is live, and refused in `abandoned` (4)** — see §6.
- Requires `seatRedeemable[seat] > 0`; a second call finds nothing.
- Adds the amount to `seatPaid[seat]` (see §6).
- Conflict-free: six seats can redeem in one block. **Declares no time.**

### `abortTable(q: Uint<64>, rem: Uint<64>, now: Uint<64>): Uint<64>` — anyone

Ends a table that cannot finish and converts the whole pot into per-seat refunds — **or STARTS
a filling table early**. Pays no player directly on the refund paths — it writes `seatRedeemable`
and leaves the sending to `redeem`. Returns the per-seat share (0 on a start).

Legal in exactly four situations, the first outranking the second:

| situation        | condition                                                                                                  | effect                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| early start      | `phase == filling && startAfterSecs > 0 && activeSeats >= 2 && blockTimeGt(fillOpenedAt + startAfterSecs)` | `playing`, round 0 opens; no rake |
| never filled     | `phase == filling && seatCount > 0 && blockTimeGt(roundDeadline)` and not starting                         | refund `tier`; no rake            |
| operator stalled | `phase == playing`, some seat at an **odd** stage, `blockTimeGt(roundDeadline + tableTimeoutSecs)`         | refund `tier`; no rake            |
| all eliminated   | `phase == abandoned` (only a table that STARTED can be abandoned)                                          | refund `tier - q`; rake paid      |

`q` and `rem` are the **per-seat** rake on `tier`, not on the pot: `q * 100 + rem == tier`,
`rem < 100`. Required unconditionally even on the paths that pay no rake, so the encoding stays
canonical. **Seats that left before the start are skipped by every share-out** (they hold — or
have withdrawn — their full refund already), and the rake is `q` times the seats that received a
share.

**Declares a time** (`now`, pinned like `join`'s): the early start stamps round 0's deadline
`now + turnTimeoutSecs`.

**Who calls it.** The START branch is permissionless, and since 2026-09-04 the operator daemon
deliberately never calls `abortTable` while it holds: the players decide when to begin (the UI's
"Start now" button, any seated player). A "never-filled" refund is attempted only when the START
branch cannot apply — fewer than two players, or the wait disabled — because with 2+ players
past the clock the same call would start the game instead of refunding it.

_Executed 2026-09-03 on the probe devnet against the real operator daemon
(`cli/src/fast/filling-e2e.ts`, table `b9bdc777…`, 3 seats, `startAfterSecs` 180): two joins;
player 1 left (`eliminate(voluntary)`, refund 100 NIGHT) and the daemon paid it 25 s later
(`redeem` while filling, wallet +100); player 2 joined; the daemon started the table 196 s later
with 2 active players in 3 slots (pot 200); both live seats played a fast turn through the channel
and the daemon closed the round. Two earlier runs with a 60 s clock lost a same-block race — the
daemon's start landed first and the leave failed its read binding — which is per-read binding
working as designed._

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
deadline, not a per-move one. The constructor refuses any timeout at or below `120 * 2 = 240 s`
(the factor was 4 until fast tables wanted five-minute rounds; a 300 s round survives the worst
120 s shave with 180 s left).

---

## 6. Money

```
contract balance  ==  pot  +  SUM(seatRedeemable)            (what the chain holds)
tier * seatCount  ==  pot  +  SUM(seatRedeemable)  +  SUM(seatPaid)   (asserted in-circuit)
```

- `pot` goes to the winner and the rake. `join` puts `tier` into it.
- `seatRedeemable[s]` is owed to seat `s` personally and is paid only by `redeem`, only to the
  address seat `s` recorded at `join`.
- `eliminate` moves `tier - penalty` from `pot` to `seatRedeemable[s]`.
- `settle` pays out exactly `pot`.
- `abortTable` moves the whole `pot` into `seatRedeemable`.

**`redeem` is refused while the table is live** for seats eliminated DURING play, so nothing of
a game in progress is paid out mid-game; such a player waits for the game to end, which lets the
all-eliminated waiver be applied uniformly with no claw-back. The one exception is a seat that
**left before the start**: its stake is its own again, it is paid whenever it asks, and every
later share-out skips it — `seatPaid` is what keeps the invariant true once money has left.

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
`tableTimeoutSecs`, `fastMode`, `startAfterSecs` (0 = no early start), `inviteHash` (zero =
public; otherwise `inviteCommitment(code)` and `join` needs the code).

### Table state

| field             | type         | notes                                                                                                                           |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `phase`           | enum         | 0 filling, 1 playing, 2 settled, 3 aborted, 4 abandoned. **Comes back as a `number`, not a `bigint`** — it is a Compact `enum`. |
| `seatCount`       | `bigint`     | SLOTS taken (a pre-start leaver keeps its slot); frozen once playing                                                            |
| `activeSeats`     | `bigint`     | players present / not eliminated; 0 while playing means abandoned                                                               |
| `started`         | `boolean`    | true once the game began (full house or early start)                                                                            |
| `fillOpenedAt`    | `bigint`     | declared time of the last join; early start at `+ startAfterSecs`                                                               |
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
| `seatPaid`       | `bigint` — what `redeem` has already sent this slot            |
| `seatReceipt`    | `Uint8Array`                                                   |

**Whether a slot is real is `seat < seatCount`, never map membership.**
`finishedAtRound == 65535` is the never-finished sentinel; `65534` marks a seat that left before
the start.

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

Three details a client will otherwise only find by reading the Compact:

- **`seatProgress.dice` is written only by a score move** — never by `resolveRoll*`. During a
  turn the live dice are `seatTurn.roll`; `seatProgress.dice` is the hand the seat _banked_ for
  the round, which is what the round-digest fold and the verifier consume.
- **`seatProgress.finishedAtRound` is a round index**, despite any older `finishedAtTurn`
  naming that survives in mirrors: there is no turn index in this model. `65535` = never
  finished.
- **The winner tie-break excludes eliminated seats entirely** (in-circuit `survivorRow`:
  `s < seatCount && !eliminated`). `api`'s `winnerSeat` predates eliminations and is NOT a
  drop-in replacement for settlement prediction once any seat has been eliminated — compute the
  winner over survivors only.

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
| 2 seats | 182 + 2 + 13 + 1 |               78 + 2 + 13 + 1 |
| 6 seats | 546 + 6 + 13 + 1 |              234 + 6 + 13 + 1 |

At two seats: **198 transactions** all-full, **94** all-stop-early. At six seats: **566** and
**254**. (The 2-seat row originally read `104 + …`, computed from the player-only count of 4
per turn instead of the 7-transaction total the 6-seat row uses — caught by the UI port, which
now derives its estimates from the per-turn table above rather than these aggregates.)

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

---

## 11. The deploy ceiling — nine circuits, and why

**This contract cannot grow past nine exported circuits.** Not "should not": the deploy
transaction is refused by the node.

A deploy carries one verifier key per exported circuit. Measured on midnight-node
`2.0.0-rc.4` with `npm run deploy-probe -w cli`, which deploys a table and nothing else:

| exported circuits | verifier-key bytes | deploy                                                                      |
| ----------------: | -----------------: | --------------------------------------------------------------------------- |
|                 8 |             15,416 | lands                                                                       |
|                 9 |             19,071 | lands                                                                       |
|                10 |             21,190 | **`1010: Invalid Transaction: Transaction would exhaust the block limits`** |

So the limit sits between 19,071 and 21,190 bytes of verifier key. The previously documented
figure of "11–12 circuits" was inherited from a neighbouring project, had never been tested
here, and is wrong.

**It is bytes, not circuits, and that couples it to `k`:** a verifier key is **1,351 bytes at
k ≤ 12** and **2,119 bytes at k ≥ 13**. Which means the deploy ceiling and the admission floor
(§ the `k` discussion in [table-circuit.md](table-circuit.md) §0.1) pull in **opposite
directions**:

- `k ≤ 12` — small verifier key, deploy-friendly, but risks `OutsideTimeToDismiss` at admission.
  The previous design's `claimTimeout` sat at k=11 and was refused 1,610 times in live play.
- `k ≥ 13` — clears the admission floor, but costs 2,119 bytes of deploy budget per circuit.

This contract keeps every circuit at k ≥ 13 so nothing is ever refused at admission, and pays
for it with a hard cap of nine circuits. That is why `playerMove` merges three player moves and
`resolveReroll` merges two rolls.

**For a client author this means one thing:** if you need new on-chain behaviour, it has to go
behind an existing circuit's kind discriminator, not into a new circuit. `npm run deploy-probe
-w cli` answers the question in about forty seconds.
