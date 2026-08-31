// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Public surface of @yahtzee/contract.
 *
 * Four contracts live here, and none is meant to be deployed. `dice` and `turn` measure the
 * dominant circuit cost in the project -- the rejection ladder that turns a hash into five
 * fair dice (docs/dice-circuit.md). `scoring` and `takeTurn` measure the other half: the
 * official Yahtzee rules against a scorecard, standalone and then combined with the dice in
 * one circuit (docs/scoring-circuit.md). `Table` and `Lobby` will import
 * `dice-core.compact` and `scoring-core.compact`, not these.
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
export * as Scoring from './managed/scoring/contract/index.js';
export * as TakeTurn from './managed/takeTurn/contract/index.js';
