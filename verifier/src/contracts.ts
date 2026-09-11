// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The `compiledContract` values `deployContract`/`findDeployedContract` take, and one-shot
 * reads of a table's public ledger.
 *
 * On midnight-js 5.x a `compiledContract` is NOT a bare `new Contract(witnesses)`:
 * `deployContract` calls compact-js's `createContract`, which reads a hidden `CompactContext`
 * off the value and needs `.ctor` and `.witnesses` on it. Passing a Contract instance fails
 * deep inside proving with `TypeError: Cannot read properties of undefined (reading 'ctor')`,
 * which names neither the argument nor the missing wrapper. The wrapper is
 * `CompiledContract.make(tag, Ctor).pipe(...)`; both contracts here declare witnesses, so the
 * combinator is `withWitnesses` (`withVacantWitnesses` is for contracts that declare none).
 */

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  Table,
  Lobby,
  tableWitnesses,
  lobbyWitnesses,
  unshieldedBalances,
  type UnshieldedBalances,
  type TablePrivateState,
  type LobbyPrivateState,
} from '@dust-dice/contract';

import { NETWORK } from './config.ts';
import { contractStateHexAt } from './indexer.ts';

export { Table, Lobby };

/**
 * The exported circuit names, spelled out.
 *
 * `createProviders` is generic in this and it MUST be instantiated with the concrete union, not
 * left to infer `string`: midnight-js ties a provider's circuit-id type to the contract's own
 * `ProvableCircuitId`, so a `string` here fails every `deployContract`/`findDeployedContract`
 * overload with "Type 'string' is not assignable to type 'ProvableCircuitId<...>'" -- an error
 * that points at the providers argument and says nothing about the type parameter that caused
 * it.
 */
export type TableCircuitId =
  | 'join'
  | 'playerMove'
  | 'resolveRoll1'
  | 'resolveReroll'
  | 'closeRound'
  | 'eliminate'
  | 'settle'
  | 'redeem'
  | 'abortTable';

export type LobbyCircuitId = 'openTableAt' | 'tableFilled';

export const CompiledTableContract = CompiledContract.make<Table.Contract<TablePrivateState>>(
  'Table',
  Table.Contract<TablePrivateState>,
).pipe(
  CompiledContract.withWitnesses(tableWitnesses),
  CompiledContract.withCompiledFileAssets('./table'),
);

export const CompiledLobbyContract = CompiledContract.make<Lobby.Contract<LobbyPrivateState>>(
  'Lobby',
  Lobby.Contract<LobbyPrivateState>,
).pipe(
  CompiledContract.withWitnesses(lobbyWitnesses),
  CompiledContract.withCompiledFileAssets('./lobby'),
);

export type TableLedger = Table.Ledger;
export type LobbyLedger = Lobby.Ledger;

/** Which state to read: the latest, or the one a specific transaction left behind. */
export type LedgerAt = { txHash: string };

/**
 * Read a table's ledger with a ONE-SHOT query.
 *
 * Deliberately not `contractStateObservable`: that observable misses rapid successive updates
 * and its first emission may predate the write being checked, so every read-after-write in this
 * driver -- and there is one after almost every transaction -- has to use `queryContractState`.
 * (bugs-found.md §0 #10; the same reason probes/gate0/src/step.ts reads this way.)
 *
 * `at.txHash` pins the read to the state a transaction left, which is what the chain-only
 * verifier walks the game with. By TRANSACTION, not by block: on this indexer (4.3.x) a block
 * offset means "the action in that block", and with simultaneous rounds several of a table's
 * transactions routinely share one -- a block-keyed read cannot say which it returned. The SDK
 * offers no transaction-hash offset, so that read goes straight to the indexer.
 */
export async function readContractState(address: string, at?: LedgerAt): Promise<ContractState> {
  if (at === undefined) {
    const pdp = indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS);
    const state = await pdp.queryContractState(address);
    if (!state) throw new Error(`no contract state at ${address}`);
    return state;
  }
  const hex = await contractStateHexAt(address, at.txHash);
  if (!hex) throw new Error(`no contract state at ${address} after tx ${at.txHash}`);
  return ContractState.deserialize(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

export async function readTableLedger(address: string, at?: LedgerAt): Promise<TableLedger> {
  return Table.ledger((await readContractState(address, at)).data);
}

export async function readLobbyLedger(address: string): Promise<LobbyLedger> {
  return Lobby.ledger((await readContractState(address)).data);
}

/**
 * What the LEDGER says the contract holds, for checking against the `pot` it claims.
 *
 * Read out of the contract's own state, NOT out of the indexer's
 * `contractAction { unshieldedBalances }` -- that field answers `[]` on this indexer even for a
 * table sitting on a pot, which reads as a solvency alarm instead of a balance. See
 * `@dust-dice/contract`'s `custody.ts` and the test that pins it.
 */
export async function contractUnshieldedBalances(
  address: string,
  at?: LedgerAt,
): Promise<UnshieldedBalances> {
  return unshieldedBalances(await readContractState(address, at));
}

/** `Dice` as the plain five-element array everything else in this repo speaks. */
export function diceToArray(d: Table.Dice): number[] {
  return [d.d0, d.d1, d.d2, d.d3, d.d4].map(Number);
}

// ---------------------------------------------------------------------------------------
// The shape of a game, restated for the driver and the verifier
// ---------------------------------------------------------------------------------------
//
// These mirror `table.compact` and are restated here rather than imported because the generated
// bindings spell them as plain `Uint<8>` values (they are not Compact `enum`s) and because both
// the driver and the chain-only verifier need them. See docs/table-interface.md.

/** Rounds per seat: 0..12, thirteen of them, one category each. `roundCount()`. */
export const ROUND_COUNT = 13;

/** The last round a seat plays. Completing it completes the scorecard. */
export const FINAL_ROUND = 12;

/** `playerMove` kinds. */
export const MOVE_OPEN = 0;
export const MOVE_HOLD = 1;
export const MOVE_SCORE = 2;

/**
 * `seatTurn.stage`.
 *
 * EVEN STAGES ARE OWED BY THE PLAYER, ODD ONES BY THE OPERATOR. That split is what the driver
 * dispatches on and what `eliminate` and `abortTable` divide on in the contract.
 */
export const STAGE = {
  idle: 0,
  awaitRoll1: 1,
  rolled1: 2,
  awaitRoll2: 3,
  rolled2: 4,
  awaitRoll3: 5,
  rolled3: 6,
} as const;

/** Is this seat's next move the player's? */
export const playerOwes = (stage: number): boolean => stage % 2 === 0;

/** The canonical "no mask" sentinel every `playerMove` kind but `hold` must carry. */
export const NO_MASK: boolean[] = [false, false, false, false, false];

/** The canonical "no entropy" sentinel every kind but `open` must carry. */
export const ZERO_BYTES32 = (): Uint8Array => new Uint8Array(32);

/** One seat's position, as the driver reads it off the ledger. */
export interface SeatView {
  seat: number;
  /** The next round this seat owes; `ROUND_COUNT` means finished or eliminated. */
  round: number;
  stage: number;
  eliminated: boolean;
  /** The dice as of the most recent resolved roll of the current turn. */
  roll: number[];
}

export function seatView(led: TableLedger, seat: number): SeatView {
  const prog = led.seatProgress.lookup(BigInt(seat));
  const turn = led.seatTurn.lookup(BigInt(seat));
  return {
    seat,
    round: Number(prog.round),
    stage: Number(turn.stage),
    eliminated: prog.eliminated,
    roll: diceToArray(turn.roll),
  };
}

/** Every seated slot's view, in seat order. */
export function seatViews(led: TableLedger): SeatView[] {
  return Array.from({ length: Number(led.seatCount) }, (_, s) => seatView(led, s));
}

/**
 * The penalty split `eliminate` requires: `q * 13 + rem == tier * (round + 1)`, `rem < 13`.
 *
 * Compact has no division, so the caller supplies the quotient and remainder and the circuit
 * checks the Euclidean identity -- which has exactly one solution, so supplying them grants no
 * discretion. `round + 1` reconciles the contract's 0-based rounds with the design note's
 * 1..13 numbering: a seat that never played at all forfeits a thirteenth, not nothing.
 */
export function penaltySplit(tier: bigint, round: number): { q: bigint; rem: bigint } {
  const numer = tier * BigInt(round + 1);
  return { q: numer / 13n, rem: numer % 13n };
}

/** The per-seat 1% rake on `tier` that `abortTable` requires, on every path. */
export function perSeatRake(tier: bigint): { q: bigint; rem: bigint } {
  return { q: tier / 100n, rem: tier % 100n };
}
