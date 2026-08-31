# Table contract design

One deployment per table. This document is the state-machine and randomness design; custody
mechanics follow the Gate 0, Q1 verdict (see architecture.md).

## Who computes the dice — the two-step turn

The contract holds only `H(seed)`; no circuit can derive dice from a commitment, and the
player must not know the seed. So a turn is two transactions by two parties:

1. **`takeTurn` (player):** submits their per-round entropy (see below), a hold-policy choice,
   and the scoring category **for their previous turn's dice** (pipelined — see next section).
2. **`resolveTurn` (operator):** supplies the seed as a **witness** (private — never disclosed
   mid-game), the circuit asserts `H(seed) == seedCommitment`, derives the three rolls with
   holds applied per the declared policy, and writes the resulting dice into the turn log.

This is the one place ZK genuinely works in the base game: the dice are _proven_ correct
against the seed commitment without revealing the seed while the game is live.

The player experiences 13–14 wallet prompts per game; the operator automates one resolve per
turn from its own wallet (strictly sequential — one wallet per process).

## Pipelined category choice — keep the skill

Pre-declaring the category before seeing the dice (naive shape (a)) costs too much skill
expression. Instead, `takeTurn` k carries:

- the **category choice for turn k−1's dice** (which the player has seen — they were resolved
  on-chain), and
- the **entropy + hold policy for turn k**.

The first `takeTurn` carries no category; a final `scoreLast` step (folded into `takeTurn`
with a flag, not a separate exported circuit) scores turn 13. Hold decisions remain
policy-driven (a small enum: keep-none, keep-modal-face, keep-face(f), keep-≥4,
chase-straight — final set decided with circuit cost data); category choice — the dominant
skill decision in Yahtzee — stays fully manual.

## Randomness: commit–reveal hardened against operator–player collusion

Base scheme: operator commits `H(seed)` at table open, before any player exists.

**The attack the naive scheme misses:** a player colluding with the operator knows the seed,
and if players choose per-turn entropy freely, the colluding player grinds their entropy at
turn time for perfect dice. Fixes, layered:

1. **Entropy is non-grindable at turn time.** At `join`, each player registers
   `C_s = H(sk_s)` for a fresh secret `sk_s`. Turn entropy is forced:
   `entropy_s(r) = H(sk_s, tableId, r)`, proven in-circuit against `C_s` (sk is a witness,
   entropy is disclosed). A player cannot pick their entropy per turn at all.
2. **Entropy is non-grindable at join time.** Rolls also mix in a **running game digest**:
   `gameDigest' = H(gameDigest, <event>)` updated by every `join` and every `resolveTurn`.
   Roll inputs: `H(seed, entropy_s(r), gameDigest, tableId, r, rollIndex)`. Because seat
   order = join order, every player's first roll digest includes joins that happened _after_
   theirs (or, for late seats, earlier turns' resolutions), so no one — even knowing the
   seed — can simulate their own future dice while still free to choose `sk_s`.
   A cheater would need to control **every** seat at the table, at which point they are
   playing themselves.
3. **The operator alone can never steer:** with the seed but no player's `sk`, every roll is
   fully determined the moment the turn comes up; there is nothing left to choose.

**Residual, documented honestly:** a seed-knowing operator can _selectively withhold_
resolution (griefing) when upcoming dice displease it. It cannot alter an outcome — only
freeze the table, which the timeout path converts into a refund. The operator must not seat
itself at tables it operates; the site says so, and anonymous seating (stretch) does not
change this analysis.

**Verifiability:** `settle` takes the seed as a **public** argument (asserted against the
commitment, disclosed on-chain). Anyone re-derives all rolls from the public log: joins,
entropies, digests, seed. The browser "verify this game" panel and the CLI verifier both
replay it with the same TS mirror of the dice ladder.

**Never** per-roll outcome commitments (N commitments can all open to the same value).

## Ledger state (sketch — final layout follows circuit measurements)

- Constructor args: `tableId: Bytes<32>` (fresh random — `kernel.self()` is zeros in
  constructors), `tier: Uint<64>`, `maxSeats: Uint<8>`, `rakeAddress`,
  `seedCommitment: Bytes<32>`, timeout params `turnTimeoutSecs`, `tableTimeoutSecs`.
- `phase: enum { Filling, Playing, Settled, Aborted }`
- Per seat (≤6): player payout address, `C_s` entropy-key commitment, scorecard (13 packed
  category scores + filled bitmap), `upperTotal`, `total`, `yahtzeeBonuses`,
  `finishedAtTurn`, `forfeited: Boolean`
- `currentSeat`, `round` (0–12), `turnIndex` (global), `pendingTurn` (entropy, policy,
  awaiting-resolve flag, resolved dice of previous turn per seat)
- `gameDigest: Bytes<32>`
- `lastActionAt: Uint<64>` (block-time seconds; predicates are strict, units are seconds,
  no tolerance widening — build grace into the bounds)
- Pot custody: **native unshielded NIGHT, proven by Gate 0** — `join` calls
  `receiveUnshielded(nativeToken(), tier)` (the joining wallet consents by balancing);
  `settle`/`abortTable` call `sendUnshielded` to the payout addresses **recorded at join**,
  so no circuit ever needs to learn its caller and no external "who won" assertion exists —
  `settle` computes the winner in-circuit and pays that seat's stored address.
- Transaction-size floor: every circuit call must produce a ≥ ~8 KB transaction
  (`OutsideTimeToDismiss` — gate0-report.md). Real turn circuits likely clear it; `join`
  and `claimTimeout` may need fallible-phase padding writes. Verified per circuit in tests.

## Exported circuits (≤ 7 — deploy ceiling is ~11 circuits, measured upstream)

| circuit        | caller   | does                                                                                                                                                             |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join`         | player   | stake in, register `C_s`, take next seat; last join flips to Playing and stamps `lastActionAt`                                                                   |
| `takeTurn`     | player   | score previous dice (category, joker rules), declare entropy `H(sk,tableId,r)` + policy for this turn; advances `lastActionAt`                                   |
| `resolveTurn`  | operator | witness seed; derive 3 rolls with policy holds; write dice, update digest; advance turn pointer                                                                  |
| `settle`       | anyone   | all seats finished/forfeited; seed disclosed + checked; winner via tie-break; pay winner (pot − q) and rake (q) with witness-checked `q*100 + r == pot, r < 100` |
| `claimTimeout` | anyone   | `blockTimeGt(lastActionAt + turnTimeoutSecs)`: forfeit the stalled seat's remaining categories (scored 0), advance turn                                          |
| `abortTable`   | anyone   | `blockTimeGt(lastActionAt + tableTimeoutSecs)` while unresolved (operator vanished): refund `tier` to every seated player, nothing to rake                       |

Timeout deadlines use the sandwich discipline from the field notes: the claim is a
refund/forfeit, never compensation, so a tight deadline can't be farmed.

Scoring in-circuit: the 13-category mux over 5 dice, upper bonus at 63, Yahtzee bonus.
Whether the full forced-joker placement rule fits the circuit budget is decided with
measurements; if it must simplify (extra Yahtzee = +100 + any open category at full joker
value, no forced placement), the TS rules engine and the site rules text change with it —
the two must never diverge.

## Operator service consequences

- The seed is the only thing whose loss aborts a table: persisted to disk at commit time,
  before the table opens, keyed by table address.
- One wallet per daemon; resolves strictly sequential; restart after any node_modules patch.
- The operator never holds discretion over an outcome — resolves are mechanical, timeouts are
  permissionless (anyone can call), and settlement is verifiable by anyone.
