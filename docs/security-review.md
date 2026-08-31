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
- **Suggestion:** document that the hash-based commitments' hiding property _requires_
  full-width CSRNG secrets (`sk_s`, seed, operator secret) — a precondition the contract
  cannot enforce; belongs in the operator/client docs. `persistentCommit` with a blinding
  nonce would be required only if a _narrow_ value were ever committed this way.

## 2. Security & Cryptographic Correctness

- **CRITICAL — declared-time slack weaponised against the next actor.** `stampTime` lets a
  caller under-declare `now` by up to `timeSlackSecs()` (600 s), and the stamped
  `lastActionAt` sets the deadline for a _different_ seat. With `turnTimeoutSecs ≤ slack`,
  the actor handing the turn over makes the victim's deadline already expired on arrival,
  then cascades permissionless `claimTimeout` to forfeit every rival — converting "the
  operator can only freeze" into "operator or any player eliminates rivals on demand".
  **Fix:** constructor asserts `timeout > slack × 4` for both timeouts; shrink
  `timeSlackSecs()` to proving/submission-latency scale. Status: **fix queued**.
- **HIGH — `seedCommitmentOf` omits `tableId`** (the one exception to the codebase's
  domain-separation discipline). An accidentally reused seed across two tables gives both
  the same on-chain commitment; the first table's settle (public seed reveal, by design)
  then hands any observer the live second table's full future randomness. **Fix:** bind
  `tableId` into the commitment; update `resolveRoll*`/`settle` call sites. Status:
  **fix queued**.
- **Low:** `entropyKeyCommitment` omits `tableId` — cross-table seat linkability when a
  client reuses `sk_s` (no dice-fairness impact; `forcedEntropy` re-binds `tableId`).
  Fix queued + client rule: fresh `sk_s` per table.
- **Low:** `join` accepts a zero `payoutTo` (self-harm only). Fix queued.

Positives: structural authorisation binds to ledger state (no caller-supplied seat); rake
division is a uniquely-witnessed Euclidean identity; KeepModal's witness check fully
constrained; double-join/-settle/-score closed by the phase machine; assert messages leak
nothing.

## 3. Token & Economic Security

- **Medium — the split resolve must be re-verified for timeout coverage** (raised against
  code the reviewer had not seen): a mid-resolve sub-state that neither `claimTimeout`
  (needs `waitPlayer`) nor `abortTable` (needs `waitResolve`) recognises would trap the pot;
  `lastActionAt` stamping across the three steps must match the timeout math. Status:
  **explicit tests required post-E2E**.
- **Medium — no offline test can catch a wrong token amount/colour/recipient**
  (`unshieldedBalance` is always 0 in the simulator — upstream bug #11). The hand-trace in
  this review is currently the only guard. **Release gate:** the per-circuit indexer UTXO
  audit against the real `table.compact` circuits (`join` moves exactly tier in; `settle`
  spends zero user inputs and creates exactly pot−q / q; `abortTable` creates exactly
  seatCount × tier). Status: **being executed by the E2E run**.
- **Low:** no upper bound on `tier` — an extreme tier could overflow `abortTable`'s refund
  multiplication (checked cast aborts → refund path denied) while `settle` still works.
  Fix queued: `maxTier()` assert at construction.
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
  Status: **recorded here + api docs**.
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
  back a lost stake by refusing to settle. Status: **fix queued**.
- **Medium:** game reconstruction depends on the indexer's historical transaction log, not
  ledger snapshot state (per-turn cells are overwritten; the digest verifies but cannot
  enumerate). Stated integration requirement for the spectator feed / verifier; the E2E
  chain-only verifier is the proving test. Status: **verified by the E2E verifier**.
- **Low:** several ledger fields rely on implicit zero-default — add explicit constructor
  inits for self-documentation. **Low:** padding size constant duplicated between
  `paddingWords()` and the struct literal (partially mooted by the E2E padding rework).

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

Applied together after the E2E run releases `contract/` (in flight at review time):
settle timeout-bypass (C1), timeout-vs-slack constructor floor + reduced slack (C2),
`tableId` into both commitments (H1, L1), zero-address and max-tier asserts (L2, L3),
explicit zero-inits + disclose-convention pass (cosmetic), split-resolve timeout-coverage
tests (M1), and the client-side join-retry + fresh-sk-per-table rules into the api docs.
Every fix lands with simulator tests; the UTXO release gate stays with the E2E evidence.
