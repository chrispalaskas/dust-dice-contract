// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Witness implementations for table.compact and lobby.compact.
 *
 * Separate from src/witnesses.ts, which serves the four measurement contracts and declares only
 * `rollSeed`. These are the production ones.
 *
 * -----------------------------------------------------------------------------------------
 * Who holds what
 * -----------------------------------------------------------------------------------------
 * The table has three witnesses and they belong to TWO DIFFERENT PARTIES. In production they
 * never live in the same private state:
 *
 *   playerEntropySecret   the seated player's `sk_s`. One per seat, generated at join, held in
 *                         that player's browser. Proving knowledge of it is the whole of a
 *                         player's authorisation -- there is no address check anywhere,
 *                         because a circuit cannot learn its caller.
 *   rollSeed              the operator's commit-reveal seed. Held by the operator daemon and
 *                         persisted to disk at commit time, keyed by table address, BEFORE the
 *                         table opens: it is the only thing whose loss aborts a table.
 *   modalFaceHint         derived, not stored. Computed from `rollSeed` on demand.
 *
 * `TablePrivateState` carries all three fields because the simulator drives every party from
 * one process. A real client populates only the fields it owns and leaves the others zeroed;
 * a circuit that needs a secret the caller does not have simply fails its assert, which is the
 * intended behaviour and is what src/test/table.test.ts exercises.
 *
 * The private state is deliberately plain data with no methods and no function-valued fields:
 * the level-backed private-state provider silently drops those (bugs-found.md §0, #12/#18).
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { deriveDiceTs, rollContext } from './dice-mirror.ts';
import { modalFace } from './policy-mirror.ts';

/** Everything a prover might hold locally for one table. */
export type TablePrivateState = {
  /** The operator's roll seed for this table. 32 bytes. Operator only. */
  readonly rollSeed: Uint8Array;
  /** The acting player's entropy secret `sk_s`. 32 bytes. Player only. */
  readonly playerSecret: Uint8Array;
};

const THIRTY_TWO_ZEROS = (): Uint8Array => new Uint8Array(32);

function requireBytes32(name: string, value: Uint8Array): Uint8Array {
  if (value.length !== 32) throw new Error(`${name} must be 32 bytes, got ${value.length}`);
  return value;
}

export function createTablePrivateState(
  parts: { rollSeed?: Uint8Array; playerSecret?: Uint8Array } = {},
): TablePrivateState {
  return {
    rollSeed: requireBytes32('rollSeed', parts.rollSeed ?? THIRTY_TWO_ZEROS()),
    playerSecret: requireBytes32('playerSecret', parts.playerSecret ?? THIRTY_TWO_ZEROS()),
  };
}

/**
 * Witnesses for table.compact.
 *
 * Generic in the ledger type so one implementation serves the contract however its `Ledger` is
 * spelled. Each returns `[privateState, value]`; nothing here rotates the state, because both
 * secrets are fixed for the life of a table -- the seed by its commitment, the player's `sk` by
 * the `C_s` recorded at join.
 */
export const tableWitnesses = {
  playerEntropySecret: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, Uint8Array] => [
    privateState,
    privateState.playerSecret,
  ],

  rollSeed: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, Uint8Array] => [
    privateState,
    privateState.rollSeed,
  ],

  /**
   * The modal face of this turn's roll 1 -- the witness-the-answer half of `KeepModal`.
   *
   * Re-derives roll 1 from the seed with the TypeScript dice mirror. It takes the roll's PUBLIC
   * determinants as arguments (`tableId`, the digest-mixed entropy, the round) rather than the
   * dice themselves, so the circuit derives roll 1 exactly once instead of deriving it a second
   * time purely to feed this witness.
   *
   * Returning a wrong face here does not corrupt a game: `resolveDiceChecked` proves the value
   * is THE modal face of roll 1 under api/src/policies.ts's tie-break, so a wrong answer
   * produces no transaction. This function is a convenience, not a trusted input, which is why
   * it can afford to be unconditional -- it computes a modal face even for the five policies
   * that ignore it, and the circuit's check is likewise guarded on the policy.
   */
  modalFaceHint: <L>(
    { privateState }: WitnessContext<L, TablePrivateState>,
    tableId: Uint8Array,
    mixed: Uint8Array,
    round: bigint,
  ): [TablePrivateState, bigint] => [
    privateState,
    BigInt(modalFace(deriveDiceTs(rollContext(tableId, privateState.rollSeed, mixed, round, 0)))),
  ],
};

// ---------------------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------------------

/** The lobby's only secret: the operator key whose commitment is sealed at deployment. */
export type LobbyPrivateState = {
  readonly operatorSecret: Uint8Array;
};

export function createLobbyPrivateState(operatorSecret: Uint8Array): LobbyPrivateState {
  return { operatorSecret: requireBytes32('operatorSecret', operatorSecret) };
}

export const lobbyWitnesses = {
  operatorSecret: <L>({
    privateState,
  }: WitnessContext<L, LobbyPrivateState>): [LobbyPrivateState, Uint8Array] => [
    privateState,
    privateState.operatorSecret,
  ],
};
