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
 *   - `transactions(offset:{hash}){ unshieldedCreatedOutputs / unshieldedSpentOutputs }`
 *                                                     who actually received or spent what, with
 *                                                     `registeredForDustGeneration` per created
 *                                                     UTXO (the designation question)
 *   - `transactions(offset:{hash}){ raw }`            the transaction's byte size, which is what
 *                                                     the `OutsideTimeToDismiss` admission check
 *                                                     measures
 *   - `contractActions(address, offset)` subscription  the table's whole public history, which is
 *                                                     all the chain-only verifier is given
 *   - `contractAction(address, offset:{transactionOffset})` the state one transaction left
 *
 * There is no user-address balance query in this indexer's schema (checked by introspecting
 * `__schema.queryType.fields`: only `bridgeBalance(address)` takes an address, and that is the
 * Cardano bridge, not NIGHT), so per-address totals are derived from the UTXO sets above.
 */

import { NATIVE_TOKEN_HEX } from '@dust-dice/contract';

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

/**
 * The token-type constant and the balance decode live with the contract package, next to the
 * ledger layout they read; re-exported here so callers of this module keep one import.
 */
export { NATIVE_TOKEN_HEX, nativeBalance } from '@dust-dice/contract';

const isNative = (u: { tokenType: string }): boolean =>
  u.tokenType.replace(/^0x/, '').toLowerCase() === NATIVE_TOKEN_HEX;

export function sumNative(utxos: GqlUnshieldedUtxo[]): bigint {
  return utxos.filter(isNative).reduce((acc, u) => acc + BigInt(u.value), 0n);
}

export function sumNativeFor(utxos: GqlUnshieldedUtxo[], owner: string): bigint {
  return sumNative(utxos.filter((u) => u.owner === owner));
}

// What the contract HOLDS is deliberately NOT read here. The schema does offer
// `contractAction { unshieldedBalances }`, and it answers `[]` for every action of every
// contract on this indexer -- tables sitting on a pot included -- so a custody check built on
// it reports a solvent table as empty, which is the shape of a solvency alarm. Custody comes
// from the contract's own state: `contracts.ts`'s `contractUnshieldedBalances`.

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
 * One graphql-transport-ws subscription, collected until `done` accepts a row (that row included)
 * or `max` rows have arrived.
 *
 * A raw WebSocket on purpose: the protocol is four message types -- init, ack, subscribe, next --
 * and a client library would be a second copy of what the SDK already bundles. Node's global
 * WebSocket (22+, this package's floor) is all it needs.
 */
function subscribeUntil<T>(
  query: string,
  variables: Record<string, unknown>,
  field: string,
  done: (row: T) => boolean,
  max: number,
  timeoutMs = 60_000,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(NETWORK.indexerWS, 'graphql-transport-ws');
    const rows: T[] = [];
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(rows);
    };
    const timer = setTimeout(
      () => finish(new Error(`indexer subscription ${field}: still open after ${timeoutMs} ms`)),
      timeoutMs,
    );
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = () => finish(new Error(`indexer subscription ${field}: websocket error`));
    ws.onclose = () =>
      finish(new Error(`indexer subscription ${field}: closed after ${rows.length} rows`));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; payload?: unknown };
      if (m.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
      } else if (m.type === 'next') {
        const p = m.payload as { data?: Record<string, T>; errors?: { message: string }[] };
        if (p.errors?.length) {
          finish(new Error(`indexer GraphQL: ${p.errors.map((e) => e.message).join('; ')}`));
          return;
        }
        const row = p.data?.[field];
        if (row === undefined) return;
        rows.push(row);
        if (done(row) || rows.length >= max) finish();
      } else if (m.type === 'error') {
        finish(
          new Error(`indexer subscription ${field}: ${JSON.stringify(m.payload).slice(0, 300)}`),
        );
      } else if (m.type === 'complete') {
        finish();
      }
    };
  });
}

const sameAddress = (a: string, b: string): boolean =>
  a.replace(/^0x/, '').toLowerCase() === b.replace(/^0x/, '').toLowerCase();

/**
 * A contract's whole public history, oldest first.
 *
 * This is the ONLY thing `verify.ts` is given beyond the table's address: every join, every
 * turn and the settlement are recovered from these actions and the contract states they point
 * at.
 *
 * The indexer this build talks to (4.3.x, the preprod line) has no query that LISTS a contract's
 * actions -- the ledger-9 `contract(address){ actions }` is gone. It has the `contractActions`
 * SUBSCRIPTION, which replays every action from a block offset and then stays open for new ones;
 * it is what midnight-js's own provider uses. The stream has no "caught up" marker of its own,
 * so the latest action is fetched first over plain HTTP and its transaction ends the collection
 * -- after as many rows as that transaction has actions on this contract, because a fast turn is
 * one transaction carrying up to seven calls and stopping at the first would drop the rest. The
 * deploy block comes from the same query (`ContractCall.deploy`), so nothing from before the
 * contract existed is streamed.
 */
export async function contractActions(address: string, limit = 1000): Promise<ContractAction[]> {
  type Row = {
    __typename: ContractAction['kind'];
    entryPoint?: string;
    transaction: { hash: string; block: { height: number; timestamp: string | number } };
  };
  const head = await gql<{
    contractAction: (Row & { deploy?: { transaction: { block: { height: number } } } }) | null;
  }>(
    `query ($address: HexEncoded!) {
       contractAction(address: $address) {
         __typename
         transaction { hash block { height timestamp } }
         ... on ContractCall { deploy { transaction { block { height } } } }
       }
     }`,
    { address },
  );
  if (!head.contractAction) throw new Error(`no contract at ${address}`);
  const latest = head.contractAction;
  const fromHeight = latest.deploy?.transaction.block.height ?? latest.transaction.block.height;

  const lastTx = await gql<{ transactions: { contractActions: { address: string }[] }[] }>(
    `query ($hash: HexEncoded!) {
       transactions(offset: { hash: $hash }) { contractActions { address } }
     }`,
    { hash: latest.transaction.hash },
  );
  const lastTxActions = (lastTx.transactions[0]?.contractActions ?? []).filter((a) =>
    sameAddress(a.address, address),
  ).length;

  let seenOfLast = 0;
  const rows = await subscribeUntil<Row>(
    `subscription ($address: HexEncoded!, $offset: BlockOffset) {
       contractActions(address: $address, offset: $offset) {
         __typename
         ... on ContractCall { entryPoint }
         transaction { hash block { height timestamp } }
       }
     }`,
    { address, offset: { height: fromHeight } },
    'contractActions',
    (row) => row.transaction.hash === latest.transaction.hash && ++seenOfLast >= lastTxActions,
    limit,
  );
  return rows.map((a) => ({
    kind: a.__typename,
    entryPoint: a.entryPoint,
    txHash: a.transaction.hash,
    blockHeight: a.transaction.block.height,
    blockTimestamp: Number(a.transaction.block.timestamp),
  }));
}

/** The state a specific transaction left the contract in, as the indexer's hex; null if none. */
export async function contractStateHexAt(address: string, txHash: string): Promise<string | null> {
  const data = await gql<{ contractAction: { state: string } | null }>(
    `query ($address: HexEncoded!, $hash: HexEncoded!) {
       contractAction(address: $address, offset: { transactionOffset: { hash: $hash } }) { state }
     }`,
    { address, hash: txHash },
  );
  return data.contractAction?.state ?? null;
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
