// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Witness implementations for dice.compact and turn.compact.
 *
 * Both contracts declare one witness, `rollSeed`, and it is the same secret in both: the
 * operator's commit-reveal roll seed. The operator commits `persistentHash(seed)` when the
 * table opens -- before any player entropy exists -- and reveals the seed at settlement, at
 * which point anyone re-derives every roll with src/dice-mirror.ts. Nothing in the circuit
 * can check that the seed matches the commitment unless the contract holds the commitment
 * and asserts it; the measurement contracts here do not, so THEY DO NOT BIND THE OPERATOR.
 * `Table` must, and that assert is the whole integrity story for randomness.
 *
 * The private state is deliberately plain data with no methods or function-valued fields:
 * the level-backed private-state provider silently drops those (bugs-found.md §0, #12/#18).
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

/** Everything the prover holds locally for a roll. */
export type DicePrivateState = {
  /** The operator's roll seed for this table. 32 bytes. */
  readonly rollSeed: Uint8Array;
};

export function createDicePrivateState(rollSeed: Uint8Array): DicePrivateState {
  if (rollSeed.length !== 32) {
    throw new Error(`rollSeed must be 32 bytes, got ${rollSeed.length}`);
  }
  return { rollSeed };
}

/**
 * Witnesses for both measurement contracts.
 *
 * Generic in the ledger type because dice.compact and turn.compact generate different
 * `Ledger` types and this same implementation serves both. A witness returns
 * `[privateState, value]`: the seed is read, never rotated, so the state passes through
 * unchanged.
 */
export const diceWitnesses = {
  rollSeed: <L>({
    privateState,
  }: WitnessContext<L, DicePrivateState>): [DicePrivateState, Uint8Array] => [
    privateState,
    privateState.rollSeed,
  ],
};
