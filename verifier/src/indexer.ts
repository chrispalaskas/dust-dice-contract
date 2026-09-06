// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct indexer GraphQL access, for evidence the wallet cannot be asked to provide.
 *
 * The wallet facade's own `state().unshielded.balances` is the natural place to read a balance,
 * but it is the same component that built the transactions -- so on its own it is a weak witness
 * that custody really happened, and during Gate 0 it misreported a pre-stake balance by
 * 4,900,000 in exactly this situation (docs/bugs-found.md §9). PER-TRANSACTION UTXO MOVEMENT IS
 * THE ONLY TRUSTWORTHY MEASURE, and it is what these queries read:
 *
 *   - `contractAction(address){ unshieldedBalances }`  what the LEDGER says the contract holds
 *   - `transactions(offset:{hash}){ unshieldedCreatedOutputs / unshieldedSpentOutputs }`
 *                                                     who actually received or spent what, with
 *                                                     `registeredForDustGeneration` per created
 *                                                     UTXO (the designation question)
 *   - `transactions(offset:{hash}){ raw }`            the transaction's byte size, which is what
 *                                                     the `OutsideTimeToDismiss` admission check
 *                                                     measures
 *   - `contract(address){ actions }`                  the table's whole public history, which is
 *                                                     all the chain-only verifier is given
 *
 * There is no user-address balance query in this indexer's schema (checked by introspecting
 * `__schema.queryType.fields`: only `bridgeBalance(address)` takes an address, and that is the
 * Cardano bridge, not NIGHT), so per-address totals are derived from the UTXO sets above.
 */

import { NETWORK } from './config.ts';

export interface GqlUnshieldedUtxo {
  owner: string;
  tokenType: string;
  value: string;
  intentHash: string;
  outputIndex: number;
  registeredForDustGeneration: boolean;
}

export interface GqlTransaction {
  hash: string;
  /** Hex of the whole transaction as the node saw it. `length / 2` is the size it checked. */
  raw: string;
  block: { height: number; timestamp: string };
  unshieldedCreatedOutputs: GqlUnshieldedUtxo[];
  unshieldedSpentOutputs: GqlUnshieldedUtxo[];
}

/** One entry in a contract's public history. `entryPoint` is absent on the deploy. */
export interface ContractAction {
  kind: 'ContractDeploy' | 'ContractCall' | 'ContractUpdate';
  entryPoint?: string;
  txHash: string;
  blockHeight: number;
  blockTimestamp: number;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(NETWORK.indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`indexer GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('indexer returned no data');
  return body.data;
}

/** The native (NIGHT) token type is 32 zero bytes. Matches Compact's `nativeToken()`. */
export const NATIVE_TOKEN_HEX = '00'.repeat(32);

const isNative = (u: { tokenType: string }): boolean =>
  u.tokenType.replace(/^0x/, '').toLowerCase() === NATIVE_TOKEN_HEX;

export function sumNative(utxos: GqlUnshieldedUtxo[]): bigint {
  return utxos.filter(isNative).reduce((acc, u) => acc + BigInt(u.value), 0n);
}

export function sumNativeFor(utxos: GqlUnshieldedUtxo[], owner: string): bigint {
  return sumNative(utxos.filter((u) => u.owner === owner));
}

/**
 * The contract's own unshielded balances as the LEDGER sees them, keyed by token-type hex.
 *
 * `unshieldedBalances` hangs off `ContractAction`, NOT off `Contract` -- `contract(address)`
 * returns a `Contract` whose only fields are address/state/maintenanceAuthority/actions.
 * `contractAction(address)` returns the latest action, which is what carries the running
 * balances, and all three action variants declare the field so it selects on the interface.
 */
export async function contractUnshieldedBalances(address: string): Promise<Record<string, bigint>> {
  const data = await gql<{
    contractAction: { unshieldedBalances: { tokenType: string; amount: string }[] } | null;
  }>(
    `query ($address: HexEncoded!) {
       contractAction(address: $address) { unshieldedBalances { tokenType amount } }
     }`,
    { address },
  );
  const out: Record<string, bigint> = {};
  for (const b of data.contractAction?.unshieldedBalances ?? [])
    out[b.tokenType] = BigInt(b.amount);
  return out;
}

export function nativeBalance(balances: Record<string, bigint>): bigint {
  for (const [k, v] of Object.entries(balances)) {
    if (k.replace(/^0x/, '').toLowerCase() === NATIVE_TOKEN_HEX) return v;
  }
  return 0n;
}

/**
 * One transaction by hash, with its UTXO deltas and its raw bytes.
 *
 * Polls: the indexer trails the node slightly, so a hash returned by `submitTransaction` is not
 * necessarily queryable the same instant.
 */
export async function transactionByHash(
  hash: string,
  { attempts = 40, delayMs = 1000 } = {},
): Promise<GqlTransaction> {
  const q = `query ($hash: HexEncoded!) {
       transactions(offset: { hash: $hash }) {
         hash
         raw
         block { height timestamp }
         unshieldedCreatedOutputs {
           owner tokenType value intentHash outputIndex registeredForDustGeneration
         }
         unshieldedSpentOutputs {
           owner tokenType value intentHash outputIndex registeredForDustGeneration
         }
       }
     }`;
  for (let i = 0; i < attempts; i++) {
    const data = await gql<{ transactions: GqlTransaction[] }>(q, { hash });
    if (data.transactions.length > 0) return data.transactions[0]!;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`transaction ${hash} not indexed after ${attempts} attempts`);
}

/** Byte size of a transaction as the node measured it, from the indexer's `raw` hex. */
export function transactionBytes(tx: GqlTransaction): number {
  const raw = tx.raw.startsWith('0x') ? tx.raw.slice(2) : tx.raw;
  return raw.length / 2;
}

/**
 * The node's dismiss-time allowance for a transaction of `bytes`, in milliseconds.
 *
 * `max(min_time_to_dismiss, time_to_dismiss_per_byte x size)` with ledger-9.1.0.0-rc.3's
 * `INITIAL_LIMITS`: 15.000 ms and 0.002 ms/byte. A transaction is admissible only if this
 * exceeds its dismiss cost, which is ~15.97 ms of fixed cryptographic constants -- hence the
 * ~7,984-byte floor (docs/gate0-report.md).
 */
export const allowanceMs = (bytes: number): number => Math.max(15.0, 0.002 * bytes);

/** The floor a contract call must clear to be admitted at all, in bytes. */
export const ADMISSION_FLOOR_BYTES = 7984;

/**
 * A contract's whole public history, oldest first.
 *
 * This is the ONLY thing `verify.ts` is given beyond the table's address: every join, every
 * turn and the settlement are recovered from these actions and the contract states they point
 * at. The indexer returns them newest-first, so they are reversed here.
 */
export async function contractActions(address: string, limit = 1000): Promise<ContractAction[]> {
  type Row = {
    __typename: ContractAction['kind'];
    entryPoint?: string;
    transaction: { hash: string; block: { height: number; timestamp: string } };
  };
  const data = await gql<{ contract: { actions: Row[] } | null }>(
    `query ($address: HexEncoded!, $limit: Int!) {
       contract(address: $address) {
         actions(limit: $limit) {
           __typename
           ... on ContractCall { entryPoint transaction { hash block { height timestamp } } }
           ... on ContractDeploy { transaction { hash block { height timestamp } } }
           ... on ContractUpdate { transaction { hash block { height timestamp } } }
         }
       }
     }`,
    { address, limit },
  );
  if (!data.contract) throw new Error(`no contract at ${address}`);
  return data.contract.actions
    .map((a) => ({
      kind: a.__typename,
      entryPoint: a.entryPoint,
      txHash: a.transaction.hash,
      blockHeight: a.transaction.block.height,
      blockTimestamp: Number(a.transaction.block.timestamp),
    }))
    .reverse();
}

/** Current chain tip, for sanity-checking that blocks are being produced. */
export async function tip(): Promise<{ height: number; timestamp: number }> {
  const data = await gql<{ block: { height: number; timestamp: string } | null }>(
    `{ block { height timestamp } }`,
  );
  if (!data.block) throw new Error('chain has no tip block');
  return { height: data.block.height, timestamp: Number(data.block.timestamp) };
}

/**
 * The `now` a state-advancing circuit should declare, in seconds since the epoch.
 *
 * Read off the CHAIN's latest block rather than from the local wall clock, and that choice is
 * deliberate. `stampTime` traps the declared value in `(blockTime - 600, blockTime]`
 * (table.compact, decision 5), so `now` must not exceed the block time of the block the
 * transaction lands in. The tip's timestamp is by construction less than or equal to that of
 * any later block, so it always satisfies the upper bound, and the transaction lands a few
 * blocks later -- far inside the 600 s slack. A local clock a second fast would fail
 * `blockTimeGte` instead, with an assertion message about time that says nothing about clocks.
 */
export async function chainNowSecs(): Promise<bigint> {
  const { timestamp } = await tip();
  return BigInt(Math.floor(timestamp / 1000));
}
