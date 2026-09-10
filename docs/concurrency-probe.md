# Concurrency probe report

> **Verdict — neither.** Binding is **per-read, not per-path and not whole-state**: a
> transaction is rejected only if a ledger value its transcript actually _read_ has changed
> since it was proved, so two wallets writing different keys of the same `Map` both land in the
> same block — and so do two wallets writing the **same** key, last-write-wins, with no
> rejection at all.

Every number below came from a transaction that was submitted to a running chain. Nothing here
rests on reasoning about the protocol, and every landed write was confirmed by reading the
contract's ledger back with a one-shot query rather than by trusting the submitting client.

Probe code and re-run instructions: [`../probes/concurrency/`](../probes/concurrency/README.md).
Raw evidence: `probes/concurrency/.run/` (`attempts.jsonl`, `outcomes.json`,
`nodelog-yzconc-full.log`).

## Environment

| Component          | Version / endpoint                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| midnight-node      | `2.0.0-rc.4` (vendors ledger `9.1.0.0-rc.3`), `ws://127.0.0.1:9954`                               |
| indexer-standalone | `4.4.0-pre-alpha.16-l91r3-n2r3-…`, `http://127.0.0.1:8098/api/v4/graphql`                         |
| proof-server       | `9.0.0-rc.5_experimental`, `http://127.0.0.1:6310`                                                |
| Compact            | CLI `0.5.1`, compactc `0.34.0`, language `0.26.0`                                                 |
| SDK                | `@midnight-ntwrk/midnight-js-* 5.0.0-beta.7`, `wallet-sdk 2.0.0-beta.2`, `compact-runtime 0.19.0` |
| networkId          | `undeployed`                                                                                      |

Probe contract `cells.compact` at `970a243c0ca104fc7100abdda02147ed329fbba9a6aef09d6ed55cec5682dec2`.
All five circuits compile to PLONK domain **k=13**, inside the proof server's bundled SRS window
of 9..15. Deploy transaction: 15,462 bytes, over the ~7,984-byte admission floor. Proving took
~0.5 s per call; submission to inclusion ~20 s; block time ~6 s.

**This ran on a second, isolated devnet, not the repo's main one.** That was not a preference.
The main stack shares the genesis seed with the live game's operator
(`service/src/config.ts` defaults `OPERATOR_SEED` to `GENESIS_SEED`), and partway through the
first attempt it stopped accepting transactions altogether — from block 3116 onward, no
transaction from any wallet validated again, plain transfers included. That is logged as
`docs/bugs-found.md` #15. Restarting it would have cleared the wedge and destroyed the live
game with it, so `probes/concurrency/docker-compose.yml` brings up a parallel stack on host
ports offset by 10. The probe chain carried **no traffic but this probe's**, which is what makes
the node-log evidence below unambiguous.

## Method

### Making "concurrent" real

`deployed.callTx.X()` is one opaque call that proves, balances, submits and waits for
inclusion. Firing two of those from two processes proves nothing: each finishes when it
finishes, so the "concurrent" pair is usually a sequential pair with extra steps.

The barrier (`probes/concurrency/src/barrier.ts`) goes in the one place that separates the slow
work from the race — the `submitTx` provider callback, which midnight-js calls **last**. Each
process arrives holding a fully proved, balanced and signed transaction built against the same
starting contract state, announces itself on the filesystem, and blocks. When everyone has
arrived they compute one shared absolute fire instant and sleep to it.

It worked: across all 18 concurrent rounds the `submitTransaction` calls were **0–2 ms apart**,
and every round's landed transactions shared a **single block** — including the six-wallet
rounds.

One wallet per OS process throughout. Two wallets in one process would have raced their own
DUST spends and lost (`docs/bugs-found.md` §0 #8/#22) — a failure indistinguishable from the one
under test.

### Reading the result

Per round: read the ledger with a one-shot `queryContractState` before and after (never
`contractStateObservable`, which misses rapid successive updates — §0 #11), record each
attempt's inclusion or exact client error, and capture the node's own log. Written values are
round- and wallet-stamped so the read-back says _which_ write survived, not merely that one did.

### The experiments

Six write shapes, three rounds each, run **twice**: strictly sequentially (the D baseline) and
concurrently.

| Exp | Concurrent group                  | What it isolates                              |
| --- | --------------------------------- | --------------------------------------------- |
| A   | `setCell(0,·)` ‖ `setCell(1,·)`   | disjoint `Map` keys, sharing the padding cell |
| B   | `setCell(0,·)` ‖ `setCell(0,·)`   | the **same** `Map` key                        |
| C   | `bumpShared()` ‖ `bumpShared()`   | read-modify-write of a shared scalar          |
| E   | `bumpCounter()` ‖ `bumpCounter()` | `Counter.increment` on a shared cell          |
| F   | `setCellA(2,·)` ‖ `setCellB(3,·)` | disjoint keys **and** a private pad slot each |
| G   | six wallets, `setCell(0..5)`      | the design question at its stated width       |

The D baseline is what makes the rest readable: without it, a concurrent failure could not be
told apart from the platform's ordinary flakiness (`InvalidDustSpendProof` is transient and its
client error is indistinguishable from a permanent one — #6).

Two comparisons carry the argument. **A vs F** isolates the padding, which is mandatory —
without it the node refuses the transaction outright (#3) — and which every circuit therefore
writes: in A both transactions write the shared `padStore`, in F each writes its own slot, so
F's two transactions intersect in **no written ledger cell at all**. **A vs G** isolates width.

## Results

**96 transaction attempts. 48/48 landed sequentially; 45/48 landed concurrently — and all three
losses were the same experiment.**

| Exp | What raced                          | Wallets | Sequential | Concurrent | Rounds all landed | One block |
| --- | ----------------------------------- | ------- | ---------- | ---------- | ----------------- | --------- |
| A   | disjoint Map keys, shared pad cell  | 2       | 6/6        | **6/6**    | 3/3               | 3/3       |
| B   | same Map key                        | 2       | 6/6        | **6/6**    | 3/3               | 3/3       |
| C   | shared scalar, read-modify-write    | 2       | 6/6        | **3/6**    | 0/3               | 0/3       |
| E   | shared Counter, native increment    | 2       | 6/6        | **6/6**    | 3/3               | 3/3       |
| F   | disjoint keys AND private pad slots | 2       | 6/6        | **6/6**    | 3/3               | 3/3       |
| G   | six wallets, six disjoint keys      | 6       | 18/18      | **18/18**  | 3/3               | 3/3       |

### A — disjoint keys: both land, same block, both writes present

| Rnd | alice               | bob                 | Block | Ledger keys 0-5 afterwards |
| --- | ------------------- | ------------------- | ----- | -------------------------- |
| 1   | `setCell(0,1011)` ✓ | `setCell(1,1012)` ✓ | 185   | `1011,1012,…`              |
| 2   | `setCell(0,2011)` ✓ | `setCell(1,2012)` ✓ | 189   | `2011,2012,…`              |
| 3   | `setCell(0,3011)` ✓ | `setCell(1,3012)` ✓ | 194   | `3011,3012,…`              |

Both values are present after every round. Neither wallet's write was lost, and the two
transactions shared a written cell (`padStore`) besides.

### B — the same key: both land anyway, last-write-wins

This is the result that reframes the question. Two wallets wrote **the same** `Map` key at the
same instant and **neither was rejected**; both transactions were included in the same block and
the ledger simply holds the later one's value.

| Rnd | alice               | bob                 | Block | `cells[0]` afterwards |
| --- | ------------------- | ------------------- | ----- | --------------------- |
| 1   | `setCell(0,1021)` ✓ | `setCell(0,1022)` ✓ | 198   | `1022` (bob)          |
| 2   | `setCell(0,2021)` ✓ | `setCell(0,2022)` ✓ | 202   | `2021` (alice)        |
| 3   | `setCell(0,3021)` ✓ | `setCell(0,3022)` ✓ | 206   | `3021` (alice)        |

Note that the winner is not the same wallet each time — it is whichever the block happened to
order last. **A silently lost write, not an error.**

### C — shared read-modify-write: exactly one survivor, every time

| Rnd | alice        | bob          | Block | `touches` | Node's reason for the loss                          |
| --- | ------------ | ------------ | ----- | --------- | --------------------------------------------------- |
| 1   | ✓            | **rejected** | 210   | 6 → 7     | `ReadMismatch { expected: <[06]>, actual: <[07]> }` |
| 2   | **rejected** | ✓            | 214   | 7 → 8     | `ReadMismatch { expected: <[07]>, actual: <[08]> }` |
| 3   | ✓            | **rejected** | 218   | 8 → 9     | `ReadMismatch { expected: <[08]>, actual: <[09]> }` |

The node's log, in full:

```
🚫 Rejecting transaction 6b0a2a96…81689 at pre-dispatch: guaranteed execution would fail:
   Transcript(Execution(ReadMismatch { expected: <[06]: b8>, actual: <[07]: b8> }))
```

`touches` advanced by exactly one per round, never two — the loser's effect is gone, not
merged. These three lines are the **only** three rejections on the entire probe chain across the
whole run; every other failure mode was absent.

The loser's client-side error is the useless `SubmissionError: Transaction submission error`.
The reason exists only in the node's log.

### E — shared `Counter`: both increments apply

| Rnd | alice | bob | Block | `bumps` |
| --- | ----- | --- | ----- | ------- |
| 1   | ✓     | ✓   | 222   | 6 → 8   |
| 2   | ✓     | ✓   | 226   | 8 → 10  |
| 3   | ✓     | ✓   | 230   | 10 → 12 |

**+2 per round, not +1.** A `Counter` incremented concurrently by two wallets keeps both
increments, in the same block, with no rejection — where the Compact-level `touches = touches +
1` in experiment C loses one. Both are a single shared scalar bumped by the same two wallets at
the same instant; the only difference is how Compact compiles "add one", and that difference
decides the outcome.

### F — nothing in common: both land

| Rnd | alice                | bob                  | Block |
| --- | -------------------- | -------------------- | ----- |
| 1   | `setCellA(2,1031)` ✓ | `setCellB(3,1032)` ✓ | 234   |
| 2   | `setCellA(2,2031)` ✓ | `setCellB(3,2032)` ✓ | 238   |
| 3   | `setCellA(2,3031)` ✓ | `setCellB(3,3032)` ✓ | 242   |

F confirms A rather than correcting it: since A already succeeded while sharing `padStore`, the
shared padding cell was never a conflict. Useful anyway — it establishes that a design giving
each seat a private padding slot costs nothing and buys nothing, so the one shared `padStore` in
`table.compact` can stay.

### G — six wallets, six keys, one block

The design question at its stated width. Six separate wallets in six separate processes, each
writing only its own seat's key, released from one barrier.

| Rnd | Wallets landed | Block   | Ledger keys 0-5 before → after |
| --- | -------------- | ------- | ------------------------------ |
| 1   | **6/6**        | all 388 | `3041…3046` → `1041…1046`      |
| 2   | **6/6**        | all 393 | `1041…1046` → `2041…2046`      |
| 3   | **6/6**        | all 398 | `2041…2046` → `3041…3046`      |

Eighteen transactions from six wallets, and every one of them landed — three times over, with
each round's six landing in a single block. All six keys changed in every round, so no wallet's
write was dropped.

(Values are stamped by round and wallet but not by mode, so G's sequential and concurrent passes
write the same six numbers. The evidence is therefore the before → after transition plus six
distinct transaction hashes at one block height, not the after-state alone.)

### Simultaneity

The barrier held across all 18 concurrent rounds, at both widths.

| Metric                                                 | Value                                |
| ------------------------------------------------------ | ------------------------------------ |
| Spread between earliest and latest `submitTransaction` | 0–2 ms (2-wallet and 6-wallet alike) |
| Rounds whose landed transactions all shared one block  | 15/15                                |
| Longest a process waited at the barrier for its peers  | 2,433 ms (a 6-wallet round)          |
| Rejections chain-wide not caused by `ReadMismatch`     | 0                                    |

The six-wallet rounds submitted just as tightly as the two-wallet ones — the extra proving time
is absorbed by the barrier, not by the submission window.

## Why: the binding is a per-read transcript assertion

The behaviour is fully explained by what the compiler emits, and the two agree exactly.

A Compact circuit's ledger interaction compiles to a **transcript** of Impact VM operations.
The node re-executes that transcript against live state at pre-dispatch. Reading
`src/managed/cells/contract/index.js`, the three shapes differ in exactly one operation:

| Circuit       | Impact ops                | Reads state back?          |
| ------------- | ------------------------- | -------------------------- |
| `setCell`     | `idx push push ins ins`   | no                         |
| `bumpShared`  | `idx popeq push push ins` | **yes** — note the `popeq` |
| `bumpCounter` | `idx addi ins`            | no — `addi` is native      |

`popeq` is the binding operation: it pops the value at a path and asserts it equals what the
proof committed to. If another transaction moved that value first, the assertion fails and the
node rejects with `Transcript(Execution(ReadMismatch { expected, actual }))` — which is
literally the `expected: <[06]>, actual: <[07]>` seen above.

Everything else follows:

- `cells.insert(key, value)` is a **blind write**. It emits `ins` with no `popeq`, binds to
  nothing, and therefore always applies — even against the same key (B), because there is
  nothing to mismatch.
- `touches = touches + 1` must read `touches` to add to it, so it emits `popeq` and binds.
- `Counter.increment(1)` emits `addi`, a native increment the VM applies to whatever value it
  finds. It never reads the value into the proof, so it commutes.

So the design axis is not "which cells does my circuit touch" but **"which cells does my circuit
read"**. Two circuits can hammer the same cell concurrently as long as neither reads it.

## What this means for six simultaneous seats

**Simultaneous multiplayer turns are viable, and this was measured at six, not inferred from
two.** Experiment G put six wallets writing six seat-keyed entries into one contract at one
instant, three times, and all eighteen transactions landed — each round's six in a single block.
`table.compact` already stores per-seat state in exactly the shape that permits it:
`seatIdentity`, `seatCard` and `seatProgress` are `Map<Uint<8>, …>` keyed by seat index (a
choice made for an unrelated reason — a `Vector` index must be a compile-time constant).

**What blocks it today is not the seat storage. It is the shared cells every turn reads.** An
audit of `table.compact` against the rule above:

| Ledger field                                                   | Shape on the turn path                                            | Concurrent-safe?      |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| `seatIdentity`, `seatCard`, `seatProgress`                     | `Map` **insert** keyed by seat                                    | **yes** — blind write |
| `padStore`                                                     | blind write after `kernel.checkpoint()`                           | **yes** (proved by A) |
| `seatProgress` via `forfeitFlags()`                            | `lookup` of **all six** seats, to compute the next cursor         | **no** — six reads    |
| `lastActionAt`                                                 | `stampTime()`: `assert(now >= lastActionAt); lastActionAt = now`  | **no** — reads        |
| `currentSeat`, `round`, `turnIndex`, `turnState`               | `advanceTurn()`: all four read to compute the next cursor         | **no** — reads        |
| `gameDigest`                                                   | `H(gameDigest, event)` — a running accumulator                    | **no** — reads        |
| `phase`, `pot`, `seatCount`, `activeSeats`                     | state-machine and accounting reads                                | **no** — reads        |
| `pendingEntropy`/`Policy`/`Param`, `rollStep`, `pendingRoll` … | the operator's three-transaction roll pipeline, shared singletons | **no** — reads        |

The `forfeitFlags()` row is the subtle one and worth stating plainly: **a `Map.lookup` binds
just as a scalar read does.** That circuit's only ledger interaction is
`seatProgress.lookup(0..5)`, and its compiled form in
`contract/src/managed/table/contract/index.js` contains `popeq`. So per-seat storage is
necessary but not sufficient — a circuit that writes only its own seat but _reads_ all six
still collides with all six. Per-seat state buys concurrency only if the **read** set is
per-seat too.

`stampTime()` alone is decisive: **seven of the eight exported circuits call it** — `join`,
`takeTurn`, `resolveRoll1/2/3`, `claimTimeout`, `abortTable`, every one except `settle` — and it
reads `lastActionAt`. As the contract stands today, two seats submitting in the same block
would always collide there, whatever else they touched.

### What a simultaneous-turn redesign has to do

1. **Make the timestamp per-seat.** `lastActionAt: Uint<64>` becomes
   `Map<Uint<8>, Uint<64>>`, and the turn-timeout check reads only the acting seat's entry. This
   is the single highest-value change; without it nothing else helps.
2. **Stop reading a shared turn cursor.** `currentSeat` / `round` / `turnIndex` / `turnState`
   are a serial cursor by construction. In a simultaneous design each seat keeps its own
   progress (`seatProgress` already exists) and "the round is over" is a predicate evaluated at
   settlement, which is a single serialized transaction where reads are free.
3. **Do not accumulate entropy in a shared digest.** `gameDigest = H(gameDigest, event)` is the
   canonical non-commuting operation. Store per-seat commitments in a `Map` and fold them once,
   at settle. Note this changes what the entropy scheme is binding to and needs its own
   soundness review — it is not a mechanical substitution.
4. **Where a shared count is genuinely needed, use `Counter`, not `Uint<N>`.** Experiment E is
   the licence for this and it is worth taking: a `Counter` field with `.increment()` is the one
   shared cell six seats can all touch in one block. `Counter.read()` re-introduces the read, so
   read it only in transactions that are already serialized.
5. **Leave the padding alone.** One shared `padStore` is fine (A and F agree); per-seat pad
   slots would cost circuits against the deploy ceiling for no benefit.

### The bottleneck moves to the operator, and that is the harder half

This probe answers the question that was asked, and the answer is favourable — but it is worth
being clear about what it does _not_ buy, because the win is smaller than "six times faster".

Dust Dice's turn is two-sided: the player submits `takeTurn`, and the **operator** then submits
`resolveRoll1/2/3` (three transactions, not one, because the one-transaction version needs k=17
and the proof server tops out at k=15 — `table.compact` decision 9). Only the player's half is
what six seats do concurrently. The operator's half is serialized twice over:

- `pendingEntropy`, `pendingPolicy`, `pendingParam`, `rollStep`, `pendingMixed`, `pendingHold`
  and `pendingRoll` are **shared singletons**, read by each resolve step. Six seats in flight
  would need all seven of them keyed by seat.
- Even with that fixed, the operator is one wallet, and one wallet's spends must be sequential
  (§0 #8/#22). Six seats × three resolves is **18 operator transactions per round** that cannot
  overlap.

At the ~20 s submit-to-inclusion measured here, that is the real cost driver, and making the
players concurrent does not touch it. A design that wants the full win needs the operator to
hold a pool of wallets, one per seat — at which point the shared pipeline cells have to be
per-seat anyway. Worth scoping before committing to the redesign, because it is a larger change
than the player-side one and the player-side change alone buys comparatively little.

### Two hazards this probe exposes that a design must handle

**A same-key collision is silent.** Experiment B is the warning: two writes to one key do not
error, they overwrite, and the winner depends on block ordering. Per-seat keys make this
unreachable by construction — but any place where two players could write one key (a shared
"last move" cell, a lobby slot claimed by index) would lose a move with no signal to anyone.
Prefer a key derived from the actor over a key that two actors could compute the same value for.

**The loser of a real conflict learns nothing useful.** The client sees
`SubmissionError: Transaction submission error`; only the node's log says `ReadMismatch`. A UI
cannot currently distinguish "your move collided, retry" from "your transaction was malformed"
or from the transient `InvalidDustSpendProof` (#6). Any simultaneous-turn client therefore needs
a **re-read-and-retry** loop driven by observed state — resubmit after confirming from the
ledger that the move did not land — rather than by error classification. Note this is exactly
the `landed` predicate discipline that `probes/gate0`'s `retryCall` already established for a
different reason.

### Limits of this evidence

- Two wallets for A–F; six for G. Six is the design's stated width, so the headline claim is
  measured rather than extrapolated — but 6 is not 60, and nothing here measures what happens
  when contention exceeds a block's capacity.
- All calls are to **one** contract from **one** node with no other traffic. Mempool ordering
  under real load, and block-size or gas ceilings with many calls per block, are untested.
- The rule "a `popeq` in the transcript is what binds" is read off the compiled artifact and is
  consistent with every one of the 96 attempts, but it is an inference from behaviour plus
  generated code, not from the ledger's source. It predicts the results exactly, including the
  two that were surprising (B and E), which is the strongest form of support available here.
- `Set.insert`, `MerkleTree.insert` and the unshielded-token operations were not tested. Token
  operations in particular go through the kernel's balance accounting and should be assumed
  serializing until measured.

## Re-running

```sh
docker compose -f probes/concurrency/docker-compose.yml up -d
npm run compile -w @dust-dice/probe-concurrency
npm run k       -w @dust-dice/probe-concurrency   # every circuit must be k=9..15
npm run probe   -w @dust-dice/probe-concurrency   # ~2 h, almost all of it wallet startup
node probes/concurrency/tools/summarize.mjs     # regenerates the tables above from .run/
```
