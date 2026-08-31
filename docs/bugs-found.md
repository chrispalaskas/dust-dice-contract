# Bugs found building on Midnight

Running log of defects discovered in upstream components while building Midnight Yahtzee,
kept from commit one so each becomes an upstream issue/PR instead of tribal knowledge.

Format per entry: **symptom**, **root cause**, **workaround/fix**, **intended upstream action**.
Status legend: **patched-locally** (fix applied on a local checkout, needs upstreaming),
**worked-around** (avoided, root cause remains), **fixed-here** (fixed in this repo),
**open** (unresolved/watching), **inherited** (known from the neighbouring project
`dapp-hackathon-team-1`, re-confirmed or pre-empted here).

## 0. Inherited prior art

This project builds on the same toolchain as `dapp-hackathon-team-1` (compactc 0.33/0.34,
ledger-9.1.0.0-rc.3, node 2.0.0-rc.4). Its `docs/bugs-found.md` documents 24 defects we
treat as prior incidents, the most load-bearing being:

- **#8/#22 — `1010: Custom error: 170` has multiple causes**: node↔SDK ledger-tag pairing
  mismatch (deterministic from first deploy); fee-state drift after sustained chain load
  (permanent, only a fresh chain clears it); concurrent DUST spends from one wallet
  (in-flight spends race). Only the node log distinguishes them.
- **#21 — client-side gas under-declaration on multi-call transactions**: `gas_heuristic`
  declares a flat 1.2× per call with no term for calls-per-transaction; ~15% failure at
  2 calls, 60% at 3. Workaround: one call per transaction; where impossible (c2c), inflate
  the _fallible_ transcript budget only (`MIDNIGHT_GAS_FACTOR` patch on
  `@midnight-ntwrk/compact-js`). Inflating the guaranteed half is rejected at admission
  (`OutsideTimeToDismiss`).
- **#11 — `contractStateObservable` misses rapid successive updates**: one-shot
  `queryContractState` for read-after-write; observable only for live UI.
- **#12/#18 — level private-state provider self-deadlocks and silently drops
  function-valued fields**: memoize one `Level` per dbName; keep private state plain data.
- **#13 — `kernel.self()` returns zeros in constructors**: instance ids must be constructor
  arguments.
- **#15 — `MerkleTree.insertHash` expects the tree's own leaf digest**: use `.insert(value)`.
- **#24 — `FetchZkConfigProvider` defaults `verify: 'require'`** and only a real wallet proof
  exercises the path: pass `verify: 'off'` for local-devnet artifacts, with a comment.
- **#6 — `wallet-sdk-facade` needs `overrides: { "@midnight-ntwrk/wallet-sdk-utilities": "1.2.1" }`**,
  and an incremental `npm install` does not re-resolve a new override — clean reinstall only.
- **#7 — wallet facade `isSynced` hangs forever** (shielded sync never connects): wait on
  dust + unshielded sync only.

Entries below are new findings in this repo.

---

_(none yet)_
