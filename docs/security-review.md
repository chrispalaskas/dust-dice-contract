# Compact Code Review Report — Table & Lobby

Five focused reviewers (privacy & disclosure, security & cryptographic correctness, token &
economic security, concurrency & contention, architecture & state design) ran concurrently
against `contract/src/table.compact`, `lobby.compact`, `table-witnesses.ts` and the included
building blocks, each primed with the design docs and the known simulator blind spots. Two
claims were additionally verified mechanically (executed simulator probe + compiler-source
trace), and the witness surface was verified by the witness-verification pipeline
(type-check with negative controls, structural checklist, execution with wrong-seed /
wrong-secret aborts).

Reviewed at the pre-E2E commit; the `resolveTurn → resolveRoll1/2/3` split landed mid-review
(see Medium #4). Status column tracks the remediation commit.

**Remediation status: every Critical, High and Low finding below is FIXED**, in `table.compact`
and `policy-core.compact`, with simulator tests named per finding. The contract test suite is 130
green (119 before, 11 added), and `npm run k -w cli` reports every exported circuit unchanged and
at or below k=15 — the fixes cost no PLONK steps. The two Mediums that were never in-contract
(the E2E UTXO audit, the join-storm client rule) are recorded where they belong; see
[client-rules.md](client-rules.md). Recompiling changed the verifier keys, so the E2E table
deployed at review time is historical evidence and its address is dead — expected and accepted.

## Summary

| Severity    | Count |
| ----------- | ----- |
| Critical    | 2     |
| High        | 1     |
| Medium      | 4     |
| Low         | 6     |
| Suggestions | 3     |

## 1. Privacy & Disclosure — clean

No Critical/High/Medium. Both mid-game secrets handled exactly as designed: `sk_s` and the
seed are never disclosed — only boolean assertion results — until the single intentional
`disclose(seed)` at `settle`. Nine distinct hash domains, no cross-purpose reuse. Findings:

- **Low (cosmetic):** `disclose()` convention inconsistency on witness-tainted asserts
  between `table.compact` and `policy-core.compact`'s `resolveDiceChecked`.
  Status: **fixed** — the modal-face asserts in both `resolveDiceChecked` and
  `firstRollChecked` (the split's live path) are now `assert(disclose(...))`, matching
  `table.compact` throughout. No behaviour change; no measured cost.
- **Suggestion:** document that the hash-based commitments' hiding property _requires_
  full-width CSRNG secrets (`sk_s`, seed, operator secret) — a precondition the contract
  cannot enforce; belongs in the operator/client docs. `persistentCommit` with a blinding
  nonce would be required only if a _narrow_ value were ever committed this way.
  Status: **documented** — [client-rules.md](client-rules.md) rules 1 and 2.

## 2. Security & Cryptographic Correctness

- **CRITICAL — declared-time slack weaponised against the next actor.** `stampTime` lets a
  caller under-declare `now` by up to `timeSlackSecs()` (600 s), and the stamped
  `lastActionAt` sets the deadline for a _different_ seat. With `turnTimeoutSecs ≤ slack`,
  the actor handing the turn over makes the victim's deadline already expired on arrival,
  then cascades permissionless `claimTimeout` to forfeit every rival — converting "the
  operator can only freeze" into "operator or any player eliminates rivals on demand".
  **Fix:** constructor asserts `timeout > slack × 4` for both timeouts; shrink
  `timeSlackSecs()` to proving/submission-latency scale. Status: **FIXED**.
  `timeSlackSecs()` is 120 (was 600); `timeoutSlackFactor()` is 2 (was 4 until 2026-09-04, when
  fast tables adopted 300 s rounds — the worst shave then leaves 180 s of a 300 s window, and the
  slack was kept at 120 s because it must also absorb a wallet's approval prompt); the constructor asserts
  `turnTimeout > timeoutFloor` and `tableTimeout > timeoutFloor` with
  `timeoutFloor = timeSlackSecs() * timeoutSlackFactor()` = 240 s, strictly. Tests:
  `refuses any timeout at or below four times the declared-time slack` (both timeouts, four
  values below the floor plus the boundary, then floor + 1 accepted, then the cascade itself: a
  seat that receives the turn after a maximally under-declared hand-off is **not** immediately
  forfeitable) and the updated
  `refuses a table whose configuration cannot be settled honestly`. The file-header claim that
  "under-declaring brings their OWN deadline forward" was **wrong for every hand-off
  transition** and is corrected in `table.compact` decision 5, which now names the three
  circuits that stamp a deadline for a different party. Client-side counterpart:
  [client-rules.md](client-rules.md) rule 5. Callers updated: `cli/src/timeouts.ts`'s scenario
  timeouts were 60 s / 90 s and are now 481 s / 541 s, which is the floor's real cost — that
  demo now waits ~8 and ~10 minutes rather than ~1.5.
- **HIGH — `seedCommitmentOf` omits `tableId`** (the one exception to the codebase's
  domain-separation discipline). An accidentally reused seed across two tables gives both
  the same on-chain commitment; the first table's settle (public seed reveal, by design)
  then hands any observer the live second table's full future randomness. **Fix:** bind
  `tableId` into the commitment; update `resolveRoll*`/`settle` call sites. Status:
  **FIXED**. `seedCommitmentOf(tableId, seed) = H("yahtzee:v1:seed", tableId, seed)`, a
  3-element vector hash. Call sites updated: `resolveRoll1`, `resolveRoll2`, `resolveRoll3`,
  `settle`, the `seedCommitmentTs` mirror in `contract/src/policy-mirror.ts`, the test harness
  (`tableConfig`), `cli/src/demo.ts`, `cli/src/timeouts.ts` and `cli/src/verify.ts`. Tests:
  `seats players, stakes the pot, chains the digest and flips to playing` (the deploy-time
  commitment), `plays 13 rounds with mixed policies and settles to the reference winner` (the
  reveal opens it), and the whole existing wrong-seed corpus, which still bites. The extra
  32 bytes cost **no** PLONK steps: `resolveRoll1/2/3` stay at k=15.
- **Low:** `entropyKeyCommitment` omits `tableId` — cross-table seat linkability when a
  client reuses `sk_s` (no dice-fairness impact; `forcedEntropy` re-binds `tableId`).
  Status: **FIXED** — `entropyKeyCommitment(tableId, sk)`, same 3-element shape, updated in
  `join`, `takeTurn`, the `entropyKeyCommitmentTs` mirror, the harness and `replayGame`. `join`
  and `takeTurn` stay at k=14. Client rule (fresh `sk_s` per table) is
  [client-rules.md](client-rules.md) rule 1. **Consequence worth recording:** the commitment is
  hashed into the join digest and the join digest feeds every roll, so this changed every die at
  every table. The three swept tie-break table ids in `src/test/table.test.ts` were re-swept
  (36 → 113, 18 → 16, 10 → 6); the joker id 30 still produces its double Yahtzee. That the old
  ids stopped tying is the intended loud break.
- **Low:** `join` accepts a zero `payoutTo` (self-harm only). Status: **FIXED** —
  `assert(who != default<UserAddress>, ...)` in `join`. Test:
  `refuses a join that would record the zero payout address`, which also pins that the rejected
  join takes no seat and stakes nothing.

Positives: structural authorisation binds to ledger state (no caller-supplied seat); rake
division is a uniquely-witnessed Euclidean identity; KeepModal's witness check fully
constrained; double-join/-settle/-score closed by the phase machine; assert messages leak
nothing.

## 3. Token & Economic Security

- **Medium — the split resolve must be re-verified for timeout coverage** (raised against
  code the reviewer had not seen): a mid-resolve sub-state that neither `claimTimeout`
  (needs `waitPlayer`) nor `abortTable` (needs `waitResolve`) recognises would trap the pot;
  `lastActionAt` stamping across the three steps must match the timeout math. Status:
  **VERIFIED, no hole**. `abortTable`'s `operatorStalled` keys off `turnState == waitResolve`,
  which all three `rollStep` values share, and `takeTurn` only enters `waitResolve` while
  `round < lastRound()`, so a mid-resolve state is always `waitResolve` at `round ≤ 12`. Tests:
  `exits a stall at every one of the three resolve steps` (all three stop points; `claimTimeout`
  still correctly refuses; the abort deadline boundary is exact at each; the refund is exactly
  `tier × seatCount` and the pot reaches 0) and `empties the pot from every reachable state`.
  On the stamping question the answer is a real behavioural note rather than a bug: **each of
  the three steps calls `stampTime`**, so an operator taking each step at the last legal second
  holds a table for ~`3 × tableTimeoutSecs`. That is correct — every step is a genuine state
  advance — but the parameter bounds one step's silence, not one turn's, and an operator SLA has
  to be written against that. Pinned by
  `restarts the table deadline at each resolve step, so the bound is per step` and documented in
  `abortTable`'s doc comment.
- **Medium — no offline test can catch a wrong token amount/colour/recipient**
  (`unshieldedBalance` is always 0 in the simulator — upstream bug #11). The hand-trace in
  this review is currently the only guard. **Release gate:** the per-circuit indexer UTXO
  audit against the real `table.compact` circuits (`join` moves exactly tier in; `settle`
  spends zero user inputs and creates exactly pot−q / q; `abortTable` creates exactly
  seatCount × tier). Status: **still the release gate, and must be re-run**. The E2E evidence
  from the pre-fix contract stands as evidence about the token paths, which these fixes did not
  touch — but the recompile changed the verifier keys, so the audited deployment is dead and the
  gate has to be re-executed against the new artifact before release. The gate now has one extra
  row: a **force-settled** table (`settle` past the deadline with no valid seed) must create the
  same two outputs as an honest settle.
- **Low:** no upper bound on `tier` — an extreme tier could overflow `abortTable`'s refund
  multiplication (checked cast aborts → refund path denied) while `settle` still works.
  Status: **FIXED** — `maxTier()` is 10^15 atomic units and the constructor asserts
  `stake <= maxTier()`. At the bound the widest table's `tier * maxSeats()` is 6 × 10^15, far
  inside `Uint<64>`. Test: `refuses a tier above the maximum, and accepts the maximum itself`,
  which pins both sides of the boundary **and** actually refunds a six-seat table staked at
  `maxTier()` through `abortTable` — the multiplication the bound exists to protect.
- **Low (residual, accepted):** idle-seat griefing costs the griefer their own stake and
  pays the claimant nothing — confirmed not an economic exploit.

Positives: conservation exact on every terminal path (sum of sends == pot, pot zeroed
atomically with the sends); the unrolled conditional refund loop mechanically confirmed
correct twice (executed probe + compiler-source trace: guarded ledger writes lower to
ZKIR's native `impact` primitive — no zero-value placeholder sends); forfeited stakes stay
in the pot with no leak path; the lobby has zero token exposure.

## 4. Concurrency & Contention — clean

No Critical/High. The checkpoint is used _only_ for padding: every assert and substantive
write is guaranteed-phase, so losing a race fails atomically — a losing `join`'s stake is
never at risk. `takeTurn`/`resolveTurn` and `settle`/`abortTable` have no overlapping
eligibility windows by construction; timeout deadlines check real chain time.

- **Medium:** join-storm on a filling table degrades to opaque whole-state proof-mismatch
  rejections (at most one join lands per block; losers can't tell "lost a race" from
  "table full"). Not fixable in-contract. **Client rule:** on any join failure, re-read
  `seatCount`/`seatLimit`/`phase` from the table itself before retrying with a fresh proof.
  Status: **documented** — [client-rules.md](client-rules.md) rule 3.
- **Low:** stale lobby entry points a client at a closed table — already covered by the
  documented "read the table itself before staking" rule; wasted proof only.
- **Suggestion:** lobby `openedCount`/`closedCount` → `Counter` (zero-cost hardening);
  do NOT convert table's coupled read-modify-write fields (seat assignment, pot, cursor) —
  recorded so a future contributor doesn't "fix" them into a real bug.

## 5. Architecture & State Design

- **CRITICAL — finished-but-unsettled table traps the pot.** Terminal state
  (`Playing`, `waitPlayer`, `round ≥ roundCount()`) is exited only by `settle`, which
  requires the operator's seed; `abortTable`'s `operatorStalled` keys off `waitResolve` and
  never matches. A vanished operator permanently locks every stake — breaking the design's
  own core invariant. **Fix (chosen):** `settle` bypasses the seed-equality check once
  `blockTimeGt(lastActionAt + tableTimeoutSecs)` — the winner is fully determined by public
  state and every resolve was individually ZK-proven, so soundness never rested on the
  reveal; the game is merely marked unverified (revealedSeed stays zero). This pays the
  rightful winner instead of refunding — a refund path would let a colluding operator claw
  back a lost stake by refusing to settle. Status: **FIXED**. `settle` now computes
  `opens = seedCommitmentOf(tableId, s) == seedCommitment` and
  `graceExpired = blockTimeGt(lastActionAt + tableTimeoutSecs)`, asserts `opens || graceExpired`,
  and writes `revealedSeed = opens ? s : default<Bytes<32>>`. Everything else — the winner, the
  tie-break, the rake identity, the recorded payout addresses — is untouched, which is the whole
  argument: the seed was never load-bearing for soundness, only for verifiability. `settle` takes
  no `now`, so the deadline is read from real block time and there is nothing to under-declare.
  Tests, in `describe('the settle deadline bypass')`:
  `refuses a wrong seed before the deadline, at the boundary second`;
  `pays the in-circuit winner with a wrong seed once the deadline has passed` (same winner, same
  address, pot drained, `revealedSeed` zero, and the zero marker asserted **not** to open the
  commitment); `still records a correct seed when settled after the deadline` (the bypass is a
  waiver, not a switch); `does not let the bypass settle an unfinished game`; and
  `reaches the finished state via a forfeit too, and exits it the same way` — the trap is
  reachable both by the last score-only `takeTurn` and by a `claimTimeout` on the last seat of
  round 13, and both now exit. Client/verifier counterpart:
  [client-rules.md](client-rules.md) rule 4, implemented in `cli/src/verify.ts`, which reports a
  zero `revealedSeed` as _unverifiable_ rather than as a failed check.

  **The honest cost:** a force-settled game cannot be replayed offline, ever. Nobody — including
  the players — can re-derive its rolls from the log. It is still sound (every roll was proven
  against the commitment in its own transaction while the game was live) and the money is still
  paid correctly; what is lost is the ability to re-check that later without trusting the chain's
  own verification. That is the right trade against losing the pot.

- **Medium:** game reconstruction depends on the indexer's historical transaction log, not
  ledger snapshot state (per-turn cells are overwritten; the digest verifies but cannot
  enumerate). Stated integration requirement for the spectator feed / verifier; the E2E
  chain-only verifier is the proving test. Status: **verified by the E2E verifier**.
- **Low:** several ledger fields rely on implicit zero-default — add explicit constructor
  inits for self-documentation. Status: **fixed** — sixteen fields are now written explicitly in
  the constructor, with a comment naming the two whose initial value is load-bearing
  (`lastActionAt` stays 0 so the filling deadline starts at the first join; `revealedSeed` stays
  zero until a settlement that actually opened the commitment). `padStore` is deliberately
  excluded — it is a transaction-padding sink, and initialising it would add 2 KB to every
  deploy for nothing. Constructors are not proved, so this is free; the k table is unchanged. **Low:** padding size constant duplicated between
  `paddingWords()` and the struct literal (partially mooted by the E2E padding rework).

**The full stall matrix, walked** (`describe('the stall matrix: every reachable state has a
permissionless exit')`). Every reachable `(phase, turnState, rollStep, round)` combination and the
circuit that empties the pot from it:

| phase       | turnState     | rollStep | round | exit                                           |
| ----------- | ------------- | -------- | ----- | ---------------------------------------------- |
| `filling`   | —             | —        | —     | `seatCount == 0`: none needed, nothing staked  |
| `filling`   | —             | —        | —     | `seatCount > 0`: `abortTable` (fillingStalled) |
| `playing`   | `waitPlayer`  | —        | < 14  | `claimTimeout`                                 |
| `playing`   | `waitPlayer`  | —        | ≥ 14  | `settle` — **was the trap**, now exits         |
| `playing`   | `waitResolve` | 0        | ≤ 12  | `abortTable` (operatorStalled)                 |
| `playing`   | `waitResolve` | 1        | ≤ 12  | `abortTable` (operatorStalled)                 |
| `playing`   | `waitResolve` | 2        | ≤ 12  | `abortTable` (operatorStalled)                 |
| `abandoned` | —             | —        | —     | `abortTable`, no further waiting               |
| `settled`   | —             | —        | —     | terminal, pot already 0                        |
| `aborted`   | —             | —        | —     | terminal, pot already 0                        |

Two structural facts make the table complete rather than merely long. `waitResolve` is only ever
entered by `takeTurn` while `round < lastRound()`, so no `waitResolve` row can carry `round ≥ 13`
— asserted in the test rather than argued. And a `claimTimeout` that forfeits the last active seat
goes to `abandoned` **before** advancing the cursor, so `(playing, waitPlayer, round ≥ 14)` with
zero active seats is unreachable. Every row above is exercised by a test that ends with
`pot == 0`.

Positives: seat-map pre-insertion kills the absent-key abort class; ledger visibility
discipline (sealed config, exported exactly what spectators need); witness-computes/
circuit-verifies pattern textbook; Lobby↔Table isolation structural; the timeout matrix
otherwise fully covered.

## Mechanical verification

- Guarded `sendUnshielded` conditionality: **CONFIRMED** by execution (spend map empty at
  threshold 0 — no zero-value entries; effects scale exactly; transcript +36 ops per
  executed send) and by compiler source (`reduce-to-circuit.ss` threads the branch test into
  ZKIR's guarded `impact` instruction). Corollaries: the runtime does **not** enforce
  solvency (the `pot == refunded` assert is load-bearing), and a guard exceeding the loop
  bound caps silently (unreachable here while `seatLimit ≤ 6`).
- Witnesses (`playerEntropySecret`, `rollSeed`, `modalFaceHint`): **CONFIRMED** — types,
  structure, and execution, with wrong-seed / wrong-secret negative controls aborting on the
  right assertions.

## Remediation plan

**Applied.** Settle timeout-bypass (C1), timeout-vs-slack constructor floor + slack reduced
600 → 120 (C2), `tableId` into both commitments (H1, L1), zero-address and max-tier asserts
(L2, L3), explicit zero-inits + disclose-convention pass (cosmetic), the split-resolve
timeout-coverage matrix (M1), and the client rules in [client-rules.md](client-rules.md).

Measured after the fact, so the claims are checkable rather than asserted:

- contract tests **130 green** (119 before, 11 added), `npm test -w @yahtzee/contract`
- `npm run k -w cli`: **every exported circuit unchanged** — `join` 14, `takeTurn` 14,
  `resolveRoll1/2/3` 15, `settle` 13, `claimTimeout` 11, `abortTable` 12, lobby 13/13. The three
  resolve circuits were already at the k=15 ceiling with no headroom, and widening two
  commitment hashes from 2 to 3 elements did not move them: 64 and 96 bytes occupy the same
  number of SHA-256 compression blocks.
- instruction counts moved slightly and are re-measured in
  [table-circuit.md](table-circuit.md) §3.

**Still open, and not in-contract:** the per-circuit indexer UTXO audit, which must be re-run
against the recompiled artifact (see §3), now including a force-settled table.
