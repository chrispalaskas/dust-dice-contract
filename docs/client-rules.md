# Client and operator rules

Rules a correct client or operator must follow that the **contract cannot enforce for itself**.
Each one is here because a circuit has no way to check it: it is about how a secret was generated,
what a client does after a rejected transaction, or a precondition on off-chain randomness. A
client that ignores them still produces valid transactions — it just weakens a property the design
otherwise gives you for free.

Raised by the review in [security-review.md](security-review.md); the in-contract half of each
fix is in `contract/src/table.compact` and `contract/src/policy-core.compact`.

## 1. A fresh entropy secret per table (player clients)

**Rule:** generate `sk_s` fresh, from a CSRNG, for every table you join. Never reuse one across
tables, and never derive it from something an observer can guess.

**Why:** `sk_s` is the whole of a seat's authorisation and the whole of its per-turn entropy. The
join-time commitment `C_s = H("entkey", tableId, sk_s)` now binds `tableId`, so reusing one secret
at two tables no longer publishes the same commitment at both — that was the linkability finding,
and it is fixed in-circuit. What binding `tableId` does **not** fix is everything downstream of the
secret leaking: anyone who learns `sk_s` can compute every entropy value that seat will ever
publish, and at every table it is used at. One table's compromise should not be every table's.

**Also:** the commitment's hiding property assumes `sk_s` is full-width and unpredictable. These are
plain hashes, not `persistentCommit` with a blinding nonce, which is sound only because the
committed value is a 256-bit CSRNG secret. A secret drawn from a small or guessable space
(a passphrase, a counter, a wallet-derived value with low entropy) can be brute-forced straight out
of the public `C_s`. The contract cannot check this and does not try to.

## 2. A fresh roll seed and a fresh `tableId` per table (operator)

**Rule:** the operator generates `seed` and `tableId` fresh, from a CSRNG, per table, and persists
`seed` to disk **before** the table that commits to it is deployed.

**Why, for the seed:** `settle` publishes it by design. `seedCommitmentOf` now binds `tableId`, so a
seed accidentally reused at two tables produces two unrelated commitments and the first table's
reveal says nothing about the second — that was the High finding, and it is fixed in-circuit.
Reuse is still wrong, because the seed itself is the same value: whoever reads the first table's
settlement can derive the second table's dice from the seed directly, whatever its commitment
looks like. The commitment binding removes the _automatic_ cross-table leak, not the leak.

**Why, for the `tableId`:** it is a domain separator on every roll hash. A reused id replays another
table's dice. It cannot be derived by the contract — `kernel.self()` is zeros inside a constructor
([bugs-found.md](bugs-found.md) #13) — so it is the deployer's responsibility.

**Why, for persistence-before-deploy:** the seed is the only thing whose loss strands a table. An
operator that loses it can no longer resolve a single roll. Since the finished-but-unsettled fix
that is survivable rather than fatal — the table can still be force-settled past its deadline (see
rule 4) — but the game becomes unverifiable, which is a real loss.

## 3. Re-read the table before retrying a failed `join`

**Rule:** on **any** `join` failure, re-read `seatCount`, `seatLimit` and `phase` **from the table
contract itself** before building another proof. Do not retry against the state you already had,
and do not trust the lobby's view.

**Why:** at most one `join` can land per block, because every join reads and writes `seatCount`,
`pot` and the seat maps. On a filling table several clients race, and the losers get an opaque
whole-state proof-mismatch rejection that looks identical whether the table filled up or you simply
lost the race. Nothing in the contract can distinguish those for you — the rejection happens before
any of its asserts run — so the client has to re-read to tell "try again" from "this table is
gone". Retrying blindly burns a proof per attempt and, on a table that actually filled, never
succeeds.

The lobby is a convenience index and can be stale: it may point at a table that is already full or
already settled. The tables are the security boundary; the lobby is not. Read the table.

## 4. Treat a zero `revealedSeed` on a settled table as "unverifiable", not as a failure

**Rule:** when `phase == settled`, check `revealedSeed` before attempting a replay. All-zero means
the game was **force-settled**: nobody produced a valid seed before the table deadline, so `settle`
paid the winner computed from public state and left the seed field blank. Render that as
_unverified_, never as _verification failed_ and never as _not settled yet_.

**Why:** the payout is unaffected — the winner, the tie-break and the rake split are all functions
of public ledger state, and every roll was proven against the commitment in its own transaction
while the game was live. What is missing is the ability to _re-derive_ the rolls offline afterwards.
A verifier that reports this as a failure is telling the user the chain misbehaved, which it did
not. `cli/src/verify.ts` implements exactly this check.

## 5. Declare `now` honestly

**Rule:** clients pass the current wall-clock time (in seconds since the epoch) as `now`, not the
oldest value the contract will accept.

**Why:** the kernel exposes block-time predicates and no accessor, so `lastActionAt` is declared and
sandwiched into `(blockTime − timeSlackSecs(), blockTime]`. Under-declaring is the only direction
available and it is bounded, but on a hand-off transition — `takeTurn`, `resolveRoll3`,
`claimTimeout` — the deadline you stamp belongs to **someone else**. The slack is now 120 s and the
constructor refuses any timeout below `120 × 4`, so the worst a hostile client can take from the
next actor is a quarter of their window; that is a bound, not a licence. Honest clients should
declare the truth and leave the bound unused.
