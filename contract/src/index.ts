// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Public surface of @yahtzee/contract.
 *
 * Two contracts live here, and neither is meant to be deployed: `dice` and `turn` exist to
 * measure the dominant circuit cost in the project -- the rejection ladder that turns a
 * hash into five fair dice -- before anything is built on top of it. The numbers are in
 * docs/dice-circuit.md. `Table` and `Lobby` will import `dice-core.compact`, not these.
 *
 * The generated bindings stay namespaced (`Dice`, `Turn`) because every compactc output
 * exports the same names -- `Contract`/`Ledger`/`ledger`/`Witnesses`/`pureCircuits` -- and
 * `export *` from more than one collides on all of them.
 *
 * `dice-mirror` is flat-exported: it is the settlement verifier, the thing other packages
 * actually consume, and its names are already specific.
 */

export * from './dice-mirror.ts';
export * from './witnesses.ts';

export * as Dice from './managed/dice/contract/index.js';
export * as Turn from './managed/turn/contract/index.js';
