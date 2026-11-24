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

import { withIndexerRetry } from '@dust-dice/api';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { ContractCall, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  tableWitnesses,
  lobbyWitnesses,
  unshieldedBalances,
  type UnshieldedBalances,
  type TablePrivateState,
  type LobbyPrivateState,
} from '@dust-dice/contract';

import { NETWORK } from './config.ts';
import {
  Table,
  Lobby,
  Backgammon,
  type TableLedger,
  type BackgammonLedger,
  type LobbyLedger,
} from './game.ts';
import { contractStateHexAt, sameAddress, transactionOutcome } from './indexer.ts';

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
  | 'resolveRoll'
  | 'closeRound'
  | 'eliminate'
  | 'settle'
  | 'redeem'
  | 'abortTable'
  | 'seatClock';

export type LobbyCircuitId = 'openTableAt' | 'tableFilled';

/** The Backgammon table's eight exported circuits. */
export type BackgammonCircuitId =
  'join' | 'start' | 'reveal' | 'openingMove' | 'move' | 'eliminate' | 'settle' | 'abortTable';

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

/**
 * Backgammon declares the same three witnesses as the Yacht table, so `tableWitnesses` and
 * `TablePrivateState` serve both.
 */
export const CompiledBackgammonContract = CompiledContract.make<
  Backgammon.Contract<TablePrivateState>
>('Backgammon', Backgammon.Contract<TablePrivateState>).pipe(
  CompiledContract.withWitnesses(tableWitnesses),
  CompiledContract.withCompiledFileAssets('./backgammon'),
);

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
    const pdp = indexerPublicDataProvider({
      queryURL: NETWORK.indexer,
      subscriptionURL: NETWORK.indexerWS,
    });
    // The SDK's provider does not retry: a burst-throttled `403` from the public indexer
    // surfaces as `ServerError: Response not successful` and, untreated, kills the daemon tick
    // that asked. `contractStateHexAt` below goes through `gql`, which retries already.
    const read = await withIndexerRetry(() => pdp.queryContractState(address));
    if (!read) throw new Error(`no contract state at ${address}`);
    // midnight-js 5.0.0 hands back the state SERIALIZED, tagged with the era that wrote it.
    return read.contractState.deserialize({ v9: ContractState });
  }
  const hex = await contractStateHexAt(address, at.txHash);
  if (!hex) throw new Error(`no contract state at ${address} after tx ${at.txHash}`);
  return ContractState.deserialize(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

/** One call a transaction made on a contract, and whether the chain applied its segment. */
export interface CallOutcome {
  entryPoint: string;
  segment: number;
  applied: boolean;
}

/**
 * The calls a transaction made on `address`, in segment order, each with whether it took effect.
 *
 * Every intent of a transaction runs its fallible part as a segment of its own, and a PARTIAL
 * success keeps the segments that passed. The indexer lists every call of such a transaction
 * with no segment and no outcome of its own, and reports the result per segment on the
 * transaction; only the transaction's bytes say which call sat in which segment. Seen on the
 * fork devnet (2026-11-02): one-transaction Backgammon plies that landed after a finality stall
 * with the move (segment 1) applied and the operator's roll (segment 2) failed its time check.
 */
export async function callOutcomes(address: string, txHash: string): Promise<CallOutcome[]> {
  const { raw, status, segments } = await transactionOutcome(txHash);
  const failed = new Set(segments.filter((s) => !s.success).map((s) => s.id));
  const tx = Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    Buffer.from(raw.replace(/^0x/, ''), 'hex'),
  );
  const out: CallOutcome[] = [];
  for (const [segment, intent] of [...(tx.intents ?? [])].sort(([a], [b]) => a - b)) {
    for (const call of intent.actions) {
      if (!(call instanceof ContractCall) || !sameAddress(call.address, address)) continue;
      const ep = call.entryPoint;
      out.push({
        entryPoint: typeof ep === 'string' ? ep : new TextDecoder().decode(ep),
        segment,
        applied: status === 'SUCCESS' || (status === 'PARTIAL_SUCCESS' && !failed.has(segment)),
      });
    }
  }
  return out;
}

export async function readTableLedger(address: string, at?: LedgerAt): Promise<TableLedger> {
  return Table.ledger((await readContractState(address, at)).data);
}

export async function readBackgammonLedger(
  address: string,
  at?: LedgerAt,
): Promise<BackgammonLedger> {
  return Backgammon.ledger((await readContractState(address, at)).data);
}

/**
 * Which game a deployed contract is, from its own entry points: `move` and `openingMove` are
 * Backgammon's alone, `playerMove` Yacht's. Undefined for anything else (a Lobby, or not a Dust
 * Dice contract).
 */
export async function gameOf(address: string): Promise<'yacht' | 'backgammon' | undefined> {
  const ops = (await readContractState(address))
    .operations()
    .map((o) => (typeof o === 'string' ? o : new TextDecoder().decode(o)));
  if (ops.includes('move') && ops.includes('openingMove')) return 'backgammon';
  if (ops.includes('playerMove')) return 'yacht';
  return undefined;
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

// The pure half -- ledger types, shapes and constants -- lives in game.ts, which a browser can
// load; re-exported so every existing import of this module keeps working.
export * from './game.ts';
