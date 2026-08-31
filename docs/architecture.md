# Architecture

Design record for Midnight Yahtzee. Sections marked **GATE 0** hold the answers to the two
blocking questions; nothing downstream of them was built before they were answered with
executed probes on a local devnet.

## Chain target

**Ledger 9 + Moth wallet.** Chosen because:

- compactc 0.34.0 (language 0.26.0) vendors ledger-9.1.0.0-rc.3 and supports cross-contract
  calls — verified end to end on the neighbouring project at compactc 0.34.0 / ledger 9.
- Lace pins ledger-8 bindings and historically cannot reach the ledger-9 line; the Moth
  wallet extension was made to work on ledger 9 (local checkout at
  `~/shielded/moth-wallet`, `local-l9` network preset).
- The design deliberately avoids needing c2c (see Lobby below), but the unshielded-token
  kernel operations and the toolchain we can actually verify against live on the ledger-9
  line.

Version pairing is load-bearing at rc granularity — see the matrix in the README.

## GATE 0, Q1 — native NIGHT custody

**Question:** can a Compact contract receive native (unshielded) NIGHT, hold it as a pot, and
pay it out to a winner + rake address?

**Status: ANSWERED — PROVEN, executed twice end to end.** Full evidence in
[gate0-report.md](gate0-report.md). Two wallets staked native NIGHT into one contract-held
pot; one `payOut` call paid 99%/1% to two distinct user addresses; the decisive transaction
spends zero user inputs and creates 10,000,000 of native NIGHT — value that can only have
come from the contract's balance. All figures read from the indexer's UTXO view (the wallet
facade's aggregate balances misreported — bugs-found #9).

The API at language 0.26.0: `nativeToken()` (= 32 zero bytes, no special-casing),
`receiveUnshielded(color, amount)`, `sendUnshielded(color, amount, Either<ContractAddress,
UserAddress>)`, `unshieldedBalance(color)`. `receiveUnshielded` names no payer — the ledger's
transaction-wide balance check forces the caller's wallet to consent by balancing, which is
exactly right for a stake. Amount/recipient arguments need explicit `disclose()`.

Constraints discovered that the design absorbs:

- **Minimum transaction size ≈ 8 KB** (`OutsideTimeToDismiss`: fixed ~16 ms verification cost
  vs a 0.002 ms/byte allowance, floor 15 ms, not configurable). Small circuits need
  fallible-phase ledger padding (post-`checkpoint` writes add size but not dismiss cost);
  every circuit's transaction size is verified, not assumed. Conversely the proof server's
  SRS lacks small k (k=5) — circuit size is squeezed from both directions.
- **A circuit cannot learn its caller.** Payout recipients are public arguments; the Table
  records each seat's payout address at `join` and `settle` asserts it pays exactly the
  stored address of the in-circuit-computed winner — no external "who won" assertion exists.
- **DUST onboarding is a real step**: winnings generate DUST only if the recipient was
  registered when the payout landed, and registration itself costs DUST
  (`estimateRegistration` → wait → register). The lobby onboarding flow does this before
  seating anyone, and the fee-reserve warning stands.

Design consequences either way:

- **Staked NIGHT stops generating DUST** (DUST accrues to _designated_ NIGHT proportional to
  balance). The UI keeps a fee reserve back when staking and says so.
- **Payouts arrive undesignated.** First designation is free; re-designation costs DUST. The
  winner's UI must surface "designate your winnings" and warn about the empty-tank +
  needed-redesignation deadlock.

Fallback if custody fails: contract-minted table chips minted 1:1 by locking NIGHT, with the
trust boundary documented honestly. We do not fake custody.

## GATE 0, Q2 — transaction budget and turn shape

**Question:** what does one state-changing transaction really cost (proof time + wallet
prompt + inclusion), and what game shape fits inside it?

**Status: ANSWERED — measured on this stack** ([gate0-report.md](gate0-report.md)): average
**20.9 s per transaction** over four distinct circuit calls (proving 1.5 s, balancing 0.4 s,
**submission→inclusion 18.0 s** — 86% of the budget is waiting for the chain, so optimising
circuits buys ≤ 9%; only fewer transactions helps). Deploy 26.2 s. Stable to ~3% across two
independent runs.

Per-roll play is dead on the numbers: 312 tx ≈ **109 min** serial for six players. Per-turn:
78 tx ≈ 27 min (player transactions alone). A 2-player per-turn demo ≈ 9 min — the shape to
aim a live demo at. Batching several calls per transaction is unprobed and inherits the gas
under-declaration defect (~15%/60% failure at 2/3 calls upstream) — not a lever we lean on.

**Chosen shape: (a) one player transaction per turn, plus one operator resolve.** A circuit
cannot derive dice from a seed the contract only holds a commitment to, and the player must
not know the seed — so a turn is a player `takeTurn` (entropy + hold policy + **pipelined**
category choice for the _previous_ turn's dice, which they have seen) and an operator
`resolveTurn` (seed as private witness; derives all three rolls with policy-applied holds
in one circuit). Full design, including the anti-collusion entropy scheme, in
[table-contract.md](table-contract.md).

Budget at the measured 20.9 s/tx: 6-player game ≈ 78 player tx + 78 automated operator
resolves ≈ 54 min wall clock and 13–14 prompts per player — long but within a real Yahtzee
evening. 2-player game ≈ 18 min. Manual per-roll play (b) may be kept as a "showcase" mode
for 2-seat tables only. Full-game settlement (c) is a stretch goal (≈19 000 instructions
extrapolated), go/no-go pending a proving-time measurement against the real proof server.

## Randomness — commit–reveal, never committed outcomes

- No on-chain randomness: the kernel exposes block-time _predicates_ only (verified in the
  neighbouring project's field notes: seconds-based, strict, no error widening, usable in the
  guaranteed phase).
- Operator commits `H(seed)` **at table open, before any player entropy exists**.
- Roll inputs: `hash(seed, entropy_s(r), gameDigest, tableId, round, rollIndex)` with
  **forced** player entropy `entropy_s(r) = H(sk_s, tableId, r)` against a join-time
  commitment, and a running game digest — the hardened scheme closing the operator–player
  collusion grind; full analysis in [table-contract.md](table-contract.md).
- Seed revealed at settlement; a verifier script (and a browser panel) re-derives every roll.
- **Never** per-roll outcome commitments: N commitments can all open to the same value and
  no in-circuit check catches it.

### Dice derivation (rejection ladder)

**Built and measured. Full record in [docs/dice-circuit.md](dice-circuit.md).**

The plan below was wrong in its premise and is kept for the record:

> Compact has no `%` and no `/`. A 1–6 die from hash bytes: take a byte, reduce mod 8 (mask —
> power of two), reject 6 and 7, advance to the next byte. 25% rejection per candidate; a
> 32-byte hash gives ample candidates.

**There is no mask.** Language 0.26 has no bitwise operators at all — `&`, `|`, `^`, `<<`,
`>>` are not even lexed. Masking a byte down to 3 bits would itself cost a 31-comparison
ladder. What the language does give is `Bytes<32>` indexing and `Uint` comparisons, so the
cheap primitive is a **monotone threshold ladder** (`sum of (b >= t_k)`) — and a threshold
ladder need not bucket into a power of two.

**As built:** one candidate is a whole byte, accepted when `b < 252`, bucketed into six
ranges of exactly 42 (`252 = 6 × 42`), so each face has probability exactly 1/6 conditional
on acceptance. **1.6% rejection per candidate, not 25%**; 4 candidates per die for an
exhaustion probability of 5.96 × 10⁻⁸; 20 of the hash's 32 bytes per roll, so **one hash per
roll**. Measured 4.7× cheaper than the 3-bit design above, which was implemented alongside
and rejected on the numbers.

**Measured:** one roll = 464 zkir instructions, 9.50 MiB prover key. A full three-roll turn
(`resolveTurn`) = 1 447 instructions, 18.61 MiB prover key, 58 s to compile with keys, 8 s
with `--skip-zk`. Verifier keys are a constant 2 119 B for every circuit. Cost is linear at
≈490 instructions per additional roll. **Fairness: χ² = 2.64 against a critical value of
11.07** (df=5, p=0.05) over 100 000 derived faces, with the observed candidate-rejection rate
at 1.5351% against the predicted 1.5625%.

Two consequences for the game design:

- **Holding saves nothing in-circuit.** Which dice are held is not known at compile time, so
  the ladder for all five positions exists in rolls 2 and 3 regardless; holding is a select,
  not a skip. The hold policy is likewise free — all policies are evaluated on every proof —
  so keep the policy set small for cost reasons, not just UX ones.
- **The hold mask must be latched from roll 1**, not re-evaluated per roll. Re-evaluating it
  does not compile (docs/bugs-found.md #1). Consistent with "pre-declared hold policy", but a
  compiler-imposed constraint rather than a free choice.

One transaction per turn — shape (a) — is comfortable. Full-game settlement (c) extrapolates
to ≈19 000 instructions and stays a stretch goal pending a proving-time measurement against a
real proof server.

## Rake and integer division

No division in-circuit. Off-chain witness computes `q = pot / 100`, `r = pot mod 100`; the
circuit asserts `q * 100 + r == pot && r < 100`. The remainder `r` goes to the **winner**
(deterministic, documented). Boundary tests at every tier × seat-count combination.

## Ties

No pot splitting (that needs division again). Deterministic tie-break, stated in the site
rules: highest total wins; on a tie, earliest player to have reached the winning total; else
lowest seat index.

## Contracts

Deploys have a low exported-circuit ceiling (~11 measured on the neighbouring project —
re-verify on 0.34.0; stay well under). Pure helper circuits inline and do not count (verify).

- **`Lobby`** — tier registry only. Records per tier the open table address + closed-table
  history. The operator opens tables. Lobby never touches funds and never calls Table —
  **no cross-contract calls anywhere**, so no transaction is multi-call and the gas defect
  is avoided by construction.
- **`Table`** — one deployment per table (~2 min + 1 tx to open; the operator keeps one warm
  per tier). Holds pot, seats, seed commitment, scorecards, turn state, settlement.
  Per-table deployment isolates any bug or stuck game to one pot.

Planned exported circuits on `Table` (6): `join`, `takeTurn`, `resolveTurn`, `settle`,
`claimTimeout`, `abortTable` — see [table-contract.md](table-contract.md).

### Abandonment is first-class

Timeout paths built on block-time predicates, designed and tested **before** the happy path
is polished: after N blocks of inaction the turn is forfeited (anyone can call
`claimTimeout`); after M blocks the table settles among the players who finished. A table
can never trap a pot.

### Deployment pinning

A deployed contract is pinned to the exact compilation that deployed it. Table addresses are
disposable per compilation; the service versions its deployment, detects at startup that the
chain no longer matches the recorded contracts, and redeploys instead of limping. A recompile
mid-tournament strands live pots — the service refuses to start against a version mismatch
while any table is live.

## Operator service

Node daemon: holds seeds, opens tables, drives forced transitions (timeouts), serves the
spectator feed. **One wallet per long-lived process, spends strictly sequential per wallet**
(concurrent DUST spends from one seed race and lose). The operator must never be able to
change an outcome — it commits to seeds before entropy exists and everything else it does is
either mechanical (opening tables) or permissionless (timeouts anyone could call).

## Privacy posture

The base game is open-information; ZK does no work in it and we say so. The one genuine
Midnight-native feature is **anonymous seating** (stretch): prove payment of the tier stake +
hold a seat via commitment + nullifier (one seat per stake, no double-seating) without
linking wallet to play.

## Known platform failure modes designed around

See docs/bugs-found.md §0 (inherited prior art): the `170` error triad, client-side gas
under-declaration on multi-call transactions, read-after-write via one-shot queries,
level-provider deadlock/JSON-dropping, `kernel.self()` zeros in constructors,
`MerkleTree.insertHash` semantics, ZK-config integrity fail-closed default, the
wallet-sdk-utilities override, shielded-sync hang.
