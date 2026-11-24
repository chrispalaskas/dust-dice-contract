# Fast-turn disputes: whose silence is it?

**Status:** implemented 2026-11-20 on branch `fast-dispute`, off `popper-audit`. This fixes
popper-audit **C009**. **Revised 2026-11-23:** the cut-offs of section 4 are replaced by the
**seat clock** (section 5). The first version's ask-cut-off exemption broke every fast settlement
on chain, and its cut-offs took the round's last minute from a player whose operator went quiet.

## The problem

On a fast table a turn runs off-chain against the operator and lands as one transaction, which
the operator submits (`fast-turn-design.md`). Two facts combine badly:

1. **The operator sees the dice before the turn lands.** The blind VRF keeps the operator from
   knowing a roll when it answers. But the player's next proven `playerMove` makes that roll
   public, and on a fast table that move goes to the operator as `part` on `/fast/hold` and
   `/fast/score`, together with the post-move `state`. It does not go to the chain.
2. **The chain cannot tell who went quiet.** The open is off-chain too: it is `parts[0]` of the
   settlement. So between settlements a fast seat rests at stage 0, whether the operator went
   quiet after seeing a roll it disliked, or the player walked away from a bad roll.

`eliminate` used to waive the owes-shield on fast tables (`vol || fastMode || playerOwes`). So the
operator could stop answering after seeing a seat's dice and collect the timeout penalty
(`table.test.ts`, the old "odd-stage seat is eliminable" test). The README, the join panel and the
mode badge said a stopped operator merely "leaves your turn unfinished". Popper-audit refuted that
claim as C009.

## Why "refund instead of penalty" does not work

Whatever rule is applied to a stall, it blames the same side every time, because the chain sees
the same state either way:

| Rule on a stalled fast seat  | Who gets a free option                                       |
| ---------------------------- | ------------------------------------------------------------ |
| eliminate with penalty (old) | the operator: abort after seeing the dice; the player pays   |
| void and refund              | the player: walk away from a bad roll and get the stake back |

The fix has to make the silence **attributable**.

## The design

**1. The shield holds in both modes.** `eliminate` asserts `vol || playerOwes(s, pend)` for every
table. An asked-but-unanswered seat is the operator's debt, fast or not.

**2. Escalation.** A fast player whose operator went quiet lands its own open on chain. It is the
same open it sent the operator, because the entropy is `H(sk, tableId, round)` and the blinding
is derived from the seat secret. The seat is now at an asked stage: shielded, with the operator
owing an on-chain answer. A player that simply walked away never escalates, stays at stage 0,
and is eliminated as before.

**3. The operator answers with everything it holds.** The player may already have sent holds
off-chain and seen the rolls they bought. If the operator answered roll 1 alone, the player could
choose hold 1 again with roll 2 in view, and since the hold mask is in roll 2's VRF input
(`vrfInputPoint`), that buys a second draw. So the operator answers an escalated seat with its
resolve for every roll it revealed off-chain, plus each player move it received after one (a
hold, or the score), all in **one** transaction (`FastChannel.answerEscalated`). The operator
keeps the player's parts durably for this (`OperatorStore.recordPlayerPart`, write-once per
transcript position). If it holds no move after roll 1, a plain `resolveRoll` is safe, since the
player has committed nothing it could re-choose.

**4. (Superseded 2026-11-23) Three cut-offs, spaced by `disputeGraceSecs()` = 30 s.** The
first version stopped unanswered asks at `roundDeadline - 60 s` and answers at `roundDeadline -
30 s`, and exempted an ask whose answer was already in its cell. Two things were wrong with it:

- **The exemption broke every fast settlement.** To know whether an ask was pre-answered,
  `playerMove` read the answer cell for the roll it asks for. A fast move is PROVEN before the
  operator answers, so its proof recorded that cell empty; in the merged settlement the operator's
  resolves run FIRST and fill it, so the cell no longer held what the proof read and the chain
  refused the move (`FailFallible`, the player's segments 4, 6, 8 and 10). Every fast turn failed
  this way on the local devnet on 2026-11-23. The simulator runs circuits directly, without
  replaying a proof against a changed ledger, so the 311 contract tests could not see it.
- **The cut-offs charged the player for the operator's silence.** A player whose operator went
  quiet for 100 s of a 241 s round escalated, was answered 5 s after the operator returned, and
  had 7 s left to reroll before the ask cut-off. The page's clock still showed 1:15.

**The transcript rule this records** (pinned by `table.test.ts`, "THE FAST-TURN TRANSCRIPT RULE"):
a player move may read only cells that nothing running ahead of it in a settlement writes. The
resolves run first and write the answer cells; the one answer cell a move reads is the one it
reveals, which its proof already saw filled.

**5. The seat clock (2026-11-23).** A seat's time stops while the operator owes it an answer it
asked for on chain, and the wait is added to that seat's own deadline. No cut-offs: the operator
may answer whenever it likes, and the player keeps the time it had.

| Call                       | Who, when                                                | Effect                                                                                 |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `seatClock(s, now, true)`  | the player, in its own transaction after an on-chain ask | records the ask and `now` (pinned like `join`)                                         |
| `seatClock(s, now, false)` | the operator, last in its answer (or anyone, later)      | adds the wait + 120 s (`clockSlackSecs`) to `seatDeadline[s]`; no-op if nothing is due |
| `playerMove` (finish)      | every move                                               | refused past the seat's deadline (Finding A)                                           |
| `eliminate`                | anyone                                                   | past the seat's deadline, and **not while a credit is due**                            |

- **The credit is a separate cell from the mark.** `seatAsk` (the mark) is read by no move, and
  `seatDeadline` (the credit) is written only by the credit, which the operator places last in an
  escalation answer (segment 8, after the player's parts at 4..7). So every held move in that
  answer reads the same `seatDeadline` it was proven against.
- **An answer without its credit is not an elimination.** Otherwise an operator could answer late,
  skip the credit and eliminate the next second. `eliminate` refuses a seat with a credit due;
  anyone may send the credit: the page sends it before the player's next move when the seat's
  uncredited deadline is under 45 s away, and the rescue panel offers it (`nextRescueStep`
  `credit`) when the operator answered and went quiet.
- **The 120 s bonus** is `timeSlackSecs()`, the most a declared time may trail block time
  (`pinTime`). Whoever sends the credit can shorten the measured wait by up to that much, so the
  bonus cancels it: a seat is never credited less than it waited. (At 60 s, an operator could keep
  59 s of a player's wait: popper re-review C043.) An honest credit over-credits by up to 120 s,
  which only lengthens the round. The wait is measured to the credit, not to the answer.
- **The cap.** A seat's deadline is never credited past `roundDeadline + tableTimeoutSecs - 240 s`,
  so the operator always has at least the 240 s timeout floor to answer the last possible ask
  before `abortTable`'s operator-stalled grace expires (Finding A stays closed).
- **Phase.** `seatClock` carries `resolveBallast`, so the ledger classes it wholly fallible and it
  may follow `playerMove`s in one transaction (bugs-found #35/#36). The builders assert it.
- **Late asks are harmless now.** An ask in the last second shields the seat, but the operator can
  always answer (no answer cut-off), and then the player has only the time it had left.
- **Unmarked asks** (a page from before the clock) get the shield but no credit: an answer late in
  the round leaves that player little time. Every current client marks.
- **Gap:** a held hold whose roll the operator never revealed lands in the escalation answer and
  asks for its roll there, unmarked. The operator answers it on its next tick (no cut-off), but that
  wait is not credited.

## Circuit size (measured, full ZK compile, compactc 0.36.0)

| Circuit       | Instructions before → after | Prover key bytes before → after |
| ------------- | --------------------------- | ------------------------------- |
| `playerMove`  | 1,257 → 1,307               | 16,817,780 → 16,819,560         |
| `resolveRoll` | 172 → 189                   | 4,205,976 → 4,206,372           |
| `eliminate`   | 473 → 467                   | 12,340,744 → 12,340,567         |

Prover key size doubles with each step of k, so a near-identical key means no circuit changed k.

## What it costs

- **When everyone plays, fast table:** nothing extra. A fast turn must land by the seat's
  deadline; the channel stops admitting one 10 s before it (`ADMIT_MARGIN_SECS`).
- **When everyone plays, on-chain table:** two extra transactions per roll asked for -- the
  player's mark (a second wallet prompt) and the operator's credit. A three-roll turn is 13
  transactions where it was 7. The mark runs alongside the answer and the credit after it.
- **Player walks away:** the same as before. The seat is idle on chain and is eliminated past the
  deadline.
- **Player escalates:** one on-chain open with its mark (the player pays it), one operator
  transaction carrying everything held and the credit, then the rest of the turn on chain at
  on-chain speed (about 8 s per transaction), each ask marked and each answer credited.
- **Operator gone:** the seat is shielded, and the stalled-operator abort refunds the table at
  `roundDeadline + tableTimeoutSecs`, as on an on-chain table.

## Done on the devnet (2026-11-23)

- **Escalation answer:** an escalated ask with the operator stopped for 90 s was answered, and the
  credit moved the seat's deadline 14:33:13 -> 14:35:43 (then with the 60 s bonus).
- **Guaranteed-phase class:** a scripted 13-round fast game settled 26 turns with no failure, so
  `resolveRoll` still runs where the merged turn needs it.

## Accepted, not fixed

- **The wait before escalating is not given back.** The clock starts at the on-chain mark. Time a
  fast player spends waiting on the operator's channel before the page offers to escalate (up to
  three 30 s request timeouts, or never on a refusal) is not credited. Choosing a fast table is
  choosing to rely on the operator for that much (decision 2026-11-23, popper re-review C045).
- **Bot client:** `cli/src/player/yacht-fast-turn.ts` does not escalate. A bot whose operator
  stops is eliminated as before; that only affects practice tables.
