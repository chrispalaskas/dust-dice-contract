// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Public surface of @dust-dice/contract.
 *
 * TWO CONTRACTS ARE MEANT TO BE DEPLOYED and four are not.
 *
 * `Table` is the game: one deployment per table, holding the pot and running the two-step turn
 * (docs/table-contract.md, docs/table-circuit.md). `Lobby` is a per-site registry pointing at
 * whichever table is currently open per tier -- a convenience index with no funds and no
 * authority; the tables are the security boundary.
 *
 * `dice`, `turn`, `scoring` and `takeTurn` are measurement scaffolds and are NOT deployable --
 * no seats, no turn order, no pot, and nothing binding the operator's seed. They exist because
 * they priced the two halves of a turn separately (docs/dice-circuit.md,
 * docs/scoring-circuit.md) and because their cross-checks against api/src/rules.ts are what the
 * scoring core is trusted on. `Table` includes the same cores they do.
 *
 * The generated bindings stay namespaced (`Dice`, `Turn`, `Table`, ...) because every compactc
 * output exports the same names -- `Contract`/`Ledger`/`ledger`/`Witnesses`/`pureCircuits` --
 * and `export *` from more than one collides on all of them.
 *
 * `custody.ts` is flat-exported for the same reason: reading what a contract HOLDS out of its
 * ledger state is one decode, needed by the driver, the verifier and the UI alike.
 *
 * The mirrors are flat-exported: together they ARE the settlement verifier -- the thing other
 * packages actually consume -- and their names are already specific. `dice-mirror` derives the
 * dice, `policy-mirror` applies the hold policies and the entropy scheme, `table-mirror` walks
 * the event digest chain. Given a table's public log and the seed revealed at settle, the three
 * reproduce every roll of a game offline, with no proof server and no chain access.
 */

export * from './custody.ts';
export * from './dice-mirror.ts';
export * from './policy-mirror.ts';
export * from './table-mirror.ts';
export * from './witnesses.ts';
export * from './table-witnesses.ts';

export * as Dice from './managed/dice/contract/index.js';
export * as Turn from './managed/turn/contract/index.js';
export * as Scoring from './managed/scoring/contract/index.js';
export * as TakeTurn from './managed/takeTurn/contract/index.js';
export * as Table from './managed/table/contract/index.js';
export * as Lobby from './managed/lobby/contract/index.js';
