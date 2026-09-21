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
 * one process. A real client populates only the fields it owns and leaves the others at their
 * defaults;
 * a circuit that needs a secret the caller does not have simply fails its assert, which is the
 * intended behaviour and is what src/test/table.test.ts exercises.
 *
 * The private state is deliberately plain data with no methods and no function-valued fields:
 * the level-backed private-state provider silently drops those (bugs-found.md §0, #12/#18).
 */

import type { JubjubPoint, WitnessContext } from '@midnight-ntwrk/compact-runtime';

/** Everything a prover might hold locally for one table. */
export type TablePrivateState = {
  /** The acting player's entropy secret `sk_s`. 32 bytes. Player only. */
  readonly playerSecret: Uint8Array;
  /** A private table's invite code. 32 bytes. Joiner only; zeros on a public table. */
  readonly inviteCode: Uint8Array;
  /**
   * The blinding factor for the roll the player is about to reveal. Player only.
   *
   * UNLIKE THE OTHER TWO, THIS ROTATES. A fresh one per roll — reusing a blinding across two
   * rolls would let the operator link the two queries. The client sets it before each reveal.
   */
  readonly vrfBlinding: bigint;
  /** The unblinded VRF output for the roll being revealed, `Gamma = rho^-1 * S`. Player only. */
  readonly vrfGamma: JubjubPoint;
};

/** The point a private state carries when no roll is being revealed. */
export const NO_GAMMA: JubjubPoint = { x: 0n, y: 1n };

const THIRTY_TWO_ZEROS = (): Uint8Array => new Uint8Array(32);

function requireBytes32(name: string, value: Uint8Array): Uint8Array {
  if (value.length !== 32) throw new Error(`${name} must be 32 bytes, got ${value.length}`);
  return value;
}

export function createTablePrivateState(
  parts: {
    playerSecret?: Uint8Array;
    inviteCode?: Uint8Array;
    vrfBlinding?: bigint;
    vrfGamma?: JubjubPoint;
  } = {},
): TablePrivateState {
  return {
    playerSecret: requireBytes32('playerSecret', parts.playerSecret ?? THIRTY_TWO_ZEROS()),
    inviteCode: requireBytes32('inviteCode', parts.inviteCode ?? THIRTY_TWO_ZEROS()),
    vrfBlinding: parts.vrfBlinding ?? 1n,
    vrfGamma: parts.vrfGamma ?? NO_GAMMA,
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
  inviteCode: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, Uint8Array] => [
    privateState,
    privateState.inviteCode,
  ],

  playerEntropySecret: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, Uint8Array] => [
    privateState,
    privateState.playerSecret,
  ],

  /**
   * The blinding factor for the roll this move reveals.
   *
   * The operator has NO witness here any more. It used to hold `rollSeed`, and knowledge of
   * that preimage was its authority; its authority is now the DLEQ it publishes with each
   * answer, which is checked on chain against the sealed public key.
   */
  vrfBlinding: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, bigint] => [
    privateState,
    privateState.vrfBlinding,
  ],

  /**
   * The unblinded VRF output for the roll this move reveals.
   *
   * A wrong value here does not corrupt a game, it produces no transaction: the circuit proves
   * `S == rho*Gamma` against the response the operator already put on chain.
   */
  vrfGamma: <L>({
    privateState,
  }: WitnessContext<L, TablePrivateState>): [TablePrivateState, JubjubPoint] => [
    privateState,
    privateState.vrfGamma,
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
