# The fast turn: off-chain interaction, one-transaction settlement

**Status: researched and judged FEASIBLE — not yet implemented.** This document records the
feasibility analysis (2026-09-02), the source evidence it rests on, and the open engineering
questions an implementation must answer first. v1's interactive on-chain turn (7 transactions,
~24 s each) stays the shipping path until this replaces it.

## The problem

A full 3-roll turn is seven transactions — four from the player, three operator resolves — each
paying ~20-30 s of prove+submit+inclusion. The dice feel arrives at chain speed. Two obvious
"fixes" were proposed and are **unsound**, for reasons worth recording so they stay dead:

1. **"Hand the player all three roll seeds up front, roll locally."** Any scheme where the
   player can locally evaluate the next roll before irrevocably committing a hold is broken by
   enumeration: 32 hold masks per step, so the player computes every branch and plays the whole
   game tree with perfect information. Local determinism + a small choice space IS lookahead.
   Unpredictability at each decision point must come from a party who withholds information
   until the choice is committed. No seed-splitting scheme escapes this.

2. **"Player generates ZK proofs per roll locally, submits only the final state."** Three
   independent failures:
   - the dice derive from the OPERATOR's secret seed, which the player must never hold
     mid-game, so the player alone cannot prove roll correctness;
   - a monolithic all-three-rolls circuit compiles to k=17 against a proof-server SRS ceiling
     of k=15 — measured, not estimated (it is why the cursor model's `resolveTurn` never
     produced a transaction; docs/bugs-found.md #13);
   - Compact has no proof recursion or aggregation to fold three k≤15 proofs into one. The
     compiler actively rejects circuit recursion
     (`compiler/analysis-passes/reject-recursive-circuits.ss` in LFDT-Minokawa/compact), and
     the ledger's proof machinery (`transient-crypto/src/proofs.rs`, zkir) has no aggregation
     surface. Source-verified 2026-09-02.

## The design that works

A state-channel-style overlay. The interaction moves off-chain; the verification stays
on-chain, using the existing seven k≤15 circuits unchanged:

1. **Fast open (on-chain, 1 player tx).** The player opens the turn flagged "fast". Unavoidable
   and load-bearing: it publishes the forced entropy `H(sk, tableId, round)` and closes the
   interactive on-chain path for this turn (see "defection", below).
2. **Off-chain ping-pong.** The player sends a signed hold; the operator answers with the next
   roll immediately. Dice latency drops from ~24 s to network round-trip. The operator reveals
   roll _i_ only after holding the player's signed, irrevocable choice _i_.
3. **Settlement (on-chain, ideally 1 tx).** The full transcript — open already on chain, then
   resolve1, hold, resolve2, hold, resolve3, score — is submitted as ONE transaction composed
   of the existing circuits as sequential calls.

### Why this adds no new trust

- The operator already knows the seed, and once the player's entropy is public it can compute
  the player's entire game tree. "The operator does not leak the tree" is ALREADY v1's trust
  assumption; off-chain reveals gated on signed holds add nothing to it.
- No re-roll grinding by abandonment: dice are `H(seed, forcedEntropy, round, step)` and the
  entropy is forced per (seat, round) — replaying the turn through any path reproduces
  identical dice. The anti-collusion entropy scheme is what makes the overlay safe.

### The defection hazard, and its fix

After seeing roll 2 off-chain, the player must not be able to re-choose hold 2 on-chain
(knowing the kept-dice merge semantics, one observed roll reveals the fresh-dice stream, i.e.
full lookahead for that step). Fix: the fast open closes this turn's interactive on-chain
path — the transcript settlement is the only way the turn can end. Consequence accepted: if
the operator vanishes mid-fast-turn, the seat parks until the existing operator-stall abort
refunds the table. Safe, mildly griefable (a fast-opened seat that vanishes drags the table to
the abort deadline), economically blunted by the resignation discount.

## The platform evidence (source-verified 2026-09-02)

The make-or-break question was whether ONE Midnight transaction can carry multiple sequential
calls to the SAME contract, each call's transcript building on the previous call's writes.
**Confirmed at every level:**

1. **Ledger.** An intent's `actions` is an ordered array with no same-address uniqueness
   constraint; `apply_actions` (midnight-ledger `ledger/src/semantics.rs:1366-1532`) replays
   calls against a RUNNING accumulator (`res.index(call.address)` … `res.update_index(...)`),
   so a later call to the same address is validated against the earlier call's output state.
   The same threading spans intents within one transaction (`apply_section`,
   semantics.rs:1041-1085). Caveat: verified on the `ledger-8` branch source; re-confirm on
   the ledger-9.1 line with an executed probe before building (this project's standing rule).
2. **SDK.** `@midnight-ntwrk/midnight-js-contracts@5.0.0-beta.7` ships
   `withContractScopedTransaction` — circuit calls made in the scope are batched and submitted
   as a single transaction, with in-scope calls advancing the contract state in memory so each
   next call is built against the previous call's output. Underneath: `Transaction.merge`
   (thin wrapper over Rust `Transaction::merge`, ledger-wasm/src/tx.rs:609).
3. **Raw bindings.** `@midnightntwrk/ledger-v9` exposes `Transaction.merge` for unproven and
   proven transactions, so hand-assembly is possible where the SDK helper is too narrow.

**The one real constraint found:** the scoped-transaction helper pins a single
`(contractAddress, privateStateId)` identity per scope — but our seven calls carry TWO
identities (player secret for 4, operator seed for 3). Composing them needs the lower-level
`createUnprovenCallTx` + manual state threading + `merge`, or cooperative assembly of one
intent. **Also note `merge` merges INTENTS, and cross-intent ordering is by segment id — the
seven calls must interleave (open, r1, hold, r2, hold, r3, score), so they likely must live in
ONE intent's action array**, built cooperatively: the player proves their calls against
predicted intermediate states (computable off-chain by both parties, since the sequence is
deterministic once choices are made), ships them to the operator, who proves its three and
assembles. Fallback: settle in 2-3 transactions (player tx + operator tx), still ~3× fewer
than today and with the same instant-dice feel.

## EXECUTED PROBE RESULTS (2026-09-02, ledger-9.1 devnet — probes/concurrency `npm run compose`)

The composition question is now settled by execution, not reading:

- **Sequential same-contract composition: CONFIRMED on our stack.** `bumpShared → setCell →
bumpShared` — three calls, one `withContractScopedTransaction`, ONE submitted transaction
  (`1be46a4f…` block 44; reproduced `e57d20e6…` block 64). The shared read-modify-write chain
  threaded through all three calls (`touches` +2 in one transaction, three contract actions per
  the indexer), which is only possible if each call's transcript read the previous call's
  write. The ledger-8 source reading holds on the ledger-9.1 line.
- **One limitation found (deterministic, measured twice): two ADJACENT calls to the same entry
  point in one scope are rejected** — node error 104, `TransactionInvalid(Transcript)`. Logged
  as docs/bugs-found.md #17 with the repro; the evidence points at the SDK's scope builder,
  not the ledger. The settlement shape (`resolveRoll1, playerMove, resolveReroll, playerMove,
resolveReroll, playerMove`) alternates entry points and never hits it.

Remaining open before implementation: the TWO-IDENTITY assembly (player's 4 proofs + the
operator's 3 in one intent — the probe used one wallet and one private state; the settlement
needs `createUnprovenCallTx` + manual threading or cooperative intent assembly), the fast-open
flag's k budget in `playerMove` (14 of 15), and fast-mode deadline semantics.

## What an implementation must build

- A probe (`probes/` style): two sequential calls to one contract in one transaction on OUR
  devnet, ledger-9.1 — the executed-evidence version of finding 1, plus the one-intent
  assembly question.
- The fast-open flag without a tenth circuit (deploy ceiling): encode in `playerMove(open)`'s
  argument space, and enforce "interactive path closed" in the circuits' stage logic — a k
  budget check is required (playerMove is at k=14 of 15).
- The operator's off-chain endpoint (ops server: WebSocket or long-poll) with signed
  hold/reveal receipts, and transcript persistence beside the seed file.
- Settlement assembly in the daemon; wallet UX for the player's batched proving (Moth proves
  4 calls in one approval ideally — connector implications to check).
- Elimination/abort semantics for fast-mode seats (deadline behaviour above).

## Verdict

Feasible on this exact stack with no new circuits and no new trust assumptions. Expected
effect: dice in milliseconds, a full 3-roll turn settling in one (worst case three)
transactions instead of seven — a 2-player round from ~245 s to roughly one inclusion time.
