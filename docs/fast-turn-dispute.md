# Fast-turn disputes: whose silence is it?

**Status:** implemented 2026-11-20 on branch `fast-dispute`, off `popper-audit`. This fixes
popper-audit **C009**.

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

**4. Three cut-offs, spaced by `disputeGraceSecs()` = 30 s**

| Cut-off | Circuit                    | Rule                                                                               |
| ------- | -------------------------- | ---------------------------------------------------------------------------------- |
| ask     | `playerMove(open \| hold)` | not past `roundDeadline - 2g`, **unless the roll it asks for is already answered** |
| answer  | `resolveRoll`              | not past `roundDeadline - g`                                                       |
| finish  | `playerMove(*)`            | not past `roundDeadline` (Finding A)                                               |

Each closes the last-second trick of whichever party would otherwise move last:

- **Operator answers late, then eliminates.** An answer at the deadline makes the seat the
  player's to owe, with no time left to move. Answers stop `g` before the deadline, so an
  answered seat always has `g` to spend it.
- **Player asks late.** An ask at the deadline leaves the operator no time to answer, which turns
  the player's own stall into the shield and eventually `abortTable`'s refund. Unanswered asks stop
  `g` before answers do, so every ask can be answered.

The exemption for pre-answered asks costs one map lookup in `playerMove`. A merged transaction
runs its resolves first (the rule above `stageIdle`), so every ask in a fast settlement, and every
held hold in an escalation answer, finds its answer already in its cell and owes the operator
nothing. Without the exemption, a player who escalated just before the ask cut-off would get its
held holds refused. It would then be left to choose between scoring roll 1 and walking away,
with roll 2 already seen. With the exemption, those holds land as committed.

The exemption is bound to the round and to the exact query the move commits. A stale answer from
an earlier round, or an answer to a different hold, exempts nothing
(`table.test.ts`, "an answer to a DIFFERENT hold exempts nothing").

## Circuit size (measured, full ZK compile, compactc 0.36.0)

| Circuit       | Instructions before → after | Prover key bytes before → after |
| ------------- | --------------------------- | ------------------------------- |
| `playerMove`  | 1,257 → 1,307               | 16,817,780 → 16,819,560         |
| `resolveRoll` | 172 → 189                   | 4,205,976 → 4,206,372           |
| `eliminate`   | 473 → 467                   | 12,340,744 → 12,340,567         |

Prover key size doubles with each step of k, so a near-identical key means no circuit changed k.

## What it costs

- **When everyone plays:** nothing extra. A fast turn must land by the answer cut-off
  (`deadline - 30 s`) instead of the deadline, because its resolves carry the answer cut-off. The
  channel stops admitting a turn 10 s before that (`ADMIT_MARGIN_SECS`).
- **Player walks away:** the same as before. The seat is idle on chain and is eliminated past the
  deadline.
- **Player escalates:** one on-chain open (the player pays it), one operator transaction carrying
  everything held, then the rest of the turn on chain at on-chain speed (about 8 s per
  transaction).
- **Operator gone:** the seat is shielded, and the stalled-operator abort refunds the table at
  `roundDeadline + tableTimeoutSecs`, as on an on-chain table.

## Not done yet

- **On-devnet check:** the escalation answer (a bundle without its open, with resolves rebuilt on
  the live state) is unit-tested against a fake chain only.
- **Guaranteed-phase class:** `resolveRoll` grew by 17 instructions, and its prover key is the same
  size, so its k is unchanged. That it is still small enough to run in the guaranteed phase of a
  merged fast turn (bugs-found #35) needs the devnet run to confirm.
- **Bot client:** `cli/src/player/yacht-fast-turn.ts` does not escalate. A bot whose operator
  stops is eliminated as before; that only affects practice tables.
