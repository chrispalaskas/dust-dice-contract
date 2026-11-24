// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The command line's `ChainReader` (record.ts): the indexer the network config names, read
 * through Node. The /verify page has its own reader and runs the same record and checks.
 */

import { userAddressBytes } from '@dust-dice/api/node';
import { nativeBalanceOf } from '@dust-dice/contract';

import { Backgammon, Table, hex } from './game.ts';
import { callOutcomes, readContractState } from './contracts.ts';
import { contractActions, NATIVE_TOKEN_HEX, transactionByHash } from './indexer.ts';
import {
  backgammonRecord,
  yachtRecord,
  type ChainReader,
  type Output,
  type YachtRecord,
} from './record.ts';

/** Decode an indexer owner (bech32m) to the address bytes the ledger records. */
function ownerHex(owner: string): string {
  try {
    return hex(userAddressBytes(owner));
  } catch {
    return `?${owner}`;
  }
}

const isNative = (u: { tokenType: string }): boolean =>
  u.tokenType.replace(/^0x/, '').toLowerCase() === NATIVE_TOKEN_HEX;

export const nodeReader: ChainReader = {
  actions: (address) => contractActions(address),
  outcomes: (address, txHash) => callOutcomes(address, txHash),
  async yacht(address, at) {
    const state = await readContractState(address, at);
    return { led: Table.ledger(state.data), balance: nativeBalanceOf(state) };
  },
  async backgammon(address, at) {
    const state = await readContractState(address, at);
    return { led: Backgammon.ledger(state.data), balance: nativeBalanceOf(state) };
  },
  async tx(hash) {
    const tx = await transactionByHash(hash);
    const outs = (us: typeof tx.unshieldedCreatedOutputs): Output[] =>
      us.filter(isNative).map((u) => ({ owner: ownerHex(u.owner), value: BigInt(u.value) }));
    return {
      hash: tx.hash,
      blockHeight: tx.block.height,
      created: outs(tx.unshieldedCreatedOutputs),
      spent: outs(tx.unshieldedSpentOutputs),
    };
  },
};

/** A Yacht table's record off the configured indexer. */
export const indexerRecord = (address: string): YachtRecord => yachtRecord(address, nodeReader);

/** A Backgammon table's record off the configured indexer. */
export const indexerBackgammonRecord = (address: string) => backgammonRecord(address, nodeReader);
